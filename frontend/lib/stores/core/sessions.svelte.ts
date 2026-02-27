/**
 * Sessions Store
 * All session and message-related state and functions
 *
 * State persistence: Server-side only
 * Session is determined by the shared session per project (sessions:get-shared)
 * No localStorage usage - server is single source of truth
 */

import type { ChatSession, SDKMessageFormatter } from '$shared/types/database/schema';
import type { SDKMessage } from '$shared/types/messaging';
import { buildMetadataFromTransport } from '$shared/utils/message-formatter';
import ws from '$frontend/lib/utils/ws';
import { projectState } from './projects.svelte';
import { setupEditModeListener, restoreEditMode } from '$frontend/lib/stores/ui/edit-mode.svelte';
import { debug } from '$shared/utils/logger';

interface SessionState {
	sessions: ChatSession[];
	currentSession: ChatSession | null;
	messages: SDKMessageFormatter[];
	isLoading: boolean;
	error: string | null;
}

// Session state using Svelte 5 runes
export const sessionState = $state<SessionState>({
	sessions: [],
	currentSession: null,
	messages: [],
	isLoading: false,
	error: null
});

// ========================================
// DERIVED VALUES
// ========================================

export function hasSessions() {
	return sessionState.sessions.length > 0;
}

export function currentSessionId() {
	return sessionState.currentSession?.id || '';
}

export function messageCount() {
	return sessionState.messages.length;
}

// ========================================
// SESSION MANAGEMENT
// ========================================

export async function setCurrentSession(session: ChatSession | null, skipLoadMessages: boolean = false) {
	const previousSessionId = sessionState.currentSession?.id;
	sessionState.currentSession = session;

	// Leave previous chat session room
	if (previousSessionId && previousSessionId !== session?.id) {
		ws.emit('chat:leave-session', { chatSessionId: previousSessionId });
	}

	if (session) {
		// Join new chat session room (receive session-scoped events)
		ws.emit('chat:join-session', { chatSessionId: session.id });

		// Persist current session to server for refresh restore (server is single source of truth)
		ws.emit('sessions:set-current', { sessionId: session.id });

		// Refresh session data from server to get latest engine/model
		// (may have been set by another user's stream or not yet synced)
		try {
			const response = await ws.http('sessions:get', { id: session.id });
			if (response?.session) {
				const freshSession = response.session as ChatSession;
				// Update local session list with fresh data
				const idx = sessionState.sessions.findIndex(s => s.id === session.id);
				if (idx !== -1) {
					sessionState.sessions[idx] = freshSession;
				}
				sessionState.currentSession = freshSession;
			}
		} catch {
			// Ignore - proceed with existing session data
		}

		// Load messages for this session (skip if we're restoring and already have messages)
		if (!skipLoadMessages) {
			await loadMessagesForSession(session.id);
		}

		debug.log('session', 'Session set:', session.id);
	} else {
		// Clear messages when no session
		sessionState.messages = [];
		debug.log('session', 'Session cleared');
	}
}

export async function createSession(projectId: string, title: string, forceNew: boolean = false): Promise<ChatSession | null> {
	try {
		// For shared sessions, we want to get or create a shared session for the project
		const session = await ws.http('sessions:get-shared', { forceNew });

		// When forceNew is true, mark all other sessions for this project as ended in frontend state
		// This ensures switching projects and back won't restore the old session
		if (forceNew) {
			const now = new Date().toISOString();
			for (let i = 0; i < sessionState.sessions.length; i++) {
				const s = sessionState.sessions[i];
				if (s.project_id === projectId && s.id !== session.id && !s.ended_at) {
					sessionState.sessions[i] = { ...s, ended_at: now };
				}
			}
		}

		// Check if session already exists in state
		const existingIndex = sessionState.sessions.findIndex(s => s.id === session.id);
		if (existingIndex === -1) {
			sessionState.sessions.push(session);
		} else {
			// Update existing session
			sessionState.sessions[existingIndex] = session;
		}
		return session;
	} catch (error) {
		debug.error('session', 'Error creating session:', error);
		return null;
	}
}

export async function createNewChatSession(projectId: string): Promise<ChatSession | null> {
	// Force create a new session (ends current shared session if exists)
	return createSession(projectId, 'New Chat Session', true);
}

export function updateSession(updatedSession: ChatSession) {
	const index = sessionState.sessions.findIndex((s) => s.id === updatedSession.id);
	if (index !== -1) {
		sessionState.sessions[index] = updatedSession;

		// Update current session if it's the same
		if (sessionState.currentSession?.id === updatedSession.id) {
			sessionState.currentSession = updatedSession;
		}
	}
}

export function removeSession(sessionId: string) {
	// Use splice for granular Svelte 5 reactivity — only the removed element
	// triggers DOM updates, preventing full-list re-render flicker.
	const index = sessionState.sessions.findIndex((s) => s.id === sessionId);
	if (index !== -1) {
		sessionState.sessions.splice(index, 1);
	}

	// Clear current session if it's the one being removed
	if (sessionState.currentSession?.id === sessionId) {
		sessionState.currentSession = null;
		sessionState.messages = [];
	}
}

export async function endSession(sessionId: string) {
	const session = sessionState.sessions.find((s) => s.id === sessionId);
	if (session && !session.ended_at) {
		try {
			const updatedSession = await ws.http('sessions:update', {
				id: sessionId,
				end_session: true
			});

			updateSession(updatedSession);
		} catch (error) {
			debug.error('session', 'Error ending session:', error);
		}
	}
}

// ========================================
// MESSAGE MANAGEMENT
// ========================================

export function addMessage(message: SDKMessage | SDKMessageFormatter): void {
	// Convert to SDKMessageFormatter if needed
	const messageFormatter: SDKMessageFormatter = {
		...message,
		metadata: ('metadata' in message && message.metadata)
			? message.metadata
			: buildMetadataFromTransport({ timestamp: new Date().toISOString() })
	};
	// Update unified store - single source of truth
	sessionState.messages.push(messageFormatter);
}

export function updateMessages(messages: SDKMessageFormatter[]) {
	sessionState.messages = messages;
}

export function clearMessages() {
	sessionState.messages = [];
}

export async function loadMessagesForSession(sessionId: string) {
	try {
		const response = await ws.http('messages:list', { session_id: sessionId });

		if (response && Array.isArray(response)) {
			// Messages from server already have correct SDKMessageFormatter shape with metadata
			sessionState.messages = response as SDKMessageFormatter[];
		} else {
			sessionState.messages = [];
		}
	} catch (error) {
		debug.error('session', 'Error loading messages:', error);
		sessionState.messages = [];
	}
}

// ========================================
// DATA LOADING
// ========================================

export async function loadSessions() {
	sessionState.isLoading = true;
	sessionState.error = null;

	try {
		const response = await ws.http('sessions:list');

		if (response) {
			const { sessions, currentSessionId } = response;
			sessionState.sessions = sessions;

			// Auto-restore: find the active session for the current project
			if (!sessionState.currentSession) {
				const currentProject = projectState.currentProject;
				if (currentProject) {
					const projectSessions = sessions.filter(
						(s: ChatSession) => s.project_id === currentProject.id && !s.ended_at
					);

					if (projectSessions.length > 0) {
						// Try server-saved session first (preserves user's session across refresh)
						let targetSession: ChatSession | null = null;
						if (currentSessionId) {
							targetSession = projectSessions.find(
								(s: ChatSession) => s.id === currentSessionId
							) || null;
						}

						// Fall back to most recent active session
						if (!targetSession) {
							targetSession = projectSessions.sort((a: ChatSession, b: ChatSession) =>
								new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
							)[0];
						}

						debug.log('session', 'Auto-restoring session for project:', targetSession.id);
						// Load messages BEFORE setting session to avoid race condition:
						// Setting session triggers $effect → catchupActiveStream (async),
						// but loadMessagesForSession replaces sessionState.messages entirely,
						// wiping out any stream_event injected by catchup.
						await loadMessagesForSession(targetSession.id);
						sessionState.currentSession = targetSession;
						// Join chat session room so we receive session-scoped events
						// (stream, input sync, edit mode, model sync).
						// Critical after refresh — without it, connection misses all events.
						ws.emit('chat:join-session', { chatSessionId: targetSession.id });
					}
				}
			}
		} else {
			sessionState.error = 'Failed to load sessions';
		}
	} catch (error) {
		debug.error('session', 'Error loading sessions:', error);
		sessionState.error = `Error loading sessions: ${error}`;
	} finally {
		sessionState.isLoading = false;
	}
}

// ========================================
// UTILITY FUNCTIONS
// ========================================

export function getSessionsForProject(projectId: string): ChatSession[] {
	return sessionState.sessions.filter((session) => session.project_id === projectId);
}

export function getRecentSessions(limit: number = 10): ChatSession[] {
	return sessionState.sessions
		.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
		.slice(0, limit);
}

/**
 * Reload sessions for the current project from the server.
 * Called when the user switches projects so session list stays in sync.
 */
export async function reloadSessionsForProject() {
	try {
		const response = await ws.http('sessions:list');
		if (response) {
			const { sessions } = response;
			// Merge: keep sessions from other projects, replace sessions for current project
			const currentProjectId = projectState.currentProject?.id;
			if (currentProjectId) {
				const otherProjectSessions = sessionState.sessions.filter(
					(s: ChatSession) => s.project_id !== currentProjectId
				);
				sessionState.sessions = [...otherProjectSessions, ...sessions];
			} else {
				sessionState.sessions = sessions;
			}
		}
	} catch (error) {
		debug.error('session', 'Error reloading sessions:', error);
	}
}

// ========================================
// COLLABORATIVE LISTENERS
// ========================================

/**
 * Setup WebSocket listeners for collaborative session management.
 * When another user creates a new chat session, all users in the project
 * automatically switch to the new shared session.
 */
function setupCollaborativeListeners() {
	// Listen for new session available notifications from other users.
	// Does NOT auto-switch — adds session to list and shows notification.
	ws.on('sessions:session-available', async (data: { session: ChatSession }) => {
		debug.log('session', 'New session available in project:', data.session.id);

		const { session } = data;

		// Add to sessions list (don't switch)
		const existingIndex = sessionState.sessions.findIndex(s => s.id === session.id);
		if (existingIndex === -1) {
			sessionState.sessions.push(session);
		} else {
			sessionState.sessions[existingIndex] = session;
		}
	});

	// Listen for session deletion broadcasts from other users
	ws.on('sessions:session-deleted', (data: { sessionId: string; projectId: string }) => {
		debug.log('session', 'Session deleted by another user:', data.sessionId);
		removeSession(data.sessionId);
	});

	// Listen for messages-changed broadcasts (undo/redo/edit by another user)
	ws.on('chat:messages-changed', async (data: { sessionId: string; reason: string; timestamp: string }) => {
		debug.log('session', `Messages changed (${data.reason}) for session: ${data.sessionId}`);

		// Reload messages if we're viewing the affected session
		if (sessionState.currentSession?.id === data.sessionId) {
			await loadMessagesForSession(data.sessionId);
		}
	});
}

// ========================================
// INITIALIZATION
// ========================================

export async function initializeSessions() {
	// Setup sync listeners first (no await needed)
	setupCollaborativeListeners();
	setupEditModeListener();

	// Load sessions and restore edit mode in parallel
	// Both only need WS project context (already set by initializeProjects)
	await Promise.all([
		loadSessions(),
		restoreEditMode()
	]);
	debug.log('session', 'Sessions initialized');
}
