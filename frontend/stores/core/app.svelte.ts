import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

/**
 * Core Application Store
 * Main app state: UI, navigation, loading, errors
 *
 * State persistence: lastView saved to server via user:save-state
 * No localStorage usage for view state
 */

interface PageInfo {
	title: string;
	description: string;
	actions?: import('svelte').Snippet;
}

/**
 * Per-session process state.
 * Tracks loading/waiting/cancelling state for each chat session independently,
 * enabling correct multi-session and multi-project support.
 *
 * NOTE: `isRestoring` is intentionally NOT part of this per-session state. It is
 * a global project-switch/refresh TRANSITION flag owned solely by the project
 * store + workspace bootstrap (see `appState.isRestoring`). Mixing it in here
 * once caused `syncGlobalStateFromSession()` to reset the transition flag mid
 * project-switch — leaving the chat dock stuck hidden until a full refresh.
 */
export interface SessionProcessState {
	isLoading: boolean;
	isWaitingInput: boolean;
	isCancelling: boolean;
	error: string | null;
}

const DEFAULT_SESSION_STATE: SessionProcessState = {
	isLoading: false,
	isWaitingInput: false,
	isCancelling: false,
	error: null,
};

interface AppState {
	// UI Navigation
	currentView: string;

	// Current session process state (convenience — synced from sessionStates for the active session)
	isLoading: boolean;
	isWaitingInput: boolean;
	isCancelling: boolean;
	error: string | null;

	// Project-switch/refresh transition flag. NOT a per-session value: owned by
	// the project store (setCurrentProject) and the workspace bootstrap
	// (WorkspaceLayout). Held true across the whole project + session restore so
	// the chat dock keeps stale content hidden and restores its saved reading
	// position instead of snapping to the bottom. Deliberately excluded from
	// `syncGlobalStateFromSession` so a mid-switch session change can't clear it.
	isRestoring: boolean;

	// Per-session process states (source of truth for multi-session support)
	sessionStates: Record<string, SessionProcessState>;

	// Unread sessions — maps session ID → project ID for sessions with new activity
	unreadSessions: Map<string, string>;

	// Page Information
	pageInfo: PageInfo;

	// App Loading State
	isAppLoading: boolean;
	isAppInitialized: boolean;

	// Project-switch transition: true while docks are being torn down and the
	// new project's workspace is being restored. Drives the uniform dock
	// skeletons so every dock reveals together and no stale data leaks through.
	isSwitching: boolean;
}

// Core app state using Svelte 5 runes
export const appState = $state<AppState>({
	// UI Navigation
	currentView: 'chat',
	isLoading: false,
	isWaitingInput: false,
	isRestoring: false,
	isCancelling: false,
	error: null,

	// Per-session process states
	sessionStates: {},

	// Unread sessions (sessionId → projectId)
	unreadSessions: new Map<string, string>(),

	// Page Information
	pageInfo: {
		title: 'Claude Code',
		description: '',
		actions: undefined
	},

	// App Loading State
	isAppLoading: true,
	isAppInitialized: false,

	// Project-switch transition
	isSwitching: false
});

// ========================================
// PER-SESSION PROCESS STATE MANAGEMENT
// ========================================

/**
 * Get the process state for a specific session.
 * Returns default (idle) state if the session has no entry.
 */
export function getSessionProcessState(sessionId: string): SessionProcessState {
	return appState.sessionStates[sessionId] ?? DEFAULT_SESSION_STATE;
}

/**
 * Update process state for a specific session in the per-session map.
 * Does NOT touch global convenience flags — caller is responsible for that.
 */
export function updateSessionProcessState(
	sessionId: string,
	update: Partial<SessionProcessState>
): void {
	if (!appState.sessionStates[sessionId]) {
		appState.sessionStates[sessionId] = { ...DEFAULT_SESSION_STATE };
	}
	Object.assign(appState.sessionStates[sessionId], update);
}

/**
 * Sync global convenience flags from a session's per-session state.
 * Call whenever the actively-viewed session changes (switch session/project)
 * so the global flags always reflect the session on screen and never carry
 * stale state (e.g. "Waiting for your input") over from the previous one.
 * Pass null/undefined when no session is active to reset to idle defaults.
 */
export function syncGlobalStateFromSession(sessionId: string | null | undefined): void {
	const state = (sessionId ? appState.sessionStates[sessionId] : undefined) ?? DEFAULT_SESSION_STATE;
	appState.isLoading = state.isLoading;
	appState.isWaitingInput = state.isWaitingInput;
	appState.isCancelling = state.isCancelling;
	appState.error = state.error;
	// NOTE: `appState.isRestoring` is deliberately NOT synced here — it is a
	// global project-switch transition flag, not per-session. Resetting it during
	// a switch (setCurrentSession → here) would defeat the transition and leave
	// the chat dock hidden until refresh.
}

/**
 * Remove all app-level state for a deleted session
 * (process state, unread status, etc.)
 */
export function clearSessionState(sessionId: string): void {
	delete appState.sessionStates[sessionId];

	if (appState.unreadSessions.has(sessionId)) {
		const next = new Map(appState.unreadSessions);
		next.delete(sessionId);
		appState.unreadSessions = next;
		persistUnreadSessions();
	}
}

// ========================================
// UNREAD SESSION MANAGEMENT
// ========================================

/**
 * Persist the current unread sessions Map to the server via user:save-state.
 * Uses the same proven infrastructure as currentProjectId/lastView persistence.
 * Debounced: only the last call within 500ms actually persists.
 */
let saveUnreadTimeout: ReturnType<typeof setTimeout> | null = null;

function persistUnreadSessions(): void {
	if (saveUnreadTimeout) clearTimeout(saveUnreadTimeout);
	saveUnreadTimeout = setTimeout(() => {
		const serialized = Object.fromEntries(appState.unreadSessions);
		debug.log('session', '[unread] Persisting to server:', serialized);
		ws.http('user:save-state', { key: 'unreadSessions', value: serialized }).catch(err => {
			debug.error('session', '[unread] Error persisting unread sessions:', err);
		});
	}, 500);
}

/**
 * Mark a session as unread (has new activity the user hasn't seen).
 * Persists to backend so the state survives browser refresh.
 */
export function markSessionUnread(sessionId: string, projectId: string): void {
	const next = new Map(appState.unreadSessions);
	next.set(sessionId, projectId);
	appState.unreadSessions = next;

	// Persist to backend via user:save-state (proven infrastructure)
	debug.log('session', `[unread] markSessionUnread: sessionId=${sessionId}, projectId=${projectId}`);
	ws.emit('sessions:mark-unread', { sessionId, projectId });
	persistUnreadSessions();
}

/**
 * Mark a session as read (user has viewed it).
 * Persists to backend so the state survives browser refresh.
 */
export function markSessionRead(sessionId: string): void {
	if (appState.unreadSessions.has(sessionId)) {
		const next = new Map(appState.unreadSessions);
		next.delete(sessionId);
		appState.unreadSessions = next;

		// Persist to backend via user:save-state (proven infrastructure)
		debug.log('session', `[unread] markSessionRead: sessionId=${sessionId}`);
		ws.emit('sessions:mark-read', { sessionId });
		persistUnreadSessions();
	}
}

/**
 * Mark every unread session in a project as read (bulk).
 * Persists to backend so the state survives browser refresh.
 */
export function markAllSessionsRead(projectId: string): void {
	const next = new Map(appState.unreadSessions);
	let changed = false;
	for (const [sessionId, pId] of appState.unreadSessions.entries()) {
		if (pId === projectId) {
			next.delete(sessionId);
			changed = true;
		}
	}
	if (!changed) return;

	appState.unreadSessions = next;

	// Persist to backend via a single bulk delete (proven infrastructure)
	debug.log('session', `[unread] markAllSessionsRead: projectId=${projectId}`);
	ws.emit('sessions:mark-all-read', { projectId });
	persistUnreadSessions();
}

/**
 * Restore unread sessions from server state (called during initialization).
 */
export function restoreUnreadSessions(saved: Record<string, string> | null): void {
	if (!saved || typeof saved !== 'object') return;

	const next = new Map(appState.unreadSessions);
	for (const [sessionId, projectId] of Object.entries(saved)) {
		if (typeof sessionId === 'string' && typeof projectId === 'string') {
			next.set(sessionId, projectId);
		}
	}
	appState.unreadSessions = next;
	debug.log('session', '[unread] Restored from server:', Object.fromEntries(appState.unreadSessions));
}

/**
 * Check if a session is unread.
 */
export function isSessionUnread(sessionId: string): boolean {
	return appState.unreadSessions.has(sessionId);
}

/**
 * Check if a project has any unread sessions.
 * Optionally exclude a specific session (e.g. the currently viewed one).
 */
export function hasUnreadSessionsForProject(projectId: string, excludeSessionId?: string): boolean {
	for (const [sId, pId] of appState.unreadSessions.entries()) {
		if (pId === projectId && sId !== excludeSessionId) return true;
	}
	return false;
}

// ========================================
// UI STATE MANAGEMENT
// ========================================

export function setLoading(loading: boolean) {
	appState.isLoading = loading;
}

export function setCurrentView(view: string) {
	appState.currentView = view;
	// Save current view to server (fire-and-forget)
	ws.http('user:save-state', { key: 'lastView', value: view }).catch(err => {
		debug.error('workspace', 'Error saving lastView to server:', err);
	});
}

export function setPageInfo(title: string, description?: string, actions?: import('svelte').Snippet) {
	appState.pageInfo.title = title;
	appState.pageInfo.description = description || '';
	appState.pageInfo.actions = actions;
}

export function setError(error: string | null) {
	appState.error = error;
}

export function clearError() {
	appState.error = null;
}

// App loading state management
export function setAppLoading(loading: boolean) {
	appState.isAppLoading = loading;
}

export function setAppInitialized() {
	appState.isAppInitialized = true;
	appState.isAppLoading = false;
}

/**
 * Restore last view from server-provided state.
 * Called during initialization with state from user:restore-state.
 */
export function restoreLastView(lastView?: string | null) {
	if (lastView) {
		const validViews = ['chat', 'files', 'terminal', 'history', 'settings'];
		if (validViews.includes(lastView)) {
			appState.currentView = lastView;
			return lastView;
		}
	}
	return 'chat'; // Default fallback
}

// ========================================
// INITIALIZATION
// ========================================

export function initializeStore() {
	// Initialize core app store
	// Any initialization logic can be added here
}
