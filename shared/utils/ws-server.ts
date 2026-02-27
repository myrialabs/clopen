/**
 * WebSocket Server Core Library - Optimized
 *
 * High-performance WebSocket routing with:
 * - Zero boilerplate configuration
 * - 100% type inference from backend to frontend
 * - Singleton TextEncoder/Decoder for performance
 * - Pre-computed binary action detection
 * - Context management (user/project)
 * - TypeBox schema validation (bundled with Elysia)
 */

import type { Elysia } from 'elysia';
import { t, type TSchema, type Static } from 'elysia';
import { Value } from '@sinclair/typebox/value';
import { debug } from './logger';

// ============================================================================
// Singleton Encoders (Performance Optimization)
// ============================================================================

/** Singleton TextEncoder - reused across all encode operations */
const textEncoder = new TextEncoder();

/** Singleton TextDecoder - reused across all decode operations */
const textDecoder = new TextDecoder();

// ============================================================================
// Pre-computed Binary Actions (Performance Optimization)
// ============================================================================

/** Actions known to contain binary data - skip containsBinary() check */
const BINARY_ACTIONS = new Set<string>([
	'preview:frame',
	'file:upload',
	'file:download',
	'terminal:binary'
]);

/**
 * Register an action as binary (for custom binary handlers)
 */
export function registerBinaryAction(action: string): void {
	BINARY_ACTIONS.add(action);
}

// ============================================================================
// WebSocket Connection Interface
// ============================================================================

/**
 * WebSocket Connection with Context
 * Extends Elysia WebSocket with custom context properties
 */
export interface WSConnection {
	/** WebSocket ready state (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED) */
	readyState: number;
	/** Send message to client */
	send: (data: string | ArrayBufferLike | Blob | ArrayBufferView) => void;
	/** Close connection */
	close: (code?: number, reason?: string) => void;
}

// ============================================================================
// Route Configuration Types
// ============================================================================

/**
 * WebSocket route configuration
 */
interface RouteConfig<TData extends TSchema> {
	/** Incoming data schema (validates client → server) */
	data: TData;
}

/**
 * HTTP-like route configuration for request-response pattern
 */
interface HTTPRouteConfig<
	TData extends TSchema,
	TResponse extends TSchema
> {
	/** Request data schema (optional) */
	data?: TData;
	/** Response data schema (required) */
	response: TResponse;
}

/**
 * HTTP route handler callback
 */
type HTTPHandler<
	TData extends TSchema,
	TResponse extends TSchema
> = (params: {
	conn: WSConnection;
	data: TData extends TSchema ? Static<TData> : never;
}) => Promise<Static<TResponse>> | Static<TResponse>;

/**
 * WebSocket route handler callback
 */
type RouteHandler<TData extends TSchema> = (params: {
	conn: WSConnection;
	data: Static<TData>;
}) => void | Promise<void>;

/**
 * Internal route definition
 */
interface Route {
	action: string;
	dataSchema: TSchema;
	handler: (params: { conn: WSConnection; data: any }) => void | Promise<void>;
}

/**
 * Internal HTTP route definition
 */
interface HTTPRoute {
	action: string;
	dataSchema?: TSchema;
	responseSchema: TSchema;
	handler: (params: { conn: WSConnection; data: any }) => Promise<any> | any;
}

// ============================================================================
// Binary Message Utilities (Optimized)
// ============================================================================

/**
 * Check if payload contains binary data (Uint8Array or ArrayBuffer)
 * Optimized with early return and iterative approach
 */
function containsBinary(obj: any): boolean {
	if (obj instanceof Uint8Array || obj instanceof ArrayBuffer) return true;
	if (typeof obj !== 'object' || obj === null) return false;

	// Use stack-based iteration instead of recursion for deep objects
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

	// Calculate total length
	const totalLength = 1 + actionBytes.length + 4 + metaBytes.length + binaryData.length;
	const buffer = new ArrayBuffer(totalLength);
	const view = new DataView(buffer);
	const uint8 = new Uint8Array(buffer);

	let offset = 0;

	// Action length (1 byte, max 255 characters)
	view.setUint8(offset, actionBytes.length);
	offset += 1;

	// Action string
	uint8.set(actionBytes, offset);
	offset += actionBytes.length;

	// Metadata length (4 bytes, big-endian)
	view.setUint32(offset, metaBytes.length);
	offset += 4;

	// Metadata JSON
	uint8.set(metaBytes, offset);
	offset += metaBytes.length;

	// Binary data (rest of buffer)
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
// WebSocket Router
// ============================================================================

/**
 * WebSocket Router with Builder Pattern
 *
 * Includes built-in context management for user/project tracking.
 */
export class WSRouter<
	TClient extends Record<string, any> = {},
	TServer extends Record<string, any> = {}
> {
	private routes = new Map<string, Route>();
	private httpRoutes = new Map<string, HTTPRoute>();
	private eventSchemas = new Map<string, TSchema>();

	constructor() {
		// Register built-in context management route
		this.registerContextHandler();
	}

	/**
	 * Register built-in ws:set-context handler
	 * Allows frontend to sync user/project context
	 */
	private registerContextHandler(): void {
		this.httpRoutes.set('ws:set-context', {
			action: 'ws:set-context',
			dataSchema: t.Object({
				userId: t.Optional(t.Union([t.String(), t.Null()])),
				projectId: t.Optional(t.Union([t.String(), t.Null()]))
			}),
			responseSchema: t.Object({
				userId: t.Union([t.String(), t.Null()]),
				projectId: t.Union([t.String(), t.Null()])
			}),
			handler: async ({ conn, data }) => {
				// Import ws server to update context
				const { ws: wsServer } = await import('$backend/lib/utils/ws');

				if (data.userId !== undefined) {
					wsServer.setUser(conn, data.userId);
				}
				if (data.projectId !== undefined) {
					wsServer.setProject(conn, data.projectId);
				}

				// Read back from connectionState (single source of truth)
				const state = wsServer.getConnectionState(conn);
				return {
					userId: state?.userId ?? null,
					projectId: state?.projectId ?? null
				};
			}
		});
	}

	/**
	 * Register a WebSocket route handler
	 *
	 * @param action - Action name (e.g., 'terminal:init', 'chat:send')
	 * @param config - Route configuration with data schema
	 * @param handler - Handler callback receiving { conn, data }
	 */
	on<TAction extends string, TData extends TSchema>(
		action: TAction,
		config: RouteConfig<TData>,
		handler: RouteHandler<TData>
	): WSRouter<TClient & { [K in TAction]: Static<TData> }, TServer> {
		// Validate action format
		if (!action || typeof action !== 'string') {
			throw new Error(`Invalid action name: ${action}`);
		}

		// Check for duplicate routes
		if (this.routes.has(action)) {
			throw new Error(`Route already exists: ${action}`);
		}

		// Store route definition
		this.routes.set(action, {
			action,
			dataSchema: config.data,
			handler: handler as any
		});

		return this as any;
	}

	/**
	 * Register an HTTP-like route handler for request-response pattern
	 *
	 * This method provides a simplified API for request-response interactions,
	 * automatically wrapping responses in { success, data?, error? } format.
	 *
	 * The handler should:
	 * - Return data directly (will be wrapped as { success: true, data })
	 * - Throw errors (will be wrapped as { success: false, error: message })
	 *
	 * Response schema should ONLY define the data structure, not the wrapper.
	 */
	http<
		TAction extends string,
		TData extends TSchema = never,
		TResponse extends TSchema = any
	>(
		action: TAction,
		config: HTTPRouteConfig<TData, TResponse>,
		handler: HTTPHandler<TData, TResponse>
	): WSRouter<
		TClient & {
			[K in TAction]: {
				data: TData extends TSchema ? Static<TData> : undefined;
			};
		},
		TServer & {
			[K in `${TAction}:response`]: {
				success: boolean;
				data?: Static<TResponse>;
				error?: string;
			};
		}
	> {
		// Validate action format
		if (!action || typeof action !== 'string') {
			throw new Error(`Invalid action name: ${action}`);
		}

		// Check for duplicate routes
		if (this.httpRoutes.has(action)) {
			throw new Error(`HTTP route already exists: ${action}`);
		}

		// Store HTTP route definition
		this.httpRoutes.set(action, {
			action,
			dataSchema: config.data,
			responseSchema: config.response,
			handler: handler as any
		});

		return this as any;
	}

	/**
	 * Register SERVER → CLIENT event schema (independent)
	 *
	 * Declares event schemas that server can emit to clients.
	 * Events are independent from actions and can be emitted from anywhere using ws.emit()
	 */
	emit<TEvent extends string, TEventSchema extends TSchema>(
		event: TEvent,
		schema: TEventSchema
	): WSRouter<
		TClient,
		TServer & { [K in TEvent]: Static<TEventSchema> }
	> {
		// Validate event format
		if (!event || typeof event !== 'string') {
			throw new Error(`Invalid event name: ${event}`);
		}

		// Check for duplicate event schemas
		if (this.eventSchemas.has(event)) {
			throw new Error(`Event schema already exists: ${event}`);
		}

		// Store event schema for type inference
		this.eventSchemas.set(event, schema);

		return this as any;
	}

	/**
	 * Merge another router into this one
	 */
	merge<TC extends Record<string, any>, TS extends Record<string, any>>(
		router: WSRouter<TC, TS>
	): WSRouter<TClient & TC, TServer & TS> {
		// Copy all routes from the other router
		for (const [action, route] of router.routes.entries()) {
			if (this.routes.has(action)) {
				throw new Error(`Route conflict during merge: ${action}`);
			}
			this.routes.set(action, route);
		}

		// Copy all HTTP routes from the other router (except built-in)
		for (const [action, route] of router.httpRoutes.entries()) {
			if (action === 'ws:set-context') continue; // Skip built-in
			if (this.httpRoutes.has(action)) {
				throw new Error(`HTTP route conflict during merge: ${action}`);
			}
			this.httpRoutes.set(action, route);
		}

		// Copy all event schemas from the other router
		for (const [event, schema] of router.eventSchemas.entries()) {
			if (this.eventSchemas.has(event)) {
				throw new Error(`Event schema conflict during merge: ${event}`);
			}
			this.eventSchemas.set(event, schema);
		}

		return this as any;
	}

	/**
	 * Handle HTTP-like request-response message
	 * @internal
	 */
	private async handleHTTPMessage(conn: any, action: string, payload: any, route: HTTPRoute) {
		const responseAction = `${action}:response`;
		// Extract requestId from payload to match request with response
		const requestId = payload?.requestId;

		try {
			// Extract data from payload
			const data = payload?.data || {};

			// Validate request data schema (if exists)
			let validatedData = {};
			if (route.dataSchema) {
				try {
					// Check for binary BEFORE validation
					const hasBinary = containsBinary(data);
					validatedData = Value.Decode(route.dataSchema, data);

					// Restore binary data if it was converted
					if (hasBinary && data.data instanceof Uint8Array) {
						(validatedData as any).data = data.data;
					}
				} catch (err) {
					throw new Error(
						`Request validation failed: ${err instanceof Error ? err.message : 'Unknown error'}`
					);
				}
			}

			// Execute handler (can throw)
			const result = await route.handler({
				conn: conn,
				data: validatedData
			});

			// Validate response data schema
			let validatedResponse;
			try {
				validatedResponse = Value.Decode(route.responseSchema, result);
			} catch (err) {
				debug.error('websocket', `Response validation failed for ${action}:`, err);
				throw new Error(
					`Response validation failed: ${err instanceof Error ? err.message : 'Unknown error'}`
				);
			}

			// Check if response contains binary data
			if (isBinaryAction(responseAction, validatedResponse)) {
				// For binary responses, wrap in success envelope with requestId
				const wrappedResponse = { success: true, data: validatedResponse, requestId };
				const binaryMessage = encodeBinaryMessage(responseAction, wrappedResponse);
				conn.send(Buffer.from(binaryMessage));
				debug.log('websocket', 'HTTP success (binary):', action);
			} else {
				// For JSON responses, wrap in success envelope with requestId
				const wrappedResponse = { success: true, data: validatedResponse, requestId };
				conn.send(JSON.stringify({ action: responseAction, payload: wrappedResponse }));
				debug.log('websocket', 'HTTP success (JSON):', action);
			}
		} catch (err) {
			// Catch ANY error and send wrapped in { success: false, error, requestId }
			const errorMessage = err instanceof Error ? err.message : String(err);

			const errorResponse = { success: false, error: errorMessage, requestId };
			conn.send(JSON.stringify({ action: responseAction, payload: errorResponse }));
			debug.error('websocket', `HTTP error [${action}]:`, errorMessage);
		}
	}

	/**
	 * Handle incoming WebSocket message (JSON or Binary)
	 * @internal
	 */
	private async handleMessage(conn: any, message: any) {
		try {
			let action: string;
			let payload: any;

			// Check if message is binary (ArrayBuffer or Buffer)
			if (message instanceof ArrayBuffer) {
				// Decode binary message
				const decoded = decodeBinaryMessage(message);
				action = decoded.action;
				payload = decoded.payload;
			} else if (Buffer.isBuffer(message)) {
				// Node.js Buffer - convert to ArrayBuffer
				const arrayBuffer = new ArrayBuffer(message.byteLength);
				new Uint8Array(arrayBuffer).set(message);
				const decoded = decodeBinaryMessage(arrayBuffer);
				action = decoded.action;
				payload = decoded.payload;
			} else {
				// Parse JSON message
				const parsed = typeof message === 'string' ? JSON.parse(message) : message;
				action = parsed.action;
				payload = parsed.payload;
			}

			if (!action || typeof action !== 'string') {
				debug.error('websocket', 'Invalid message format');
				return;
			}

			// Check if this is an HTTP route
			const httpRoute = this.httpRoutes.get(action);
			if (httpRoute) {
				await this.handleHTTPMessage(conn, action, payload, httpRoute);
				return;
			}

			// Find regular WebSocket route
			const route = this.routes.get(action);
			if (!route) {
				debug.warn('websocket', `Unknown action: ${action}`);
				return;
			}

			// Validate payload against schema
			try {
				// Use TypeBox Value.Decode (bundled with Elysia)
				const validatedData = Value.Decode(route.dataSchema, payload);

				// Execute handler
				await route.handler({ conn: conn, data: validatedData });
			} catch (err) {
				debug.error('websocket', `Data validation failed for ${action}:`, err);
			}
		} catch (err) {
			debug.error('websocket', 'Message handling error:', err);
		}
	}

	/**
	 * Convert router to Elysia plugin
	 */
	asPlugin(path: string = '/ws') {
		return (app: Elysia) => {
			return app.ws(path, {
				message: (conn, message) => {
					this.handleMessage(conn, message);
				},
				open: async (conn) => {
					debug.log('websocket', 'Client connected');

					// Register connection with ws singleton
					try {
						const { ws: wsServer } = await import('$backend/lib/utils/ws');
						wsServer.register(conn);
					} catch (err) {
						debug.error('websocket', 'Failed to register connection:', err);
					}
				},
				close: async (conn) => {
					debug.log('websocket', 'Client disconnected');

					// Unregister connection from ws singleton
					// All registered cleanups are called automatically by unregister()
					try {
						const { ws: wsServer } = await import('$backend/lib/utils/ws');
						wsServer.unregister(conn);
					} catch (err) {
						debug.error('websocket', 'Failed to unregister connection:', err);
					}
				}
			});
		};
	}

	/**
	 * Phantom getter for type inference
	 */
	get $api(): { client: TClient; server: TServer } {
		throw new Error('$api is a phantom getter for type inference only');
	}
}

/**
 * Create a new WebSocket router
 */
export function createRouter(): WSRouter {
	return new WSRouter();
}

// Export binary utilities for advanced use cases
export { encodeBinaryMessage, decodeBinaryMessage, containsBinary, isBinaryAction };
