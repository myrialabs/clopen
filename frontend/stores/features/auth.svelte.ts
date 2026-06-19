/**
 * Auth Store — Svelte 5 Runes
 *
 * Manages authentication state: setup, login, invite, and session persistence.
 * Session token is stored in localStorage for cross-refresh persistence.
 * The token is validated against the server on each app load.
 * Supports no-auth mode (single user, no login required).
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import type { AuthMode } from '$shared/types/stores/settings';

const SESSION_TOKEN_KEY = 'clopen-session-token';

export type AuthState = 'loading' | 'setup' | 'login' | 'invite' | 'ready';

export interface AuthUser {
	id: string;
	name: string;
	role: 'admin' | 'member';
	color: string;
	avatar: string;
	createdAt: string;
}

// Reactive state
let authState = $state<AuthState>('loading');
let currentUser = $state<AuthUser | null>(null);
let sessionToken = $state<string | null>(null);
let personalAccessToken = $state<string | null>(null);
let authMode = $state<AuthMode>('required');

// Listen for server-side force-logout (auth mode switched to required)
ws.on('auth:force-logout', (payload) => {
	debug.log('auth', `Force logout received: ${payload.reason}`);
	currentUser = null;
	sessionToken = null;
	personalAccessToken = null;
	localStorage.removeItem(SESSION_TOKEN_KEY);
	ws.setSessionToken(null);
	authMode = 'required';
	authState = 'login';
});

// Listen for targeted force-logout (e.g., project access revoked)
ws.on('auth:force-logout-user', (payload) => {
	debug.log('auth', `User force-logout received: ${payload.reason}`);
	currentUser = null;
	sessionToken = null;
	personalAccessToken = null;
	localStorage.removeItem(SESSION_TOKEN_KEY);
	ws.setSessionToken(null);
	authState = 'login';
});

export const authStore = {
	get authState() { return authState; },
	get currentUser() { return currentUser; },
	get sessionToken() { return sessionToken; },
	/** PAT is only available right after setup/invite accept — shown once */
	get personalAccessToken() { return personalAccessToken; },
	/** Current auth mode from server */
	get authMode() { return authMode; },

	get isAdmin() { return currentUser?.role === 'admin'; },
	get isAuthenticated() { return authState === 'ready' && currentUser !== null; },
	get isNoAuth() { return authMode === 'none'; },

	/**
	 * Initialize auth — called on app mount.
	 * Determines which page to show: setup, login, invite, or main app.
	 */
	async initialize() {
		authState = 'loading';

		try {
			// Wait for WebSocket connection
			await ws.waitUntilConnected(10000);

			// Read stored session token
			const storedToken = localStorage.getItem(SESSION_TOKEN_KEY);

			// If we have a stored token, try to authenticate
			if (storedToken) {
				try {
					const result = await ws.http('auth:login', { token: storedToken });
					currentUser = result.user;
					sessionToken = result.sessionToken;
					// Update stored token (may have been refreshed)
					localStorage.setItem(SESSION_TOKEN_KEY, result.sessionToken);
					// Set token on WS client for reconnection auth
					ws.setSessionToken(result.sessionToken);

					// Fetch auth mode and onboarding status from server
					const status = await ws.http('auth:status', {});
					authMode = status.authMode;

					// If onboarding not yet completed, show wizard instead of going to ready
					if (!status.onboardingComplete) {
						authState = 'setup';
						debug.log('auth', `Authenticated but onboarding pending: ${result.user.name}`);
						return;
					}

					authState = 'ready';
					debug.log('auth', `Authenticated: ${result.user.name} (${result.user.role}), authMode: ${authMode}`);
					return;
				} catch {
					// Token invalid or expired — clear and continue
					localStorage.removeItem(SESSION_TOKEN_KEY);
					sessionToken = null;
					debug.log('auth', 'Stored session token invalid, clearing');
				}
			}

			// Check if invite token is in URL hash
			const hash = window.location.hash;
			if (hash.startsWith('#invite/')) {
				authState = 'invite';
				return;
			}

			// Check server status
			const status = await ws.http('auth:status', {});
			authMode = status.authMode;

			if (!status.onboardingComplete) {
				if (status.needsSetup) {
					// Fresh install — show wizard
					authState = 'setup';
				} else if (authMode === 'none') {
					// No-auth mode, existing data — auto-login then show wizard
					await this.autoLoginNoAuth();
					authState = 'setup';
				} else {
					// With-auth mode, existing users, no session — need to login first
					// After login, the login() method will redirect to setup wizard
					authState = 'login';
				}
			} else if (authMode === 'none') {
				// Onboarding done, no-auth mode: auto-login
				await this.autoLoginNoAuth();
			} else {
				authState = 'login';
			}
		} catch (error) {
			debug.error('auth', 'Auth initialization failed:', error);
			try {
				const status = await ws.http('auth:status', {});
				authMode = status.authMode;
				authState = status.needsSetup ? 'setup' : 'login';
			} catch {
				authState = 'login';
			}
		}
	},

	/**
	 * Auto-login for no-auth mode (returning visitors).
	 */
	async autoLoginNoAuth() {
		const result = await ws.http('auth:auto-login-no-auth', {});
		currentUser = result.user;
		sessionToken = result.sessionToken;
		localStorage.setItem(SESSION_TOKEN_KEY, result.sessionToken);
		ws.setSessionToken(result.sessionToken);
		authState = 'ready';
		debug.log('auth', `No-auth auto-login: ${result.user.name}`);
	},

	/**
	 * Setup — create first admin account (with-auth mode).
	 */
	async setup(name: string) {
		const result = await ws.http('auth:setup', { name });
		currentUser = result.user;
		sessionToken = result.sessionToken;
		personalAccessToken = result.personalAccessToken;
		localStorage.setItem(SESSION_TOKEN_KEY, result.sessionToken);
		ws.setSessionToken(result.sessionToken);
		authMode = 'required';
		// Don't set authState to 'ready' yet — setup page shows PAT first
		debug.log('auth', `Admin setup complete: ${result.user.name}`);
	},

	/**
	 * Setup no-auth mode — create default admin, no PAT needed.
	 */
	async setupNoAuth() {
		const result = await ws.http('auth:setup-no-auth', {});
		currentUser = result.user;
		sessionToken = result.sessionToken;
		localStorage.setItem(SESSION_TOKEN_KEY, result.sessionToken);
		ws.setSessionToken(result.sessionToken);
		authMode = 'none';
		// Don't set authState to 'ready' yet — wizard continues to next step
		debug.log('auth', `No-auth setup complete: ${result.user.name}`);
	},

	/**
	 * Switch to with-auth mode mid-wizard (e.g. user changed selection after refresh).
	 * Regenerates PAT for the existing no-auth admin and updates authMode setting.
	 */
	async switchToWithAuth() {
		const { updateSystemSettings } = await import('$frontend/stores/features/settings.svelte');
		await updateSystemSettings({ authMode: 'required' });

		const result = await ws.http('auth:regenerate-pat', {});
		personalAccessToken = result.personalAccessToken;
		authMode = 'required';
		debug.log('auth', 'Switched to with-auth mode, PAT regenerated');
	},

	/**
	 * Switch to no-auth mode mid-wizard (e.g. user changed selection after refresh).
	 * Only updates the authMode setting; existing user remains unchanged.
	 */
	async switchToNoAuth() {
		const { updateSystemSettings } = await import('$frontend/stores/features/settings.svelte');
		await updateSystemSettings({ authMode: 'none' });

		authMode = 'none';
		debug.log('auth', 'Switched to no-auth mode');
	},

	/**
	 * Complete setup — transition to ready state after wizard is done.
	 * Saves onboardingComplete flag so wizard won't show again.
	 */
	async completeSetup() {
		personalAccessToken = null;

		// Save onboardingComplete to system settings
		try {
			const { updateSystemSettings } = await import('$frontend/stores/features/settings.svelte');
			await updateSystemSettings({ onboardingComplete: true });
		} catch {
			// Best-effort — if this fails, wizard may show again
			debug.warn('auth', 'Failed to save onboardingComplete flag');
		}

		authState = 'ready';
	},

	/**
	 * Login with a Personal Access Token (PAT).
	 */
	async login(token: string) {
		const result = await ws.http('auth:login', { token });
		currentUser = result.user;
		sessionToken = result.sessionToken;
		localStorage.setItem(SESSION_TOKEN_KEY, result.sessionToken);
		ws.setSessionToken(result.sessionToken);

		// Check if onboarding is pending
		const status = await ws.http('auth:status', {});
		authMode = status.authMode;
		if (!status.onboardingComplete) {
			authState = 'setup';
			debug.log('auth', `Logged in, onboarding pending: ${result.user.name}`);
			return;
		}

		authState = 'ready';
		debug.log('auth', `Logged in: ${result.user.name} (${result.user.role})`);
	},

	/**
	 * Accept invite — create account from invite token.
	 */
	async acceptInvite(inviteToken: string, name: string) {
		const result = await ws.http('auth:accept-invite', { inviteToken, name });
		currentUser = result.user;
		sessionToken = result.sessionToken;
		personalAccessToken = result.personalAccessToken;
		localStorage.setItem(SESSION_TOKEN_KEY, result.sessionToken);
		ws.setSessionToken(result.sessionToken);
		// Clear invite hash from URL
		window.location.hash = '';
		debug.log('auth', `Invite accepted: ${result.user.name}`);
	},

	/**
	 * Complete invite — transition to ready after user has copied PAT.
	 */
	completeInvite() {
		personalAccessToken = null;
		authState = 'ready';
	},

	/**
	 * Logout — clear session.
	 */
	async logout() {
		try {
			await ws.http('auth:logout', {});
		} catch {
			// Ignore errors during logout
		}
		currentUser = null;
		sessionToken = null;
		personalAccessToken = null;
		localStorage.removeItem(SESSION_TOKEN_KEY);
		ws.setSessionToken(null);
		authState = 'login';
		debug.log('auth', 'Logged out');
	},

	/**
	 * Logout all sessions (admin action — used when switching auth mode).
	 */
	async logoutAll() {
		try {
			await ws.http('auth:logout-all', {});
		} catch {
			// Ignore errors
		}
		currentUser = null;
		sessionToken = null;
		personalAccessToken = null;
		localStorage.removeItem(SESSION_TOKEN_KEY);
		ws.setSessionToken(null);
		authState = 'login';
		debug.log('auth', 'All sessions logged out');
	},

	/**
	 * Update display name.
	 */
	async updateName(newName: string) {
		const updated = await ws.http('auth:update-name', { newName });
		currentUser = updated;
		debug.log('auth', `Name updated: ${updated.name}`);
	},

	/**
	 * Regenerate Personal Access Token.
	 */
	async regeneratePAT(): Promise<string> {
		const result = await ws.http('auth:regenerate-pat', {});
		return result.personalAccessToken;
	}
};
