/**
 * Browser MCP Control
 *
 * Manages exclusive MCP control over browser tabs.
 * Ensures only one MCP can control the browser at a time.
 * Emits events for frontend to show visual indicators.
 * Also handles MCP tab request/response coordination.
 *
 * ARCHITECTURE: Event-based control management
 * - Control is maintained as long as the browser tab exists
 * - Auto-release when tab is destroyed via 'preview:browser-tab-destroyed' event
 * - NO timeouts or polling - 100% real-time event-driven
 * - Listens directly to preview service events for tab lifecycle
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

export interface McpControlState {
	isControlling: boolean;
	mcpSessionId: string | null;
	browserTabId: string | null;
	startedAt: number | null;
	lastActionAt: number | null;
}

export interface McpControlEvent {
	type: 'mcp:control-start' | 'mcp:control-end';
	browserTabId: string;
	mcpSessionId?: string;
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
	private controlState: McpControlState = {
		isControlling: false,
		mcpSessionId: null,
		browserTabId: null,
		startedAt: null,
		lastActionAt: null
	};

	// Auto-release configuration
	private readonly IDLE_TIMEOUT_MS = 30000; // 30 seconds idle = auto release
	private idleCheckInterval: NodeJS.Timeout | null = null;

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
	 * Auto-release control if the destroyed tab was being controlled
	 */
	private handleTabDestroyed(tabId: string): void {
		if (this.controlState.isControlling && this.controlState.browserTabId === tabId) {
			debug.warn('mcp', `⚠️ Controlled tab ${tabId} was destroyed - auto-releasing control`);
			this.releaseControl();
		}
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

	/**
	 * Check if MCP is currently controlling a browser session
	 */
	isControlling(): boolean {
		return this.controlState.isControlling;
	}

	/**
	 * Get current control state
	 */
	getControlState(): McpControlState {
		return { ...this.controlState };
	}

	/**
	 * Check if a specific browser tab is being controlled
	 */
	isTabControlled(browserTabId: string): boolean {
		return this.controlState.isControlling &&
			   this.controlState.browserTabId === browserTabId;
	}

	/**
	 * Acquire control of a browser tab
	 * Returns true if control was acquired, false if already controlled by another MCP
	 */
	acquireControl(browserTabId: string, mcpSessionId?: string): boolean {
		// Validate tab exists before acquiring control
		if (this.previewService && !this.previewService.getTab(browserTabId)) {
			debug.warn('mcp', `❌ Cannot acquire control: tab ${browserTabId} does not exist`);
			return false;
		}

		// If already controlling the same tab, just update timestamp
		if (this.controlState.isControlling &&
			this.controlState.browserTabId === browserTabId) {
			this.controlState.lastActionAt = Date.now();
			return true;
		}

		// If another tab is being controlled, deny
		if (this.controlState.isControlling) {
			debug.warn('mcp', `MCP control denied: another tab (${this.controlState.browserTabId}) is already being controlled`);
			return false;
		}

		// Acquire control
		const now = Date.now();
		this.controlState = {
			isControlling: true,
			mcpSessionId: mcpSessionId || null,
			browserTabId,
			startedAt: now,
			lastActionAt: now
		};

		// Emit control start event to frontend
		this.emitControlStart(browserTabId, mcpSessionId);

		// Start idle check interval
		this.startIdleCheck();

		debug.log('mcp', `🎮 MCP acquired control of tab: ${browserTabId} (event-based tracking)`);
		return true;
	}

	/**
	 * Release control of a browser tab
	 */
	releaseControl(browserTabId?: string): void {
		// If browserTabId provided, only release if it matches
		if (browserTabId && this.controlState.browserTabId !== browserTabId) {
			return;
		}

		if (!this.controlState.isControlling) {
			return;
		}

		const releasedTabId = this.controlState.browserTabId;

		// Reset state
		this.controlState = {
			isControlling: false,
			mcpSessionId: null,
			browserTabId: null,
			startedAt: null,
			lastActionAt: null
		};

		// Stop idle check interval
		this.stopIdleCheck();

		// Emit control end event to frontend
		if (releasedTabId) {
			this.emitControlEnd(releasedTabId);
		}

		debug.log('mcp', `🎮 MCP released control of tab: ${releasedTabId}`);
	}

	/**
	 * Update last action timestamp (for tracking purposes only)
	 * NOTE: This does NOT affect control lifecycle - control is maintained
	 * as long as the session exists, regardless of action timestamps
	 */
	updateLastAction(): void {
		if (this.controlState.isControlling) {
			this.controlState.lastActionAt = Date.now();
		}
	}

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

	/**
	 * Emit control start event to frontend
	 */
	private emitControlStart(browserTabId: string, mcpSessionId?: string): void {
		const event: McpControlEvent = {
			type: 'mcp:control-start',
			browserTabId,
			mcpSessionId,
			timestamp: Date.now()
		};

		this.emit('control-start', event);

		debug.log('mcp', `📢 Emitted mcp:control-start for tab: ${browserTabId}`);
	}

	/**
	 * Emit control end event to frontend
	 */
	private emitControlEnd(browserTabId: string): void {
		const event: McpControlEvent = {
			type: 'mcp:control-end',
			browserTabId,
			timestamp: Date.now()
		};

		this.emit('control-end', event);

		debug.log('mcp', `📢 Emitted mcp:control-end for tab: ${browserTabId}`);
	}

	/**
	 * Start idle check interval
	 */
	private startIdleCheck(): void {
		// Clear any existing interval
		this.stopIdleCheck();

		// Check every 10 seconds
		this.idleCheckInterval = setInterval(() => {
			this.checkAndReleaseIfIdle();
		}, 10000);

		debug.log('mcp', '⏰ Started idle check interval (30s timeout)');
	}

	/**
	 * Stop idle check interval
	 */
	private stopIdleCheck(): void {
		if (this.idleCheckInterval) {
			clearInterval(this.idleCheckInterval);
			this.idleCheckInterval = null;
			debug.log('mcp', '⏰ Stopped idle check interval');
		}
	}

	/**
	 * Check if MCP control is idle and auto-release if timeout
	 */
	private checkAndReleaseIfIdle(): void {
		if (!this.controlState.isControlling) {
			return;
		}

		const now = Date.now();
		const idleTime = now - (this.controlState.lastActionAt || this.controlState.startedAt || now);

		if (idleTime >= this.IDLE_TIMEOUT_MS) {
			debug.log('mcp', `⏰ MCP control idle for ${Math.round(idleTime / 1000)}s, auto-releasing...`);
			this.releaseControl();
		}
	}

	/**
	 * Auto-release control for a specific browser tab (called when tab closes)
	 */
	autoReleaseForTab(browserTabId: string): void {
		if (this.controlState.isControlling && this.controlState.browserTabId === browserTabId) {
			debug.log('mcp', `🗑️ Auto-releasing MCP control for closed tab: ${browserTabId}`);
			this.releaseControl(browserTabId);
		}
	}

	/**
	 * Force release all control (for cleanup)
	 */
	forceReleaseAll(): void {
		this.stopIdleCheck();

		if (this.controlState.isControlling && this.controlState.browserTabId) {
			this.emitControlEnd(this.controlState.browserTabId);
		}

		this.controlState = {
			isControlling: false,
			mcpSessionId: null,
			browserTabId: null,
			startedAt: null,
			lastActionAt: null
		};

		debug.log('mcp', '🧹 Force released all MCP control');
	}
}

// Singleton instance
export const browserMcpControl = new BrowserMcpControl();
