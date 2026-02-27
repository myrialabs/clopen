/**
 * Backend WebSocket Server Singleton - Optimized
 *
 * High-performance WebSocket event emitter with:
 * - Room-based architecture for O(1) project/user lookup
 * - Stable connection identity via WeakMap on raw Bun ServerWebSocket
 * - External state storage (not on ephemeral Elysia wrapper objects)
 * - Backpressure handling to prevent OOM
 * - Connection health monitoring
 * - Clean emit API: ws.emit.project(), ws.emit.user(), ws.emit.global()
 *
 * CRITICAL: Elysia creates NEW ElysiaWS wrapper objects per handler call.
 * We use `(ws as any).raw` (the underlying persistent Bun ServerWebSocket)
 * as a stable identity key via WeakMap, and store all connection state
 * in external Maps (connectionState). No properties are set on the wrapper.
 *
 * Usage:
 * ```ts
 * import { ws } from '$backend/lib/ws'
 *
 * // Project-specific event
 * ws.emit.project(projectId, 'terminal:output', { content });
 *
 * // User-specific event
 * ws.emit.user(userId, 'chat:error', { error });
 *
 * // System-wide event
 * ws.emit.global('system:update', { version });
 * ```
 */

import type { WSAPI } from '$backend/ws';
import type { WSConnection } from '$shared/utils/ws-server';
import { encodeBinaryMessage, isBinaryAction } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';

/**
 * Performance configuration
 */
const CONFIG = {
	/** Maximum send buffer before dropping frames (bytes) */
	MAX_BUFFER_SIZE: 1024 * 1024, // 1MB
	/** Enable backpressure handling */
	ENABLE_BACKPRESSURE: true,
	/** Log dropped frames */
	LOG_DROPPED_FRAMES: true
};

/**
 * Metrics for monitoring
 */
interface WSMetrics {
	totalConnections: number;
	activeProjects: number;
	activeUsers: number;
	droppedFrames: number;
	totalEmits: number;
}

/**
 * External connection state (stored separately from ephemeral ws wrappers)
 */
interface ConnectionState {
	userId: string | null;
	projectId: string | null;
	/** Chat session IDs this connection is subscribed to */
	chatSessionIds: Set<string>;
	/** Cleanup functions called automatically on unregister (connection close) */
	cleanups: Set<() => void>;
}

/**
 * High-Performance WebSocket Server Manager
 *
 * Uses WeakMap<rawSocket, wsId> for stable identity across Elysia wrapper instances,
 * and external Maps for all connection state (userId, projectId).
 */
class WSServer {
	/** All connections by ID */
	private connections = new Map<string, WSConnection>();

	/** Raw Bun ServerWebSocket → wsId for stable identity across wrapper instances */
	private rawToId = new WeakMap<object, string>();

	/** External connection state (userId, projectId) keyed by wsId */
	private connectionState = new Map<string, ConnectionState>();

	/** Room-based: Project ID → Map<wsId, WSConnection> */
	private projectRooms = new Map<string, Map<string, WSConnection>>();

	/** Room-based: User ID → Map<wsId, WSConnection> */
	private userConnections = new Map<string, Map<string, WSConnection>>();

	/** Room-based: Chat Session ID → Map<wsId, WSConnection> */
	private chatSessionRooms = new Map<string, Map<string, WSConnection>>();

	/** Project membership: Project ID → Set<userId> (persists across project switches) */
	private projectMembers = new Map<string, Set<string>>();

	/** Metrics tracking */
	private metrics: WSMetrics = {
		totalConnections: 0,
		activeProjects: 0,
		activeUsers: 0,
		droppedFrames: 0,
		totalEmits: 0
	};

	/**
	 * Resolve stable wsId from any ws wrapper using the raw Bun ServerWebSocket.
	 * Returns null if the connection has never been registered.
	 */
	private resolveId(conn: WSConnection): string | null {
		const raw = (conn as any).raw;
		if (!raw) return null;
		return this.rawToId.get(raw) ?? null;
	}

	/**
	 * Register a WebSocket connection (idempotent based on raw socket identity).
	 * Called automatically by Elysia WebSocket plugin on connection open.
	 * Also called lazily by ensureRegistered() if a message arrives before
	 * the async open handler completes (race condition with await import).
	 */
	register(conn: WSConnection): string {
		// Check if already registered via raw socket identity
		const existingId = this.resolveId(conn);
		if (existingId && this.connections.has(existingId)) {
			// Update stored wrapper reference (so room maps point to latest wrapper)
			this.connections.set(existingId, conn);
			return existingId;
		}

		// New connection: create fresh registration
		const raw = (conn as any).raw;
		if (!raw) {
			throw new Error('No raw socket found on ws wrapper - cannot register connection');
		}

		const id = crypto.randomUUID();
		this.rawToId.set(raw, id);
		this.connections.set(id, conn);
		this.connectionState.set(id, { userId: null, projectId: null, chatSessionIds: new Set(), cleanups: new Set() });

		this.metrics.totalConnections = this.connections.size;
		debug.log('websocket', `Connection registered: ${id} (total: ${this.connections.size})`);
		return id;
	}

	/**
	 * Ensure a connection is registered, hydrated, and return its wsId.
	 * Handles the race condition where message handlers fire before the async
	 * open handler completes its await import('$backend/lib/utils/ws').
	 */
	private ensureRegistered(conn: WSConnection): string {
		const existingId = this.resolveId(conn);
		if (existingId && this.connections.has(existingId)) {
			this.connections.set(existingId, conn);
			return existingId;
		}
		return this.register(conn);
	}

	/**
	 * Unregister a WebSocket connection.
	 * Called automatically on connection close.
	 * Runs all registered cleanup functions before removing state.
	 */
	unregister(conn: WSConnection): void {
		const id = this.resolveId(conn);
		if (!id) return;

		// Get state from external storage (NOT from wrapper which may be stale)
		const state = this.connectionState.get(id);

		// Run all registered cleanup functions
		if (state?.cleanups.size) {
			for (const cleanup of state.cleanups) {
				try { cleanup(); } catch { /* ignore cleanup errors */ }
			}
			debug.log('websocket', `Ran ${state.cleanups.size} cleanup(s) for connection ${id}`);
		}

		// Remove from project room
		const projectId = state?.projectId;
		if (projectId) {
			const room = this.projectRooms.get(projectId);
			if (room) {
				room.delete(id);
				if (room.size === 0) {
					this.projectRooms.delete(projectId);
				}
			}
		}

		// Remove from all chat session rooms
		if (state?.chatSessionIds) {
			for (const csId of state.chatSessionIds) {
				const csRoom = this.chatSessionRooms.get(csId);
				if (csRoom) {
					csRoom.delete(id);
					if (csRoom.size === 0) {
						this.chatSessionRooms.delete(csId);
					}
				}
			}
		}

		// Remove from user connections
		const userId = state?.userId;
		if (userId) {
			const userConns = this.userConnections.get(userId);
			if (userConns) {
				userConns.delete(id);
				if (userConns.size === 0) {
					this.userConnections.delete(userId);
				}
			}
		}

		// Clean up all state
		this.connections.delete(id);
		this.connectionState.delete(id);

		// Clean up raw socket mapping
		const raw = (conn as any).raw;
		if (raw) {
			this.rawToId.delete(raw);
		}

		this.metrics.totalConnections = this.connections.size;
		this.metrics.activeProjects = this.projectRooms.size;
		this.metrics.activeUsers = this.userConnections.size;

		debug.log('websocket', `Connection unregistered: ${id} (total: ${this.connections.size})`);
	}

	/**
	 * Register a cleanup function for a connection.
	 * Will be called automatically when the connection is unregistered (closed).
	 * Uses raw socket identity so it works across Elysia wrapper instances.
	 */
	addCleanup(conn: WSConnection, cleanup: () => void): void {
		const wsId = this.ensureRegistered(conn);
		const state = this.connectionState.get(wsId);
		state?.cleanups.add(cleanup);
	}

	/**
	 * Remove a previously registered cleanup function.
	 */
	removeCleanup(conn: WSConnection, cleanup: () => void): void {
		const id = this.resolveId(conn);
		if (!id) return;
		const state = this.connectionState.get(id);
		state?.cleanups.delete(cleanup);
	}

	/**
	 * Set user ID for a connection.
	 * Tracks which user owns this connection (for per-user events).
	 */
	setUser(conn: WSConnection, userId: string | null): void {
		const wsId = this.ensureRegistered(conn);

		// Get OLD userId from external state (NOT from wrapper which may be stale)
		const state = this.connectionState.get(wsId);
		const oldUserId = state?.userId;

		// Remove from old user group by ID
		if (oldUserId && oldUserId !== userId) {
			const oldUserConns = this.userConnections.get(oldUserId);
			if (oldUserConns) {
				oldUserConns.delete(wsId);
				if (oldUserConns.size === 0) {
					this.userConnections.delete(oldUserId);
				}
			}
		}

		// Update connection state
		if (state) {
			state.userId = userId;
		}

		// Add to new user group by ID (Map.set replaces if same key → no duplicates)
		if (userId) {
			if (!this.userConnections.has(userId)) {
				this.userConnections.set(userId, new Map());
			}
			this.userConnections.get(userId)!.set(wsId, conn);

			// If connection already has a project, track membership
			// (handles case where setUser is called after setProject)
			const currentProjectId = state?.projectId;
			if (currentProjectId) {
				if (!this.projectMembers.has(currentProjectId)) {
					this.projectMembers.set(currentProjectId, new Set());
				}
				this.projectMembers.get(currentProjectId)!.add(userId);
			}
		}

		this.metrics.activeUsers = this.userConnections.size;
		debug.log('websocket', `Connection ${wsId} set to user: ${userId}`);
	}

	/**
	 * Get user ID for a connection.
	 * Throws if not set - ensures single source of truth.
	 * Client must call ws:set-context before sending events.
	 */
	getUserId(conn: WSConnection): string {
		const id = this.resolveId(conn);
		if (!id) {
			throw new Error('Connection not registered. Cannot resolve userId.');
		}
		const userId = this.connectionState.get(id)?.userId;
		if (!userId) {
			throw new Error('No userId on connection. Client must call ws:set-context first.');
		}
		return userId;
	}

	/**
	 * Set current project for a connection.
	 * Moves connection between project rooms efficiently using ID-based lookup.
	 */
	setProject(conn: WSConnection, projectId: string | null): void {
		const wsId = this.ensureRegistered(conn);

		// Get OLD projectId from external state (NOT from wrapper which may be stale)
		const state = this.connectionState.get(wsId);
		const oldProjectId = state?.projectId;

		// Remove from old project room by ID
		if (oldProjectId && oldProjectId !== projectId) {
			const oldRoom = this.projectRooms.get(oldProjectId);
			if (oldRoom) {
				oldRoom.delete(wsId);
				if (oldRoom.size === 0) {
					this.projectRooms.delete(oldProjectId);
				}
			}
		}

		// Update connection state
		if (state) {
			state.projectId = projectId;
		}

		// Add to new project room by ID (Map.set replaces if same key → no duplicates)
		if (projectId) {
			if (!this.projectRooms.has(projectId)) {
				this.projectRooms.set(projectId, new Map());
			}
			this.projectRooms.get(projectId)!.set(wsId, conn);

			// Track project membership (persists across project switches)
			// Used by emit.projectMembers() for cross-project notifications
			const userId = state?.userId;
			if (userId) {
				if (!this.projectMembers.has(projectId)) {
					this.projectMembers.set(projectId, new Set());
				}
				this.projectMembers.get(projectId)!.add(userId);
			}
		}

		this.metrics.activeProjects = this.projectRooms.size;
		debug.log('websocket', `Connection ${wsId} set to project: ${projectId}`);
	}

	/**
	 * Get project ID for a connection.
	 * Throws if not set - ensures single source of truth.
	 * Client must call ws:set-context before sending events.
	 */
	getProjectId(conn: WSConnection): string {
		const id = this.resolveId(conn);
		if (!id) {
			throw new Error('Connection not registered. Cannot resolve projectId.');
		}
		const projectId = this.connectionState.get(id)?.projectId;
		if (!projectId) {
			throw new Error('No projectId on connection. Client must call ws:set-context first.');
		}
		return projectId;
	}

	/**
	 * Join a chat session room.
	 * A connection can be in multiple chat session rooms simultaneously,
	 * but typically only one at a time (leave old before joining new).
	 */
	joinChatSession(conn: WSConnection, chatSessionId: string): void {
		const wsId = this.ensureRegistered(conn);
		const state = this.connectionState.get(wsId);

		if (!state) return;

		// Add to chat session room
		if (!this.chatSessionRooms.has(chatSessionId)) {
			this.chatSessionRooms.set(chatSessionId, new Map());
		}
		this.chatSessionRooms.get(chatSessionId)!.set(wsId, conn);

		// Track on connection state
		state.chatSessionIds.add(chatSessionId);

		debug.log('websocket', `Connection ${wsId} joined chat session: ${chatSessionId}`);
	}

	/**
	 * Leave a chat session room.
	 */
	leaveChatSession(conn: WSConnection, chatSessionId: string): void {
		const wsId = this.resolveId(conn);
		if (!wsId) return;

		const state = this.connectionState.get(wsId);
		if (state) {
			state.chatSessionIds.delete(chatSessionId);
		}

		const room = this.chatSessionRooms.get(chatSessionId);
		if (room) {
			room.delete(wsId);
			if (room.size === 0) {
				this.chatSessionRooms.delete(chatSessionId);
			}
		}

		debug.log('websocket', `Connection ${wsId} left chat session: ${chatSessionId}`);
	}

	/**
	 * Leave all chat session rooms for a connection.
	 */
	leaveAllChatSessions(conn: WSConnection): void {
		const wsId = this.resolveId(conn);
		if (!wsId) return;

		const state = this.connectionState.get(wsId);
		if (!state) return;

		for (const csId of state.chatSessionIds) {
			const room = this.chatSessionRooms.get(csId);
			if (room) {
				room.delete(wsId);
				if (room.size === 0) {
					this.chatSessionRooms.delete(csId);
				}
			}
		}
		state.chatSessionIds.clear();
	}

	/**
	 * Get user info for all connections in a chat session room.
	 * Returns deduplicated list of { userId, userName } for users currently viewing the session.
	 */
	getChatSessionUsers(chatSessionId: string): { userId: string; userName: string }[] {
		const room = this.chatSessionRooms.get(chatSessionId);
		if (!room || room.size === 0) return [];

		const seen = new Map<string, string>(); // userId → userName
		for (const [wsId] of room) {
			const state = this.connectionState.get(wsId);
			if (state?.userId) {
				// Resolve userName from user connections or fallback
				if (!seen.has(state.userId)) {
					seen.set(state.userId, state.userId); // default to userId
				}
			}
		}
		return Array.from(seen.entries()).map(([userId, userName]) => ({ userId, userName }));
	}

	/**
	 * Get all chat session IDs that have active connections for a given project.
	 * Used for per-session presence data.
	 */
	getProjectChatSessions(projectId: string): Map<string, { userId: string }[]> {
		const result = new Map<string, { userId: string }[]>();

		// Iterate through all chat session rooms
		for (const [chatSessionId, room] of this.chatSessionRooms) {
			const users: { userId: string }[] = [];
			const seenUsers = new Set<string>();

			for (const [wsId] of room) {
				const state = this.connectionState.get(wsId);
				// Only include connections that belong to this project
				if (state?.projectId === projectId && state?.userId && !seenUsers.has(state.userId)) {
					seenUsers.add(state.userId);
					users.push({ userId: state.userId });
				}
			}

			if (users.length > 0) {
				result.set(chatSessionId, users);
			}
		}

		return result;
	}

	/**
	 * Get raw connection state for a connection.
	 * Used internally by ws:set-context to read back current values.
	 */
	getConnectionState(conn: WSConnection): ConnectionState | undefined {
		const id = this.resolveId(conn);
		if (!id) return undefined;
		return this.connectionState.get(id);
	}

	/**
	 * Check if connection can receive data (backpressure check)
	 */
	private canSend(conn: WSConnection): boolean {
		if (!CONFIG.ENABLE_BACKPRESSURE) return true;

		// Check WebSocket ready state
		if (conn.readyState !== 1) return false;

		// Check buffer size if available (Bun/uWebSockets)
		const rawWs = conn as any;
		if (typeof rawWs.getBufferedAmount === 'function') {
			const buffered = rawWs.getBufferedAmount();
			if (buffered > CONFIG.MAX_BUFFER_SIZE) {
				if (CONFIG.LOG_DROPPED_FRAMES) {
					this.metrics.droppedFrames++;
					const id = this.resolveId(conn) || 'unknown';
					debug.warn('websocket', `Backpressure: dropping frame for ${id} (buffer: ${buffered})`);
				}
				return false;
			}
		}

		return true;
	}

	/**
	 * Send message to a single connection with backpressure handling
	 */
	private sendToConnection(conn: WSConnection, message: string | ArrayBuffer): boolean {
		if (!this.canSend(conn)) {
			return false;
		}

		try {
			// For binary data (ArrayBuffer), wrap in Buffer for Bun/Elysia compatibility
			if (message instanceof ArrayBuffer) {
				conn.send(Buffer.from(message));
			} else {
				conn.send(message);
			}
			return true;
		} catch (err) {
			const id = this.resolveId(conn) || 'unknown';
			debug.error('websocket', `Send error for ${id}:`, err);
			return false;
		}
	}

	/**
	 * Clean stale connections from a room Map.
	 * Returns number of stale connections removed.
	 */
	private cleanStaleFromRoom(room: Map<string, WSConnection>): number {
		const staleIds: string[] = [];
		for (const [wsId, wsConn] of room) {
			if (wsConn.readyState !== 1) {
				staleIds.push(wsId);
			}
		}
		for (const staleId of staleIds) {
			const staleConn = room.get(staleId);
			room.delete(staleId);
			if (staleConn) {
				this.unregister(staleConn);
			}
		}
		return staleIds.length;
	}

	/**
	 * Emit API - Clean interface for sending events
	 */
	emit = {
		/**
		 * Emit event to all connections in a project room
		 */
		project: <K extends keyof WSAPI['server']>(
			projectId: string,
			event: K,
			payload: WSAPI['server'][K]
		): void => {
			this.metrics.totalEmits++;

			const room = this.projectRooms.get(projectId);
			if (!room || room.size === 0) {
				debug.warn('websocket', `No connections in project room: ${projectId} for event: ${String(event)}`);
				return;
			}

			// Clean stale connections before sending
			const staleCount = this.cleanStaleFromRoom(room);
			if (staleCount > 0) {
				debug.log('websocket', `Cleaned ${staleCount} stale connections from project room ${projectId}`);
			}

			if (room.size === 0) {
				this.projectRooms.delete(projectId);
				return;
			}

			// Check if payload contains binary data - use binary encoding if so
			const eventStr = String(event);
			const hasBinary = isBinaryAction(eventStr, payload);
			const message = hasBinary
				? encodeBinaryMessage(eventStr, payload)
				: JSON.stringify({ action: event, payload });

			let sentCount = 0;

			for (const wsConn of room.values()) {
				if (this.sendToConnection(wsConn, message)) {
					sentCount++;
				}
			}

			debug.log('websocket', `Emitted ${eventStr}${hasBinary ? ' (binary)' : ''} to ${sentCount}/${room.size} connections in project ${projectId}`);
		},

		/**
		 * Emit event to all connections of a specific user
		 */
		user: <K extends keyof WSAPI['server']>(
			userId: string,
			event: K,
			payload: WSAPI['server'][K]
		): void => {
			this.metrics.totalEmits++;

			const userConns = this.userConnections.get(userId);
			if (!userConns || userConns.size === 0) {
				debug.warn('websocket', `No connections for user: ${userId} for event: ${String(event)}`);
				return;
			}

			// Clean stale connections
			const staleCount = this.cleanStaleFromRoom(userConns);
			if (staleCount > 0) {
				debug.log('websocket', `Cleaned ${staleCount} stale user connections for user ${userId}`);
			}

			if (userConns.size === 0) {
				this.userConnections.delete(userId);
				return;
			}

			// Check if payload contains binary data - use binary encoding if so
			const eventStr = String(event);
			const hasBinary = isBinaryAction(eventStr, payload);
			const message = hasBinary
				? encodeBinaryMessage(eventStr, payload)
				: JSON.stringify({ action: event, payload });

			let sentCount = 0;

			for (const wsConn of userConns.values()) {
				if (this.sendToConnection(wsConn, message)) {
					sentCount++;
				}
			}

			debug.log('websocket', `Emitted ${eventStr}${hasBinary ? ' (binary)' : ''} to ${sentCount}/${userConns.size} connections for user ${userId}`);
		},

		/**
		 * Emit event to all users who have ever joined a project.
		 * Unlike emit.project() which only reaches connections currently in the room,
		 * this reaches ALL connections of users who have been associated with the project
		 * (even if they switched to a different project).
		 * Used for cross-project notifications (e.g., stream finished).
		 */
		projectMembers: <K extends keyof WSAPI['server']>(
			projectId: string,
			event: K,
			payload: WSAPI['server'][K]
		): void => {
			this.metrics.totalEmits++;

			const memberIds = this.projectMembers.get(projectId);
			if (!memberIds || memberIds.size === 0) {
				debug.warn('websocket', `No members for project: ${projectId} for event: ${String(event)}`);
				return;
			}

			// Check if payload contains binary data - use binary encoding if so
			const eventStr = String(event);
			const hasBinary = isBinaryAction(eventStr, payload);
			const message = hasBinary
				? encodeBinaryMessage(eventStr, payload)
				: JSON.stringify({ action: event, payload });

			let sentCount = 0;
			let totalConns = 0;

			// Send to all connections of all member users
			for (const userId of memberIds) {
				const userConns = this.userConnections.get(userId);
				if (!userConns || userConns.size === 0) continue;

				// Clean stale connections
				this.cleanStaleFromRoom(userConns);
				if (userConns.size === 0) {
					this.userConnections.delete(userId);
					continue;
				}

				totalConns += userConns.size;
				for (const wsConn of userConns.values()) {
					if (this.sendToConnection(wsConn, message)) {
						sentCount++;
					}
				}
			}

			debug.log('websocket', `Emitted ${eventStr}${hasBinary ? ' (binary)' : ''} to ${sentCount}/${totalConns} connections of ${memberIds.size} members in project ${projectId}`);
		},

		/**
		 * Emit event to all connections in a chat session room.
		 * Used for session-scoped chat events (message, partial, complete, etc.)
		 */
		chatSession: <K extends keyof WSAPI['server']>(
			chatSessionId: string,
			event: K,
			payload: WSAPI['server'][K]
		): void => {
			this.metrics.totalEmits++;

			const room = this.chatSessionRooms.get(chatSessionId);
			if (!room || room.size === 0) {
				debug.warn('websocket', `No connections in chat session room: ${chatSessionId} for event: ${String(event)}`);
				return;
			}

			// Clean stale connections before sending
			const staleCount = this.cleanStaleFromRoom(room);
			if (staleCount > 0) {
				debug.log('websocket', `Cleaned ${staleCount} stale connections from chat session room ${chatSessionId}`);
			}

			if (room.size === 0) {
				this.chatSessionRooms.delete(chatSessionId);
				return;
			}

			const eventStr = String(event);
			const hasBinary = isBinaryAction(eventStr, payload);
			const message = hasBinary
				? encodeBinaryMessage(eventStr, payload)
				: JSON.stringify({ action: event, payload });

			let sentCount = 0;

			for (const wsConn of room.values()) {
				if (this.sendToConnection(wsConn, message)) {
					sentCount++;
				}
			}

			debug.log('websocket', `Emitted ${eventStr}${hasBinary ? ' (binary)' : ''} to ${sentCount}/${room.size} connections in chat session ${chatSessionId.slice(0, 8)}`);
		},

		/**
		 * Emit event to all connections (broadcast)
		 */
		global: <K extends keyof WSAPI['server']>(
			event: K,
			payload: WSAPI['server'][K]
		): void => {
			this.metrics.totalEmits++;

			// Check if payload contains binary data - use binary encoding if so
			const eventStr = String(event);
			const hasBinary = isBinaryAction(eventStr, payload);
			const message = hasBinary
				? encodeBinaryMessage(eventStr, payload)
				: JSON.stringify({ action: event, payload });

			let sentCount = 0;

			for (const wsConn of this.connections.values()) {
				if (this.sendToConnection(wsConn, message)) {
					sentCount++;
				}
			}

			debug.log('websocket', `Emitted ${eventStr}${hasBinary ? ' (binary)' : ''} to ${sentCount}/${this.connections.size} connections (global)`);
		}
	};

	/**
	 * Emit binary event to project room
	 */
	emitBinary = {
		/**
		 * Emit binary data to all connections in a project room
		 */
		project: <K extends keyof WSAPI['server']>(
			projectId: string,
			_event: K,
			binaryMessage: ArrayBuffer
		): void => {
			this.metrics.totalEmits++;

			const room = this.projectRooms.get(projectId);
			if (!room || room.size === 0) return;

			let sentCount = 0;
			for (const ws of room.values()) {
				if (this.sendToConnection(ws, binaryMessage)) {
					sentCount++;
				}
			}

			debug.log('websocket', `Emitted binary to ${sentCount}/${room.size} connections in project ${projectId}`);
		},

		/**
		 * Emit binary data to all connections of a specific user
		 */
		user: <K extends keyof WSAPI['server']>(
			userId: string,
			_event: K,
			binaryMessage: ArrayBuffer
		): void => {
			this.metrics.totalEmits++;

			const userConns = this.userConnections.get(userId);
			if (!userConns || userConns.size === 0) return;

			let sentCount = 0;
			for (const ws of userConns.values()) {
				if (this.sendToConnection(ws, binaryMessage)) {
					sentCount++;
				}
			}

			debug.log('websocket', `Emitted binary to ${sentCount}/${userConns.size} connections for user ${userId}`);
		},

		/**
		 * Emit binary data to all connections (broadcast)
		 */
		global: <K extends keyof WSAPI['server']>(
			_event: K,
			binaryMessage: ArrayBuffer
		): void => {
			this.metrics.totalEmits++;

			let sentCount = 0;
			for (const ws of this.connections.values()) {
				if (this.sendToConnection(ws, binaryMessage)) {
					sentCount++;
				}
			}

			debug.log('websocket', `Emitted binary to ${sentCount}/${this.connections.size} connections (global)`);
		}
	};

	/**
	 * Get all connections (optionally filtered by project)
	 */
	getConnections(projectId?: string): WSConnection[] {
		if (projectId) {
			const room = this.projectRooms.get(projectId);
			return room ? Array.from(room.values()) : [];
		}
		return Array.from(this.connections.values());
	}

	/**
	 * Get connection count (optionally filtered by project)
	 */
	getConnectionCount(projectId?: string): number {
		if (projectId) {
			return this.projectRooms.get(projectId)?.size || 0;
		}
		return this.connections.size;
	}

	/**
	 * Get all active project IDs
	 */
	getActiveProjects(): Set<string> {
		return new Set(this.projectRooms.keys());
	}

	/**
	 * Get all active user IDs
	 */
	getActiveUsers(): Set<string> {
		return new Set(this.userConnections.keys());
	}

	/**
	 * Get current metrics for monitoring
	 */
	getMetrics(): WSMetrics {
		return { ...this.metrics };
	}

	/**
	 * Get room sizes for debugging
	 */
	getRoomSizes(): { projects: Map<string, number>; users: Map<string, number> } {
		const projects = new Map<string, number>();
		const users = new Map<string, number>();

		for (const [id, room] of this.projectRooms) {
			projects.set(id, room.size);
		}

		for (const [id, conns] of this.userConnections) {
			users.set(id, conns.size);
		}

		return { projects, users };
	}
}

/**
 * Singleton instance
 * Import this in any backend file to emit events
 */
export const ws = new WSServer();
