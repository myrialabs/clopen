/**
 * Browser MCP Control
 *
 * Manages MCP control over browser tabs with multi-tab, session-scoped ownership.
 * Each chat session can control multiple tabs simultaneously.
 * A tab can only be controlled by one chat session at a time.
 * All tabs are released when the chat session ends (stream complete/error/cancel).
 *
 * ARCHITECTURE:
 * - Control lifecycle follows chat sessions (no idle timeout)
 * - Multiple tabs can be locked by one chat session (accumulated via switch/open)
 * - Tab destroyed → auto-release that single tab from its owning session
 * - Stream ends → releaseSession() releases all tabs owned by that session
 * - Emits per-tab control-start/control-end events for frontend UI
 */

import { EventEmitter } from 'events';
import { debug } from '$shared/utils/logger';
import type { BrowserPreviewService } from './browser-preview-service';

// Pending tab request types
interface PendingTabRequest<T = any> {
	resolve: (value: T) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
}

/** Ownership info for a single tab */
interface TabOwnershipInfo {
	chatSessionId: string;
	projectId: string;
	acquiredAt: number;
}

export interface McpControlEvent {
	type: 'mcp:control-start' | 'mcp:control-end';
	browserTabId: string;
	chatSessionId?: string;
	/** Owning project — lets the forwarder target only that project's room. */
	projectId?: string;
	timestamp: number;
}

export interface McpCursorEvent {
	tabId: string;
	x: number;
	y: number;
	timestamp: number;
	source: 'mcp';
}

export interface McpClickEvent {
	tabId: string;
	x: number;
	y: number;
	timestamp: number;
	source: 'mcp';
}

export class BrowserMcpControl extends EventEmitter {
	/** Tab → ownership info (which chat session controls it) */
	private tabOwnership = new Map<string, TabOwnershipInfo>();

	/** Chat session → set of tab IDs it controls */
	private sessionTabs = new Map<string, Set<string>>();

	// Pending tab requests (keyed by request type + timestamp)
	private pendingTabRequests = new Map<string, PendingTabRequest>();
	private requestCounter = 0;

	// Reference to preview service for tab validation
	private previewService: BrowserPreviewService | null = null;

	constructor() {
		super();
	}

	/**
	 * Initialize with preview service reference
	 * This enables automatic control release when tabs are destroyed
	 */
	initialize(previewService: BrowserPreviewService): void {
		this.previewService = previewService;

		// Listen to tab destruction events
		previewService.on('preview:browser-tab-destroyed', (data: { tabId: string }) => {
			this.handleTabDestroyed(data.tabId);
		});

		debug.log('mcp', '🔗 Browser MCP Control initialized with event-based tab tracking');
	}

	/**
	 * Handle tab destroyed event
	 * Auto-release control for the destroyed tab only
	 */
	private handleTabDestroyed(tabId: string): void {
		const ownership = this.tabOwnership.get(tabId);
		if (!ownership) return;

		// Validate project to prevent cross-project collisions
		const serviceProjectId = this.previewService?.getProjectId();
		if (serviceProjectId && ownership.projectId !== serviceProjectId) return;

		debug.warn('mcp', `⚠️ Controlled tab ${tabId} was destroyed - auto-releasing from session ${ownership.chatSessionId}`);
		this.releaseTab(tabId);
	}

	/**
	 * Create a pending request for tab operations
	 * Returns request ID and promise
	 */
	createTabRequest<T>(type: string, timeoutMs: number = 10000): { requestId: string; promise: Promise<T> } {
		const requestId = `${type}-${++this.requestCounter}-${Date.now()}`;

		const promise = new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingTabRequests.delete(requestId);
				reject(new Error(`Tab request '${type}' timed out`));
			}, timeoutMs);

			this.pendingTabRequests.set(requestId, { resolve, reject, timeout });
		});

		return { requestId, promise };
	}

	/**
	 * Resolve a pending tab request
	 */
	resolveTabRequest<T>(requestId: string, data: T): boolean {
		const pending = this.pendingTabRequests.get(requestId);
		if (pending) {
			clearTimeout(pending.timeout);
			this.pendingTabRequests.delete(requestId);
			pending.resolve(data);
			return true;
		}
		return false;
	}

	/**
	 * Reject a pending tab request
	 */
	rejectTabRequest(requestId: string, error: string): boolean {
		const pending = this.pendingTabRequests.get(requestId);
		if (pending) {
			clearTimeout(pending.timeout);
			this.pendingTabRequests.delete(requestId);
			pending.reject(new Error(error));
			return true;
		}
		return false;
	}

	// ============================================================================
	// Control State Queries
	// ============================================================================

	/**
	 * Check if any tab is being controlled
	 */
	isControlling(): boolean {
		return this.tabOwnership.size > 0;
	}

	/**
	 * Check if a specific tab is being controlled (by any session)
	 */
	isTabControlled(browserTabId: string, projectId?: string): boolean {
		const ownership = this.tabOwnership.get(browserTabId);
		if (!ownership) return false;
		if (projectId && ownership.projectId !== projectId) return false;
		return true;
	}

	/**
	 * Check if a tab is controlled by a specific chat session
	 */
	isTabControlledBySession(browserTabId: string, chatSessionId: string): boolean {
		const ownership = this.tabOwnership.get(browserTabId);
		return ownership?.chatSessionId === chatSessionId;
	}

	/**
	 * Get the chat session ID that controls a specific tab
	 */
	getTabOwner(browserTabId: string): string | null {
		return this.tabOwnership.get(browserTabId)?.chatSessionId || null;
	}

	/**
	 * Get all tab IDs controlled by a specific chat session
	 */
	getSessionTabs(chatSessionId: string): string[] {
		const tabs = this.sessionTabs.get(chatSessionId);
		return tabs ? Array.from(tabs) : [];
	}

	/**
	 * Get all controlled tab IDs (across all sessions)
	 */
	getAllControlledTabs(): Map<string, TabOwnershipInfo> {
		return new Map(this.tabOwnership);
	}

	// ============================================================================
	// Control Acquisition
	// ============================================================================

	/**
	 * Promote a tab to the end of the session's controlled set.
	 * This ensures getSessionTabs()[last] returns the most recently activated tab,
	 * which is used by getActiveTabSession to determine which tab MCP operates on.
	 *
	 * Must be called after switch_tab to reflect the new active tab.
	 */
	promoteSessionTab(browserTabId: string, chatSessionId: string): void {
		const sessionSet = this.sessionTabs.get(chatSessionId);
		if (sessionSet && sessionSet.has(browserTabId)) {
			sessionSet.delete(browserTabId);
			sessionSet.add(browserTabId);
			debug.log('mcp', `🔀 Promoted tab ${browserTabId} to end of session ${chatSessionId.slice(0, 8)} set`);
		}
	}

	/**
	 * Acquire control of a browser tab for a chat session.
	 *
	 * - If the tab is already owned by the same session → success (idempotent)
	 * - If the tab is owned by another session → denied
	 * - If the tab is free → acquire and add to session's controlled set
	 */
	acquireControl(browserTabId: string, chatSessionId: string, projectId: string): boolean {
		// Check existing ownership
		const existingOwner = this.tabOwnership.get(browserTabId);

		if (existingOwner) {
			// Same session already owns it → idempotent success
			if (existingOwner.chatSessionId === chatSessionId) {
				return true;
			}
			// Different session owns it → denied
			debug.warn('mcp', `❌ Tab ${browserTabId} is controlled by session ${existingOwner.chatSessionId}, denied for ${chatSessionId}`);
			return false;
		}

		// Acquire control
		const now = Date.now();
		this.tabOwnership.set(browserTabId, {
			chatSessionId,
			projectId,
			acquiredAt: now
		});

		// Add to session's tab set
		let sessionSet = this.sessionTabs.get(chatSessionId);
		if (!sessionSet) {
			sessionSet = new Set();
			this.sessionTabs.set(chatSessionId, sessionSet);
		}
		sessionSet.add(browserTabId);

		// Emit control start event to frontend
		this.emitControlStart(browserTabId, chatSessionId, projectId);

		debug.log('mcp', `🎮 Session ${chatSessionId.slice(0, 8)} acquired tab: ${browserTabId} (total: ${sessionSet.size} tabs)`);
		return true;
	}

	// ============================================================================
	// Control Release
	// ============================================================================

	/**
	 * Release a single tab from its owning session.
	 * Used when a tab is closed via close_tab or destroyed.
	 */
	releaseTab(browserTabId: string): void {
		const ownership = this.tabOwnership.get(browserTabId);
		if (!ownership) return;

		// Remove from tab ownership
		this.tabOwnership.delete(browserTabId);

		// Remove from session's tab set
		const sessionSet = this.sessionTabs.get(ownership.chatSessionId);
		if (sessionSet) {
			sessionSet.delete(browserTabId);
			if (sessionSet.size === 0) {
				this.sessionTabs.delete(ownership.chatSessionId);
			}
		}

		// Emit control end event to frontend
		this.emitControlEnd(browserTabId, ownership.projectId);

		debug.log('mcp', `🎮 Released tab: ${browserTabId} (was owned by session ${ownership.chatSessionId.slice(0, 8)})`);
	}

	/**
	 * Release all tabs owned by a chat session.
	 * Called when chat stream ends (complete/error/cancel).
	 */
	releaseSession(chatSessionId: string): void {
		const sessionSet = this.sessionTabs.get(chatSessionId);
		if (!sessionSet || sessionSet.size === 0) {
			this.sessionTabs.delete(chatSessionId);
			return;
		}

		const tabIds = Array.from(sessionSet);
		debug.log('mcp', `🎮 Releasing ${tabIds.length} tabs for session ${chatSessionId.slice(0, 8)}`);

		for (const tabId of tabIds) {
			const ownership = this.tabOwnership.get(tabId);
			this.tabOwnership.delete(tabId);
			this.emitControlEnd(tabId, ownership?.projectId);
		}

		this.sessionTabs.delete(chatSessionId);

		debug.log('mcp', `🎮 Session ${chatSessionId.slice(0, 8)} fully released`);
	}

	/**
	 * Auto-release control for a specific tab when it's closed.
	 * projectId is used to prevent accidental release across projects.
	 */
	autoReleaseForTab(browserTabId: string, projectId?: string): void {
		const ownership = this.tabOwnership.get(browserTabId);
		if (!ownership) return;
		if (projectId && ownership.projectId !== projectId) return;
		debug.log('mcp', `🗑️ Auto-releasing tab: ${browserTabId} (closed)`);
		this.releaseTab(browserTabId);
	}

	/**
	 * Force release all control (for cleanup)
	 */
	forceReleaseAll(): void {
		// Emit control-end for all controlled tabs
		for (const [tabId, info] of this.tabOwnership) {
			this.emitControlEnd(tabId, info.projectId);
		}

		this.tabOwnership.clear();
		this.sessionTabs.clear();

		debug.log('mcp', '🧹 Force released all MCP control');
	}

	// ============================================================================
	// Cursor Events
	// ============================================================================

	/**
	 * Emit cursor position event with MCP source
	 */
	emitCursorPosition(tabId: string, x: number, y: number): void {
		const event: McpCursorEvent = {
			tabId,
			x,
			y,
			timestamp: Date.now(),
			source: 'mcp'
		};

		this.emit('cursor-position', event);
	}

	/**
	 * Emit cursor click event with MCP source
	 */
	emitCursorClick(tabId: string, x: number, y: number): void {
		const event: McpClickEvent = {
			tabId,
			x,
			y,
			timestamp: Date.now(),
			source: 'mcp'
		};

		this.emit('cursor-click', event);
	}

	/**
	 * Emit test completed event (hide virtual cursor)
	 */
	emitTestCompleted(tabId: string): void {
		this.emit('test-completed', {
			tabId,
			timestamp: Date.now(),
			source: 'mcp'
		});
	}

	// ============================================================================
	// Private Event Emitters
	// ============================================================================

	private emitControlStart(browserTabId: string, chatSessionId?: string, projectId?: string): void {
		const event: McpControlEvent = {
			type: 'mcp:control-start',
			browserTabId,
			chatSessionId,
			projectId,
			timestamp: Date.now()
		};

		this.emit('control-start', event);

		debug.log('mcp', `📢 Emitted mcp:control-start for tab: ${browserTabId}`);
	}

	private emitControlEnd(browserTabId: string, projectId?: string): void {
		const event: McpControlEvent = {
			type: 'mcp:control-end',
			browserTabId,
			projectId,
			timestamp: Date.now()
		};

		this.emit('control-end', event);

		debug.log('mcp', `📢 Emitted mcp:control-end for tab: ${browserTabId}`);
	}
}

// Singleton instance
export const browserMcpControl = new BrowserMcpControl();
