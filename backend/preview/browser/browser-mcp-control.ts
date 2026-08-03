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

/**
 * Which of a project's locked tabs the agent is working on right now.
 *
 * A session accumulates tabs, and a lock says only "hands off". With several
 * locked at once that leaves the user unable to tell where the agent actually
 * is — they can watch any tab freely, but not know which one to watch.
 * `browserTabId` is null when the project has no focused tab any more.
 */
export interface McpFocusEvent {
	browserTabId: string | null;
	projectId: string;
	chatSessionId?: string;
	timestamp: number;
}

/** Answers "does this chat session still have a stream running?". */
export type SessionLivenessProbe = (chatSessionId: string) => boolean;

export interface McpCursorEvent {
	tabId: string;
	/**
	 * Owning project. Tab ids repeat across projects (`tab-1` exists in every
	 * one), so a cursor broadcast to all of them could be drawn over a
	 * same-numbered tab in a project the agent has never touched.
	 */
	projectId?: string;
	x: number;
	y: number;
	/** Mouse button held down — the difference between a move and a drag. */
	pressed?: boolean;
	timestamp: number;
	source: 'mcp';
}

export interface McpClickEvent {
	tabId: string;
	projectId?: string;
	x: number;
	y: number;
	button?: 'left' | 'right' | 'middle';
	timestamp: number;
	source: 'mcp';
}

/**
 * What the agent is doing on a tab, in the user's words.
 *
 * The pointer alone says "something else is driving this" and nothing more,
 * which is the wrong amount of information for a run that can hold a tab for
 * minutes: a page changing on its own with a nameless cursor on it reads as a
 * glitch. `label` is a two-or-three-word gloss of the action about to run —
 * "Typing", "Clicking", "Navigating" — and rides next to the cursor.
 *
 * `null` means the agent still holds the tab but is between actions.
 */
export interface McpActivityEvent {
	tabId: string;
	projectId?: string;
	label: string | null;
	timestamp: number;
}

export class BrowserMcpControl extends EventEmitter {
	/** Tab → ownership info (which chat session controls it) */
	private tabOwnership = new Map<string, TabOwnershipInfo>();

	/** Chat session → set of tab IDs it controls */
	private sessionTabs = new Map<string, Set<string>>();

	/** Project → the tab its controlling agent is pointed at right now. */
	private focusedTabs = new Map<string, string>();

	/** Tab → what the agent is doing on it, for the cursor's caption. */
	private tabActivity = new Map<string, string>();

	/**
	 * Whether the stream that owns a lock is still running.
	 *
	 * Registered by the chat stream manager. Without it a tool call that lands
	 * after its stream ended — the remote-MCP transports resolve their session
	 * from "most recent active stream", so a late call can name a session that
	 * has already been released — filed a lock under an owner nobody would ever
	 * release, and the tab stayed locked until the server restarted.
	 */
	private livenessProbe: SessionLivenessProbe | null = null;

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
	 * Teach this manager which chat sessions are still streaming.
	 *
	 * Called once by the chat stream manager. Absent, every session reads as
	 * live — the previous behaviour, which is the safe default for anything
	 * that constructs this without a chat layer (tests, tooling).
	 */
	setSessionLivenessProbe(probe: SessionLivenessProbe): void {
		this.livenessProbe = probe;
	}

	/** Whether a chat session is still streaming (true when no probe is set). */
	isSessionLive(chatSessionId: string): boolean {
		return this.livenessProbe ? this.livenessProbe(chatSessionId) : true;
	}

	/**
	 * Release every tab whose owning session has stopped streaming.
	 *
	 * The belt to `releaseSession`'s braces. Release is driven by the stream's
	 * terminal events, so anything that never reaches one — a lock acquired
	 * during the teardown window, an interrupt that took an unusual path —
	 * leaves ownership behind with nothing to collect it. Sweeping is cheap
	 * (the map holds a handful of entries) and makes a stuck lock recover on
	 * the next stream event or tab query instead of at the next restart.
	 */
	releaseOrphans(): number {
		if (!this.livenessProbe) return 0;

		const orphans = [...this.tabOwnership.entries()]
			.filter(([, info]) => !this.isSessionLive(info.chatSessionId))
			.map(([tabId]) => tabId);

		for (const tabId of orphans) {
			debug.warn('mcp', `🧹 Releasing orphaned tab ${tabId} — its chat session is no longer streaming`);
			this.releaseTab(tabId);
		}

		return orphans.length;
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

			// The agent just changed where it is working; the focus marker is
			// what tells the user that, so it moves with the promotion.
			const projectId = this.tabOwnership.get(browserTabId)?.projectId;
			if (projectId) this.focusTab(browserTabId, chatSessionId, projectId);
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
		// A cancelled stream can still have a tool call in flight. Letting it
		// take the lock re-locks a tab that was just handed back, and files the
		// lock under an owner whose release already ran.
		if (!this.isSessionLive(chatSessionId)) {
			debug.warn('mcp', `❌ Session ${chatSessionId.slice(0, 8)} is no longer streaming, refusing control of ${browserTabId}`);
			return false;
		}

		// Check existing ownership
		const existingOwner = this.tabOwnership.get(browserTabId);

		if (existingOwner) {
			// Same session already owns it → idempotent success
			if (existingOwner.chatSessionId === chatSessionId) {
				this.focusTab(browserTabId, chatSessionId, projectId);
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
		this.focusTab(browserTabId, chatSessionId, projectId);

		debug.log('mcp', `🎮 Session ${chatSessionId.slice(0, 8)} acquired tab: ${browserTabId} (total: ${sessionSet.size} tabs)`);
		return true;
	}

	// ============================================================================
	// Focus
	// ============================================================================

	/**
	 * Mark the tab the agent is acting on. Idempotent and quiet when unchanged —
	 * it is called on every action, and only a change is worth telling the UI.
	 */
	focusTab(browserTabId: string, chatSessionId: string, projectId: string): void {
		if (this.focusedTabs.get(projectId) === browserTabId) return;

		this.focusedTabs.set(projectId, browserTabId);
		this.emitFocus(browserTabId, projectId, chatSessionId);
	}

	/** The tab a project's agent is currently pointed at, if any. */
	getFocusedTab(projectId: string): string | null {
		return this.focusedTabs.get(projectId) ?? null;
	}

	/**
	 * Re-derive a project's focus after ownership changed.
	 *
	 * Falls back to another tab the *same* session still holds, so a batch that
	 * closed the tab it was working on lands the marker where the work went
	 * rather than nowhere — and never onto a tab a different session owns,
	 * which would point the user at the wrong agent. Emits nothing when the
	 * focused tab is still held, so releasing several tabs at once produces one
	 * update rather than a burst.
	 */
	private refreshFocus(projectId: string | undefined): void {
		if (!projectId) return;

		const focused = this.focusedTabs.get(projectId);
		if (!focused) return;

		const owner = this.tabOwnership.get(focused);
		if (owner && owner.projectId === projectId) return; // Still held — nothing to say.

		const successor = [...this.tabOwnership.entries()]
			.reverse()
			.find(([, info]) => info.projectId === projectId);

		if (successor) {
			this.focusedTabs.set(projectId, successor[0]);
			this.emitFocus(successor[0], projectId, successor[1].chatSessionId);
			return;
		}

		this.focusedTabs.delete(projectId);
		this.emitFocus(null, projectId);
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

		// Before the control-end, so the caption cannot outlive the cursor it
		// belongs to on a viewer that processes the two in order.
		this.emitActivity(browserTabId, null, ownership.projectId);

		// Emit control end event to frontend
		this.emitControlEnd(browserTabId, ownership.projectId);
		this.refreshFocus(ownership.projectId);

		debug.log('mcp', `🎮 Released tab: ${browserTabId} (was owned by session ${ownership.chatSessionId.slice(0, 8)})`);
	}

	/**
	 * Release all tabs owned by a chat session.
	 * Called when chat stream ends (complete/error/cancel).
	 */
	releaseSession(chatSessionId: string): void {
		const sessionSet = this.sessionTabs.get(chatSessionId);
		this.sessionTabs.delete(chatSessionId);

		const tabIds = Array.from(sessionSet ?? []);
		if (tabIds.length > 0) {
			debug.log('mcp', `🎮 Releasing ${tabIds.length} tabs for session ${chatSessionId.slice(0, 8)}`);

			const projects = new Set<string>();
			for (const tabId of tabIds) {
				const ownership = this.tabOwnership.get(tabId);
				this.tabOwnership.delete(tabId);
				this.emitActivity(tabId, null, ownership?.projectId);
				this.emitControlEnd(tabId, ownership?.projectId);
				if (ownership?.projectId) projects.add(ownership.projectId);
			}

			// After every deletion, so the successor search sees the final state
			// rather than tabs that are about to go too.
			for (const projectId of projects) this.refreshFocus(projectId);

			debug.log('mcp', `🎮 Session ${chatSessionId.slice(0, 8)} fully released`);
		}

		// A tool call that acquired during this session's teardown is filed
		// under an owner that is already gone; nothing else would collect it.
		this.releaseOrphans();
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
			this.emitActivity(tabId, null, info.projectId);
			this.emitControlEnd(tabId, info.projectId);
		}

		for (const projectId of this.focusedTabs.keys()) {
			this.emitFocus(null, projectId);
		}

		this.tabOwnership.clear();
		this.sessionTabs.clear();
		this.focusedTabs.clear();
		this.tabActivity.clear();

		debug.log('mcp', '🧹 Force released all MCP control');
	}

	// ============================================================================
	// Cursor Events
	// ============================================================================

	/**
	 * Emit cursor position event with MCP source
	 */
	emitCursorPosition(tabId: string, x: number, y: number, pressed = false): void {
		const event: McpCursorEvent = {
			tabId,
			projectId: this.tabOwnership.get(tabId)?.projectId,
			x,
			y,
			pressed,
			timestamp: Date.now(),
			source: 'mcp'
		};

		this.emit('cursor-position', event);
	}

	/**
	 * Emit cursor click event with MCP source
	 */
	emitCursorClick(tabId: string, x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): void {
		const event: McpClickEvent = {
			tabId,
			projectId: this.tabOwnership.get(tabId)?.projectId,
			x,
			y,
			button,
			timestamp: Date.now(),
			source: 'mcp'
		};

		this.emit('cursor-click', event);
	}

	/**
	 * Say what the agent is doing on a tab.
	 *
	 * Repeats are dropped: a batch of eight `type` actions would otherwise
	 * relabel the cursor eight times with the same word, and every one of those
	 * is a re-render on every viewer.
	 */
	emitActivity(tabId: string, label: string | null, projectId?: string): void {
		if ((this.tabActivity.get(tabId) ?? null) === label) return;

		if (label === null) this.tabActivity.delete(tabId);
		else this.tabActivity.set(tabId, label);

		const event: McpActivityEvent = {
			tabId,
			// Explicit on release, where ownership has already been dropped and
			// there is nothing left to look the project up in.
			projectId: projectId ?? this.tabOwnership.get(tabId)?.projectId,
			label,
			timestamp: Date.now()
		};

		this.emit('activity', event);
	}

	/** What the agent last said it was doing on a tab, for a late-joining viewer. */
	getActivity(tabId: string): string | null {
		return this.tabActivity.get(tabId) ?? null;
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

	private emitFocus(browserTabId: string | null, projectId: string, chatSessionId?: string): void {
		const event: McpFocusEvent = {
			browserTabId,
			projectId,
			chatSessionId,
			timestamp: Date.now()
		};

		this.emit('control-focus', event);

		debug.log('mcp', `📢 Emitted mcp:control-focus for ${projectId}: ${browserTabId ?? 'none'}`);
	}
}

// Singleton instance
export const browserMcpControl = new BrowserMcpControl();
