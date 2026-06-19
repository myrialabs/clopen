/**
 * Project Context Service
 *
 * Stores mapping between chat sessions and projectId to provide
 * project context to MCP tool handlers.
 *
 * This is needed because MCP tools are executed within a chat session context,
 * but the Claude Agent SDK doesn't provide a way to pass custom context
 * to tool handlers.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { debug } from '$shared/utils/logger';

// Execution context for MCP tool handlers
interface ExecutionContext {
	chatSessionId?: string;
	projectId?: string;
	streamId?: string;
}

// AsyncLocalStorage for execution context
const executionContext = new AsyncLocalStorage<ExecutionContext>();

class ProjectContextService {
	// Map chat session ID to project ID
	private sessionProjectMap = new Map<string, string>();

	// Map stream ID to project ID (for additional tracking)
	private streamProjectMap = new Map<string, string>();

	// Track active streams (streamId -> context)
	private activeStreams = new Map<string, { chatSessionId: string; projectId: string; startedAt: number }>();

	// Track the most recently active stream (for MCP tool execution context)
	private mostRecentActiveStream: { streamId: string; chatSessionId: string; projectId: string } | null = null;

	// Track the most recently used projectId (as a last resort fallback)
	private lastUsedProjectId: string | null = null;

	/**
	 * Per-stream AbortSignal map. The stream-manager registers each stream's
	 * AbortController.signal here when the stream starts so MCP tool handlers
	 * can fast-fail on cancellation. The remote-MCP HTTP transport (used by
	 * OpenCode/Codex/Copilot/Qwen) does not preserve the engine's
	 * AsyncLocalStorage context across the HTTP boundary — `mostRecentActiveStream`
	 * is the practical fallback for resolving "which stream is asking right now".
	 */
	private streamSignals = new Map<string, AbortSignal>();

	/**
	 * Register a chat session with its project ID
	 * Should be called when a chat stream starts
	 */
	registerSession(chatSessionId: string, projectId: string): void {
		if (!chatSessionId || !projectId) {
			debug.warn('mcp', `⚠️ Cannot register session: chatSessionId='${chatSessionId}' projectId='${projectId}'`);
			return;
		}

		this.sessionProjectMap.set(chatSessionId, projectId);
		this.lastUsedProjectId = projectId;

		debug.log('mcp', `📌 Registered session: ${chatSessionId} -> project: ${projectId}`);
		debug.log('mcp', `📊 Total sessions registered: ${this.sessionProjectMap.size}`);
	}

	/**
	 * Register a stream ID with its project ID
	 * Should be called when a chat stream starts
	 */
	registerStream(streamId: string, projectId: string, chatSessionId?: string): void {
		if (!streamId || !projectId) {
			debug.warn('mcp', `⚠️ Cannot register stream: streamId='${streamId}' projectId='${projectId}'`);
			return;
		}

		this.streamProjectMap.set(streamId, projectId);

		// Track as active stream
		if (chatSessionId) {
			this.activeStreams.set(streamId, {
				chatSessionId,
				projectId,
				startedAt: Date.now()
			});

			// Update most recent active stream
			this.mostRecentActiveStream = { streamId, chatSessionId, projectId };

			debug.log('mcp', `📌 Registered stream: ${streamId.slice(0, 8)} -> project: ${projectId} (session: ${chatSessionId.slice(0, 8)})`);
			debug.log('mcp', `🎯 Most recent active stream set to: ${projectId}`);
		} else {
			debug.log('mcp', `📌 Registered stream: ${streamId.slice(0, 8)} -> project: ${projectId} (no session)`);
		}

		debug.log('mcp', `📊 Total active streams: ${this.activeStreams.size}`);
	}

	/**
	 * Get project ID for a chat session
	 */
	getProjectIdForSession(chatSessionId: string): string | null {
		return this.sessionProjectMap.get(chatSessionId) || null;
	}

	/**
	 * Get project ID for a stream
	 */
	getProjectIdForStream(streamId: string): string | null {
		return this.streamProjectMap.get(streamId) || null;
	}

	/**
	 * Unregister a session (cleanup)
	 */
	unregisterSession(chatSessionId: string): void {
		this.sessionProjectMap.delete(chatSessionId);
		debug.log('mcp', `🗑️ Unregistered session ${chatSessionId}`);
	}

	/**
	 * Register an AbortSignal for a stream. MCP tool handlers can read this
	 * via `getCurrentSignal()` to short-circuit when the engine is cancelled
	 * — without it, in-flight browser-automation calls keep running for a
	 * second or two after the user interrupts the chat (visible as the
	 * "preview keeps moving by itself" symptom).
	 */
	registerStreamSignal(streamId: string, signal: AbortSignal): void {
		if (!streamId) return;
		this.streamSignals.set(streamId, signal);
	}

	/**
	 * Resolve the AbortSignal that belongs to the currently-executing MCP
	 * tool invocation. Tries (in order):
	 *   1. AsyncLocalStorage context's `streamId` (Claude in-process path).
	 *   2. AsyncLocalStorage context's `chatSessionId` mapped to its stream.
	 *   3. The most recent active stream (fallback for the remote HTTP MCP
	 *      path — OpenCode/Codex/Copilot/Qwen — where context doesn't carry).
	 *
	 * Returns `undefined` when no stream is in-flight; handlers should treat
	 * absence as "not abortable" rather than as "aborted".
	 */
	getCurrentSignal(): AbortSignal | undefined {
		const context = this.getCurrentContext();
		if (context?.streamId) {
			const signal = this.streamSignals.get(context.streamId);
			if (signal) return signal;
		}
		if (context?.chatSessionId) {
			for (const [streamId, info] of this.activeStreams) {
				if (info.chatSessionId === context.chatSessionId) {
					const signal = this.streamSignals.get(streamId);
					if (signal) return signal;
				}
			}
		}
		if (this.mostRecentActiveStream) {
			return this.streamSignals.get(this.mostRecentActiveStream.streamId);
		}
		return undefined;
	}

	/**
	 * Unregister a stream (cleanup)
	 */
	unregisterStream(streamId: string): void {
		this.streamProjectMap.delete(streamId);
		this.activeStreams.delete(streamId);
		this.streamSignals.delete(streamId);

		// Clear most recent if it was this stream
		if (this.mostRecentActiveStream?.streamId === streamId) {
			// Find another active stream to use as most recent
			const remaining = Array.from(this.activeStreams.entries());
			if (remaining.length > 0) {
				// Get the most recently started stream
				const [latestStreamId, latestContext] = remaining.sort((a, b) => b[1].startedAt - a[1].startedAt)[0];
				this.mostRecentActiveStream = {
					streamId: latestStreamId,
					chatSessionId: latestContext.chatSessionId,
					projectId: latestContext.projectId
				};
			} else {
				this.mostRecentActiveStream = null;
			}
		}
	}

	/**
	 * Get the last used project ID (fallback)
	 * This is used as a last resort when no session context is available
	 */
	getLastUsedProjectId(): string | null {
		return this.lastUsedProjectId;
	}

	/**
	 * Get all registered sessions (for debugging)
	 */
	getAllSessions(): Array<{ sessionId: string; projectId: string }> {
		return Array.from(this.sessionProjectMap.entries()).map(([sessionId, projectId]) => ({
			sessionId,
			projectId
		}));
	}

	/**
	 * Remove all session/stream mappings for a project (e.g. when the project
	 * row is deleted and no users remain).
	 */
	clearByProjectId(projectId: string): void {
		for (const [sessionId, pid] of [...this.sessionProjectMap.entries()]) {
			if (pid === projectId) {
				this.sessionProjectMap.delete(sessionId);
			}
		}

		const streamIds = new Set<string>();
		for (const [streamId, pid] of this.streamProjectMap.entries()) {
			if (pid === projectId) {
				streamIds.add(streamId);
			}
		}
		for (const [streamId, info] of this.activeStreams.entries()) {
			if (info.projectId === projectId) {
				streamIds.add(streamId);
			}
		}
		for (const streamId of streamIds) {
			this.unregisterStream(streamId);
		}

		if (this.lastUsedProjectId === projectId) {
			this.lastUsedProjectId = null;
		}

		debug.log('mcp', `Cleared MCP project context for project ${projectId}`);
	}

	/**
	 * Clear all mappings (for testing or cleanup)
	 */
	clear(): void {
		this.sessionProjectMap.clear();
		this.streamProjectMap.clear();
		this.activeStreams.clear();
		this.streamSignals.clear();
		this.mostRecentActiveStream = null;
		this.lastUsedProjectId = null;
		debug.log('mcp', '🧹 Cleared all project context mappings');
	}

	/**
	 * Get current execution context (from AsyncLocalStorage)
	 */
	getCurrentContext(): ExecutionContext | undefined {
		return executionContext.getStore();
	}

	/**
	 * Run callback with execution context
	 * This should be called by stream manager when starting MCP tool execution
	 */
	runWithContext<T>(context: ExecutionContext, callback: () => T): T {
		return executionContext.run(context, callback);
	}

	/**
	 * Run async callback with execution context
	 */
	async runWithContextAsync<T>(context: ExecutionContext, callback: () => Promise<T>): Promise<T> {
		return executionContext.run(context, callback);
	}

	/**
	 * Get chat session ID from current execution context
	 * Used by MCP browser automation to track which chat session is controlling tabs
	 */
	getCurrentChatSessionId(): string | null {
		const context = this.getCurrentContext();

		// 1. From AsyncLocalStorage execution context (highest priority)
		if (context?.chatSessionId) {
			return context.chatSessionId;
		}

		// 2. Fallback to most recent active stream
		if (this.mostRecentActiveStream) {
			return this.mostRecentActiveStream.chatSessionId;
		}

		return null;
	}

	/**
	 * Get project ID from current execution context
	 * This is the primary method MCP handlers should use
	 */
	getCurrentProjectId(): string | null {
		const context = this.getCurrentContext();

		// 1. Try to get from execution context (highest priority)
		if (context?.projectId) {
			debug.log('mcp', `📍 Project ID from execution context: ${context.projectId}`);
			return context.projectId;
		}

		// 2. Try to get from session mapping
		if (context?.chatSessionId) {
			const projectId = this.getProjectIdForSession(context.chatSessionId);
			if (projectId) {
				debug.log('mcp', `📍 Project ID from session mapping: ${projectId}`);
				return projectId;
			}
		}

		// 3. Try to get from stream mapping
		if (context?.streamId) {
			const projectId = this.getProjectIdForStream(context.streamId);
			if (projectId) {
				debug.log('mcp', `📍 Project ID from stream mapping: ${projectId}`);
				return projectId;
			}
		}

		// 4. Try to get from most recent active stream
		if (this.mostRecentActiveStream) {
			debug.log('mcp', `📍 Project ID from most recent active stream: ${this.mostRecentActiveStream.projectId}`);
			return this.mostRecentActiveStream.projectId;
		}

		// 5. Fallback to last used project ID
		const fallback = this.getLastUsedProjectId();
		if (fallback) {
			debug.log('mcp', `📍 Project ID from fallback: ${fallback}`);
		} else {
			debug.warn('mcp', '⚠️ No project ID available in any context!');
		}
		return fallback;
	}
}

// Singleton instance
export const projectContextService = new ProjectContextService();
