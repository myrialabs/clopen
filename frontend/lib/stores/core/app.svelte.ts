import ws from '$frontend/lib/utils/ws';
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

interface AppState {
	// UI Navigation
	currentView: string;
	isLoading: boolean;
	isRestoring: boolean;
	isCancelling: boolean;
	error: string | null;

	// Page Information
	pageInfo: PageInfo;

	// App Loading State
	isAppLoading: boolean;
	isAppInitialized: boolean;
}

// Core app state using Svelte 5 runes
export const appState = $state<AppState>({
	// UI Navigation
	currentView: 'chat',
	isLoading: false,
	isRestoring: false,
	isCancelling: false,
	error: null,

	// Page Information
	pageInfo: {
		title: 'Claude Code',
		description: '',
		actions: undefined
	},

	// App Loading State
	isAppLoading: true,
	isAppInitialized: false
});

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
