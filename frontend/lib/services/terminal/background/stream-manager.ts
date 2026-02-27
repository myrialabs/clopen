/**
 * Terminal Stream Manager
 * Manages active terminal streams and their lifecycle
 */

import { terminalSessionManager } from '../session.service';
import { terminalPersistenceManager } from '../persistence.service';
import { terminalStore } from '$frontend/lib/stores/features/terminal.svelte';
import type { TerminalLine } from '$shared/types/terminal';

export interface StreamInfo {
	streamId: string;
	sessionId: string;
	command: string;
	status: 'active' | 'reconnecting' | 'completed' | 'error';
	reconnectAttempts: number;
	maxReconnectAttempts: number;
	outputIndex: number;
}

class StreamManager {
	private streams = new Map<string, StreamInfo>();
	private reconnectTimers = new Map<string, NodeJS.Timeout>();
	private readonly MAX_RECONNECT_ATTEMPTS = 5;
	private readonly RECONNECT_DELAY = 2000; // Start with 2 seconds

	/**
	 * Get stream info for a session
	 */
	getStreamInfo(sessionId: string): StreamInfo | undefined {
		return this.streams.get(sessionId);
	}

	/**
	 * Check if a session has an active stream (PTY process running)
	 */
	hasActiveStream(sessionId: string): boolean {
		const streamInfo = this.streams.get(sessionId);
		return streamInfo?.status === 'active' || streamInfo?.status === 'reconnecting';
	}

	/**
	 * Check if any session has active streams
	 */
	hasAnyActiveStreams(): boolean {
		for (const [_, streamInfo] of this.streams) {
			if (streamInfo.status === 'active' || streamInfo.status === 'reconnecting') {
				return true;
			}
		}
		return false;
	}

	/**
	 * Get active streams count
	 */
	getActiveStreamsCount(): number {
		return this.streams.size;
	}

	/**
	 * Start a new terminal stream
	 */
	startStream(sessionId: string, streamId: string, command: string, projectId?: string): void {
		// Save stream info for persistence with projectId
		terminalPersistenceManager.saveActiveStream(sessionId, streamId, command, projectId);

		// Track stream
		const streamInfo: StreamInfo = {
			streamId,
			sessionId,
			command,
			status: 'active',
			reconnectAttempts: 0,
			maxReconnectAttempts: this.MAX_RECONNECT_ATTEMPTS,
			outputIndex: 0
		};

		this.streams.set(sessionId, streamInfo);
	}

	/**
	 * Update stream status
	 */
	updateStreamStatus(sessionId: string, status: StreamInfo['status']): void {
		const streamInfo = this.streams.get(sessionId);
		if (streamInfo) {
			streamInfo.status = status;
		}
	}

	/**
	 * Update output index
	 */
	updateOutputIndex(sessionId: string, index: number): void {
		const streamInfo = this.streams.get(sessionId);
		if (streamInfo) {
			streamInfo.outputIndex = index;
		}
	}

	/**
	 * Increment output index
	 */
	incrementOutputIndex(sessionId: string): void {
		const streamInfo = this.streams.get(sessionId);
		if (streamInfo) {
			streamInfo.outputIndex++;
		}
	}

	/**
	 * Update reconnect attempts
	 */
	updateReconnectAttempts(sessionId: string, attempts: number): void {
		const streamInfo = this.streams.get(sessionId);
		if (streamInfo) {
			streamInfo.reconnectAttempts = attempts;
		}
	}

	/**
	 * Set reconnect timer
	 */
	setReconnectTimer(sessionId: string, timer: NodeJS.Timeout): void {
		// Clear existing timer if any
		this.clearReconnectTimer(sessionId);
		this.reconnectTimers.set(sessionId, timer);
	}

	/**
	 * Clear reconnect timer
	 */
	clearReconnectTimer(sessionId: string): void {
		const timer = this.reconnectTimers.get(sessionId);
		if (timer) {
			clearTimeout(timer);
			this.reconnectTimers.delete(sessionId);
		}
	}

	/**
	 * End a terminal stream
	 */
	endStream(sessionId: string, forceClear: boolean = false): void {
		const streamInfo = this.streams.get(sessionId);

		// If forceClear is true (e.g., from cancelCommand), clear localStorage immediately
		if (forceClear && streamInfo) {
			terminalPersistenceManager.clearStreamInfo(sessionId, streamInfo.streamId);
		}
		// Otherwise DON'T clear stream info from localStorage here
		// It will be cleared by terminal-service when command actually completes
		// This allows reconnection after browser refresh

		// Remove from active streams in memory
		this.streams.delete(sessionId);

		// Clear any reconnect timers
		this.clearReconnectTimer(sessionId);
	}

	/**
	 * Handle stream completion
	 */
	handleStreamCompletion(sessionId: string): void {
		const streamInfo = this.streams.get(sessionId);
		if (!streamInfo) return;

		// Clear reconnect timer
		this.clearReconnectTimer(sessionId);

		// Remove stream
		this.streams.delete(sessionId);

		// Clear persistence with streamId
		terminalPersistenceManager.clearStreamInfo(sessionId, streamInfo.streamId);

		// Mark session as not executing
		terminalSessionManager.endExecution(sessionId);
		terminalStore.setExecutingState(sessionId, false);

		// Trigger prompt display
		terminalStore.triggerPromptDisplay(sessionId);
	}

	/**
	 * Handle stream data
	 */
	handleStreamData(sessionId: string, data: any): void {
		const streamInfo = this.streams.get(sessionId);
		if (!streamInfo) return;

		// Update output index
		streamInfo.outputIndex++;

		// Handle different data types
		switch (data.type) {
			case 'output':
			case 'error':
				// Add to terminal display
				const outputLine: TerminalLine = {
					content: data.content || '',
					type: data.type,
					timestamp: new Date()
				};
				terminalStore.addOutput(sessionId, outputLine);

				// Add to session history
				terminalSessionManager.addOutputToHistory(sessionId, data.content || '');

				// Clear the restoration flag on first successful output
				// This ensures we don't show "restored session" message on interrupt
				if (typeof window !== 'undefined' && sessionStorage.getItem('terminal-restored-' + sessionId) === 'true') {
					sessionStorage.removeItem('terminal-restored-' + sessionId);
				}
				break;

			case 'directory':
				// Update working directory
				if (data.newDirectory) {
					terminalSessionManager.updateWorkingDirectory(sessionId, data.newDirectory);
					terminalStore.updateWorkingDirectory(sessionId, data.newDirectory);
				}
				break;

			case 'exit':
			case 'complete':
				// Command completed
				this.handleStreamCompletion(sessionId);
				break;
		}
	}

	/**
	 * Clean up all streams
	 */
	cleanup(): void {
		// Clear all timers
		for (const timer of this.reconnectTimers.values()) {
			clearTimeout(timer);
		}

		// Clear maps
		this.streams.clear();
		this.reconnectTimers.clear();
	}

	/**
	 * Get all streams
	 */
	getAllStreams(): Map<string, StreamInfo> {
		return this.streams;
	}

	/**
	 * Create stream info
	 */
	createStreamInfo(
		streamId: string,
		sessionId: string,
		command: string,
		status: StreamInfo['status'] = 'reconnecting',
		attemptNumber: number = 1
	): StreamInfo {
		return {
			streamId,
			sessionId,
			command,
			status,
			reconnectAttempts: attemptNumber,
			maxReconnectAttempts: this.MAX_RECONNECT_ATTEMPTS,
			outputIndex: 0
		};
	}

	/**
	 * Add or update stream
	 */
	setStream(sessionId: string, streamInfo: StreamInfo): void {
		this.streams.set(sessionId, streamInfo);
	}
}

// Export singleton instance
export const streamManager = new StreamManager();