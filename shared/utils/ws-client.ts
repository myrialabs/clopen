/**
 * WebSocket Client Core Library - Optimized
 *
 * High-performance WebSocket client with:
 * - 100% type inference from backend API
 * - Singleton TextEncoder/Decoder for performance
 * - Automatic context sync (user/project)
 * - Automatic reconnection with exponential backoff
 * - Binary message support for efficient data transfer
 */

import { debug } from './logger';

// ============================================================================
// Singleton Encoders (Performance Optimization)
// ============================================================================

/** Singleton TextEncoder - reused across all encode operations */
const textEncoder = new TextEncoder();

/** Singleton TextDecoder - reused across all decode operations */
const textDecoder = new TextDecoder();

// ============================================================================
// Pre-computed Binary Actions
// ============================================================================

/** Actions known to contain binary data - skip containsBinary() check */
const BINARY_ACTIONS = new Set<string>([
	'preview:frame',
	'file:upload',
	'file:download',
	'terminal:binary'
]);

// ============================================================================
// Client Options
// ============================================================================

/**
 * WebSocket client options
 */
export interface WSClientOptions {
	/** Auto-reconnect on connection loss */
	autoReconnect?: boolean;
	/** Maximum reconnection attempts (0 = infinite) */
	maxReconnectAttempts?: number;
	/** Initial reconnect delay in ms */
	reconnectDelay?: number;
	/** Maximum reconnect delay in ms */
	maxReconnectDelay?: number;
}

// ============================================================================
// Binary Message Utilities (Optimized)
// ============================================================================

/**
 * Check if payload contains binary data
 * Optimized with early return and iterative approach
 */
function containsBinary(obj: any): boolean {
	if (obj instanceof Uint8Array || obj instanceof ArrayBuffer) return true;
	if (typeof obj !== 'object' || obj === null) return false;

	const stack = [obj];
	while (stack.length > 0) {
		const current = stack.pop();
		for (const value of Object.values(current)) {
			if (value instanceof Uint8Array || value instanceof ArrayBuffer) return true;
			if (typeof value === 'object' && value !== null) {
				stack.push(value);
			}
		}
	}
	return false;
}

/**
 * Fast check using pre-computed binary actions
 */
function isBinaryAction(action: string, payload: any): boolean {
	if (BINARY_ACTIONS.has(action)) return true;
	return containsBinary(payload);
}

/**
 * Extract binary field and metadata from payload
 */
function extractBinaryFields(payload: any): { binaryData: Uint8Array; metadata: Record<string, any> } {
	const metadata: Record<string, any> = {};
	let binaryData: Uint8Array = new Uint8Array(0);

	for (const [key, value] of Object.entries(payload)) {
		if (value instanceof Uint8Array) {
			binaryData = value;
		} else if (value instanceof ArrayBuffer) {
			binaryData = new Uint8Array(value);
		} else {
			metadata[key] = value;
		}
	}

	return { binaryData, metadata };
}

/**
 * Encode a binary message with action and metadata
 *
 * Binary Message Format:
 * ┌─────────────────┬────────────────┬─────────────────┬──────────────┬─────────────┐
 * │ Action Length   │ Action String  │ Metadata Length │ Metadata JSON│ Binary Data │
 * │ (1 byte)        │ (N bytes)      │ (4 bytes)       │ (M bytes)    │ (rest)      │
 * └─────────────────┴────────────────┴─────────────────┴──────────────┴─────────────┘
 */
function encodeBinaryMessage(action: string, payload: any): ArrayBuffer {
	const { binaryData, metadata } = extractBinaryFields(payload);

	const actionBytes = textEncoder.encode(action);
	const metaBytes = textEncoder.encode(JSON.stringify(metadata));

	const totalLength = 1 + actionBytes.length + 4 + metaBytes.length + binaryData.length;
	const buffer = new ArrayBuffer(totalLength);
	const view = new DataView(buffer);
	const uint8 = new Uint8Array(buffer);

	let offset = 0;

	// Action length (1 byte)
	view.setUint8(offset, actionBytes.length);
	offset += 1;

	// Action string
	uint8.set(actionBytes, offset);
	offset += actionBytes.length;

	// Metadata length (4 bytes)
	view.setUint32(offset, metaBytes.length);
	offset += 4;

	// Metadata JSON
	uint8.set(metaBytes, offset);
	offset += metaBytes.length;

	// Binary data
	uint8.set(binaryData, offset);

	return buffer;
}

/**
 * Decode a binary message back to action and payload
 */
function decodeBinaryMessage(buffer: ArrayBuffer): { action: string; payload: any } {
	const view = new DataView(buffer);
	const uint8 = new Uint8Array(buffer);

	let offset = 0;

	// Read action length (1 byte)
	const actionLength = view.getUint8(offset);
	offset += 1;

	// Read action string
	const actionBytes = uint8.slice(offset, offset + actionLength);
	const action = textDecoder.decode(actionBytes);
	offset += actionLength;

	// Read metadata length (4 bytes)
	const metaLength = view.getUint32(offset);
	offset += 4;

	// Read metadata JSON
	const metaBytes = uint8.slice(offset, offset + metaLength);
	const metadata = JSON.parse(textDecoder.decode(metaBytes));
	offset += metaLength;

	// Read binary data (rest of buffer)
	const binaryData = uint8.slice(offset);

	// Reconstruct payload with binary data
	const payload = {
		...metadata,
		data: binaryData // Binary field always named 'data'
	};

	return { action, payload };
}

// ============================================================================
// WebSocket Client
// ============================================================================

/**
 * Type-safe WebSocket Client with Binary Support and Context Sync
 */
export class WSClient<TAPI extends { client: any; server: any }> {
	private ws: WebSocket | null = null;
	private url: string;
	private options: Required<WSClientOptions>;
	private reconnectAttempts = 0;
	private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
	private listeners = new Map<string, Set<(payload: any) => void>>();
	private messageQueue: Array<{ action: string; payload: any }> = [];
	private isConnected = false;
	private shouldReconnect = true;

	/** Current context (synced with server) */
	private context: {
		userId: string | null;
		projectId: string | null;
	} = {
		userId: null,
		projectId: null
	};

	/** Pending context sync (for reconnection) */
	private pendingContextSync = false;

	/** Resolvers waiting for connection to be fully ready */
	private connectResolvers: Array<() => void> = [];

	constructor(url: string, options: WSClientOptions = {}) {
		this.url = url;
		this.options = {
			autoReconnect: options.autoReconnect ?? true,
			maxReconnectAttempts: options.maxReconnectAttempts ?? 5,
			reconnectDelay: options.reconnectDelay ?? 1000,
			maxReconnectDelay: options.maxReconnectDelay ?? 30000
		};

		this.connect();
	}

	/**
	 * Establish WebSocket connection
	 */
	private connect(): void {
		try {
			// CRITICAL: Close any existing connection before creating a new one
			// This prevents zombie connections from accumulating on the server
			// (e.g., during reconnection or HMR, old connections may linger)
			if (this.ws) {
				try {
					this.ws.onclose = null; // Prevent triggering reconnect from this close
					this.ws.onerror = null;
					this.ws.onmessage = null;
					this.ws.close();
				} catch {
					// Ignore close errors on stale socket
				}
				this.ws = null;
			}

			debug.log('websocket', 'Connecting to', this.url);
			this.ws = new WebSocket(this.url);

			// IMPORTANT: Enable binary message handling
			this.ws.binaryType = 'arraybuffer';

			this.ws.onopen = async () => {
				debug.log('websocket', 'Connected');
				this.isConnected = true;
				this.reconnectAttempts = 0;

				// Sync context on reconnection - MUST await before flushing queue
				if (this.context.userId || this.context.projectId) {
					try {
						await this.syncContext();
						debug.log('websocket', 'Context synced after reconnection');
					} catch (err) {
						debug.error('websocket', 'Failed to sync context on reconnection:', err);
					}
				}

				// Flush queued messages AFTER context is synced
				while (this.messageQueue.length > 0) {
					const msg = this.messageQueue.shift();
					if (msg) {
						this.sendRaw(msg.action, msg.payload);
					}
				}

				// Resolve waitUntilConnected() callers AFTER context sync + queue flush
				for (const resolve of this.connectResolvers) {
					resolve();
				}
				this.connectResolvers = [];
			};

			this.ws.onmessage = (event) => {
				try {
					if (event.data instanceof ArrayBuffer) {
						// Binary message
						debug.log('websocket', `Received ArrayBuffer: ${event.data.byteLength} bytes`);
						this.handleBinaryMessage(event.data);
					} else if (event.data instanceof Blob) {
						// Blob message - convert to ArrayBuffer
						debug.log('websocket', `Received Blob: ${event.data.size} bytes, converting to ArrayBuffer`);
						event.data.arrayBuffer().then((buffer) => {
							this.handleBinaryMessage(buffer);
						});
					} else {
						// JSON message
						this.handleTextMessage(event.data);
					}
				} catch (err) {
					debug.error('websocket', 'Message handling error:', err);
				}
			};

			this.ws.onerror = (error) => {
				debug.error('websocket', 'WebSocket error:', error);
			};

			this.ws.onclose = () => {
				debug.log('websocket', 'Disconnected');
				this.isConnected = false;
				this.ws = null;

				// Auto-reconnect
				if (this.shouldReconnect && this.options.autoReconnect) {
					this.scheduleReconnect();
				}
			};
		} catch (err) {
			debug.error('websocket', 'Connection error:', err);
			if (this.shouldReconnect && this.options.autoReconnect) {
				this.scheduleReconnect();
			}
		}
	}

	/**
	 * Handle text/JSON message from server
	 */
	private handleTextMessage(data: string): void {
		// Check if data looks like binary (not valid JSON start)
		if (data && data.length > 0 && data[0] !== '{' && data[0] !== '[') {
			debug.warn('websocket', `Received non-JSON text data (length: ${data.length}), first char code: ${data.charCodeAt(0)}`);
			return;
		}

		const parsed = JSON.parse(data);
		const { action, payload } = parsed;

		if (!action) {
			debug.log('websocket', 'Invalid message format:', parsed);
			return;
		}

		this.dispatchToListeners(action, payload);
	}

	/**
	 * Handle binary message from server
	 */
	private handleBinaryMessage(buffer: ArrayBuffer): void {
		const { action, payload } = decodeBinaryMessage(buffer);

		if (!action) {
			debug.log('websocket', 'Invalid binary message format');
			return;
		}

		debug.log('websocket', 'Received binary:', action, `(${buffer.byteLength} bytes)`);
		this.dispatchToListeners(action, payload);
	}

	/**
	 * Dispatch message to registered listeners
	 */
	private dispatchToListeners(action: string, payload: any): void {
		const callbacks = this.listeners.get(action);
		if (callbacks) {
			callbacks.forEach((cb) => {
				try {
					cb(payload);
				} catch (err) {
					debug.error('websocket', `Listener error for ${action}:`, err);
				}
			});
		}
	}

	/**
	 * Schedule reconnection with exponential backoff
	 */
	private scheduleReconnect(): void {
		if (this.options.maxReconnectAttempts > 0 && this.reconnectAttempts >= this.options.maxReconnectAttempts) {
			debug.error('websocket', 'Max reconnect attempts reached');
			return;
		}

		this.reconnectAttempts++;
		const delay = Math.min(
			this.options.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
			this.options.maxReconnectDelay
		);

		debug.log('websocket', `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

		this.reconnectTimeout = setTimeout(() => {
			this.connect();
		}, delay);
	}

	/**
	 * Emit message to server (type-safe)
	 * Automatically detects binary data and sends as binary message
	 */
	emit<TEvent extends keyof TAPI['client']>(
		action: TEvent,
		payload: TAPI['client'][TEvent]
	): void {
		if (this.isConnected && this.ws) {
			this.sendRaw(action as string, payload);
		} else {
			// Queue message for sending when connected
			debug.log('websocket', 'Queueing message (not connected):', action);
			this.messageQueue.push({ action: action as string, payload });
		}
	}

	/**
	 * Send raw message (JSON or Binary based on payload content)
	 */
	private sendRaw(action: string, payload: any): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			debug.log('websocket', 'Cannot send, socket not ready:', action);
			return;
		}

		try {
			if (isBinaryAction(action, payload)) {
				// Send as binary message
				const binaryMessage = encodeBinaryMessage(action, payload);
				this.ws.send(binaryMessage);
				debug.log('websocket', 'Sent binary:', action, `(${binaryMessage.byteLength} bytes)`);
			} else {
				// Send as JSON message
				this.ws.send(JSON.stringify({ action, payload }));
				debug.log('websocket', 'Sent JSON:', action);
			}
		} catch (err) {
			debug.error('websocket', 'Send error:', err);
		}
	}

	/**
	 * Listen for server messages (type-safe)
	 */
	on<TEvent extends keyof TAPI['server']>(
		action: TEvent,
		callback: (payload: TAPI['server'][TEvent]) => void
	): () => void {
		const actionStr = action as string;

		if (!this.listeners.has(actionStr)) {
			this.listeners.set(actionStr, new Set());
		}

		this.listeners.get(actionStr)!.add(callback);
		debug.log('websocket', 'Listener added:', actionStr);

		// Return unsubscribe function
		return () => {
			const callbacks = this.listeners.get(actionStr);
			if (callbacks) {
				callbacks.delete(callback);
				if (callbacks.size === 0) {
					this.listeners.delete(actionStr);
				}
				debug.log('websocket', 'Listener removed:', actionStr);
			}
		};
	}

	/**
	 * Remove all listeners for an action
	 */
	off<TEvent extends keyof TAPI['server']>(action: TEvent): void {
		const actionStr = action as string;
		this.listeners.delete(actionStr);
		debug.log('websocket', 'All listeners removed:', actionStr);
	}

	/**
	 * Disconnect and cleanup
	 */
	disconnect(): void {
		this.shouldReconnect = false;

		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}

		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}

		this.listeners.clear();
		this.messageQueue = [];
		this.isConnected = false;

		debug.log('websocket', 'Disconnected and cleaned up');
	}

	/**
	 * Check if connected
	 */
	connected(): boolean {
		return this.isConnected;
	}

	/**
	 * Wait until WebSocket is fully connected and ready (context synced, queue flushed).
	 * Resolves immediately if already connected.
	 */
	waitUntilConnected(timeout = 10000): Promise<void> {
		if (this.isConnected) return Promise.resolve();

		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = this.connectResolvers.indexOf(doResolve);
				if (idx >= 0) this.connectResolvers.splice(idx, 1);
				reject(new Error(`WebSocket connection timeout (${timeout}ms)`));
			}, timeout);

			const doResolve = () => {
				clearTimeout(timer);
				resolve();
			};

			this.connectResolvers.push(doResolve);
		});
	}

	/**
	 * Manual reconnect
	 */
	reconnect(): void {
		this.disconnect();
		this.shouldReconnect = true;
		this.reconnectAttempts = 0;
		this.connect();
	}

	// =========================================================================
	// Context Management
	// =========================================================================

	/** Promise for ongoing context sync */
	private contextSyncPromise: Promise<void> | null = null;

	/**
	 * Set user context (auto-syncs with server)
	 * @returns Promise that resolves when context is synced with server
	 */
	async setUser(userId: string | null): Promise<void> {
		if (this.context.userId === userId) return;

		this.context.userId = userId;
		debug.log('websocket', 'Context: user set to', userId);

		if (this.isConnected) {
			await this.syncContext();
		}
	}

	/**
	 * Set project context (auto-syncs with server)
	 * @returns Promise that resolves when context is synced with server
	 */
	async setProject(projectId: string | null): Promise<void> {
		if (this.context.projectId === projectId) return;

		this.context.projectId = projectId;
		debug.log('websocket', 'Context: project set to', projectId);

		if (this.isConnected) {
			await this.syncContext();
		}
	}

	/**
	 * Get current context
	 */
	getContext(): { userId: string | null; projectId: string | null } {
		return { ...this.context };
	}

	/**
	 * Wait for any pending context sync to complete
	 */
	async waitForContextSync(): Promise<void> {
		if (this.contextSyncPromise) {
			await this.contextSyncPromise;
		}
	}

	/**
	 * Sync context with server (awaitable)
	 * Waits for server confirmation before resolving
	 */
	private async syncContext(): Promise<void> {
		// If there's already a pending sync, wait for it
		if (this.contextSyncPromise) {
			await this.contextSyncPromise;
		}

		// Create a new sync promise
		this.contextSyncPromise = this.doSyncContext();

		try {
			await this.contextSyncPromise;
		} finally {
			this.contextSyncPromise = null;
		}
	}

	/**
	 * Actually perform the context sync
	 */
	private async doSyncContext(): Promise<void> {
		const requestId = `context-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

		return new Promise<void>((resolve, reject) => {
			let unsubResponse: (() => void) | null = null;
			let timeoutId: ReturnType<typeof setTimeout> | null = null;

			const cleanup = () => {
				unsubResponse?.();
				if (timeoutId) {
					clearTimeout(timeoutId);
					timeoutId = null;
				}
			};

			// Response handler
			const handleResponse = (response: any) => {
				if (response?.requestId !== requestId) return;

				cleanup();

				if (response.success) {
					debug.log('websocket', 'Context sync confirmed by server:', response.data);
					resolve();
				} else {
					debug.error('websocket', 'Context sync failed:', response.error);
					reject(new Error(response.error || 'Context sync failed'));
				}
			};

			// Timeout handler (2 seconds — localhost round-trip should be near-instant)
			timeoutId = setTimeout(() => {
				cleanup();
				debug.warn('websocket', 'Context sync timeout, assuming success');
				// Don't reject on timeout - just warn and continue
				resolve();
			}, 2000);

			// Register response listener
			unsubResponse = this.on('ws:set-context:response' as any, handleResponse);

			// Send context sync request
			this.emit('ws:set-context' as any, {
				requestId,
				data: {
					userId: this.context.userId,
					projectId: this.context.projectId
				}
			} as any);

			debug.log('websocket', 'Context sync sent:', this.context);
		});
	}

	// =========================================================================
	// HTTP-like Request-Response Pattern
	// =========================================================================

	/**
	 * HTTP-like request-response pattern over WebSocket
	 *
	 * This method provides a simplified API for request-response pattern.
	 * The server always returns `{ success, data?, error? }` response.
	 * This method unwraps the response:
	 * - If `success: true` → returns `data` directly
	 * - If `success: false` → throws Error with `error` message
	 * - Timeout → throws Error
	 */
	http<TAction extends keyof TAPI['client']>(
		action: TAction,
		data?: TAPI['client'][TAction] extends { data: infer D } ? D : never,
		timeout: number = 30000
	): Promise<
		TAPI['server'][`${TAction & string}:response`] extends { success: boolean; data?: infer TData }
			? TData
			: any
	> {
		const responseAction = `${action as string}:response` as any;
		// Generate unique request ID to match request with response
		const requestId = `${action as string}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

		return new Promise((resolve, reject) => {
			let unsubResponse: (() => void) | null = null;
			let timeoutId: ReturnType<typeof setTimeout> | null = null;

			// Cleanup function
			const cleanup = () => {
				unsubResponse?.();
				if (timeoutId) {
					clearTimeout(timeoutId);
					timeoutId = null;
				}
			};

			// Response handler - unwrap { success, data, error } response
			const handleResponse = (response: any) => {
				// Only handle response that matches this request ID
				if (response && response.requestId !== requestId) {
					return; // Ignore responses for other requests
				}

				cleanup();

				// Check if response has success field
				if (response && typeof response === 'object' && 'success' in response) {
					if (response.success) {
						// Success: return data directly (unwrapped)
						resolve(response.data);
					} else {
						// Failure: throw error with message from response.error
						reject(new Error(response.error || 'Unknown error'));
					}
				} else {
					// Legacy response format or unexpected structure
					resolve(response);
				}
			};

			// Timeout handler
			if (timeout > 0) {
				timeoutId = setTimeout(() => {
					cleanup();
					reject(new Error(`Request timeout: ${action as string} (${timeout}ms)`));
				}, timeout);
			}

			// Register response listener
			unsubResponse = this.on(responseAction, handleResponse);

			// Send request with data structure and requestId
			const payload = {
				requestId,
				data: data || {}
			};

			this.emit(action as any, payload as any);
		});
	}
}

// Export binary utilities for advanced use cases
export { encodeBinaryMessage, decodeBinaryMessage, containsBinary, isBinaryAction };
