/**
 * User Store - Svelte 5 Runes
 * Manages anonymous user state and provides reactive updates
 */

import { getOrCreateAnonymousUser, updateAnonymousUserName, getCurrentAnonymousUser, type AnonymousUser } from '$shared/utils/anonymous-user';
import { debug } from '$shared/utils/logger';
import ws from '$frontend/lib/utils/ws';

// User state - initialize with null, will be properly set after async load
let currentUser = $state<AnonymousUser | null>(null);
let isInitializing = $state<boolean>(false);

// User store
export const userStore = {
	get currentUser() {
		return currentUser;
	},

	get isInitializing() {
		return isInitializing;
	},

	// Initialize user (called on app start)
	async initialize() {
		if (typeof window === 'undefined') {
			debug.warn('user', 'Cannot initialize user on server side');
			return;
		}

		if (isInitializing) {
			debug.warn('user', 'User initialization already in progress');
			return;
		}

		isInitializing = true;

		try {
			// First check if user already exists in localStorage (fast path)
			const existingUser = getCurrentAnonymousUser();
			if (existingUser) {
				currentUser = existingUser;
				// Sync user context with WebSocket (for user-targeted broadcasting)
				// IMPORTANT: Must await to ensure server has context before other operations
				await ws.setUser(existingUser.id);
				debug.log('user', '✅ Loaded existing user from localStorage:', existingUser.name);
			} else {
				// Generate new user from server
				debug.log('user', 'No existing user, generating from server...');
				const newUser = await getOrCreateAnonymousUser();
				currentUser = newUser;
				// Sync user context with WebSocket
				// IMPORTANT: Must await to ensure server has context before other operations
				if (newUser) {
					await ws.setUser(newUser.id);
				}
			}
		} catch (error) {
			debug.error('user', 'Failed to initialize user:', error);
		} finally {
			isInitializing = false;
		}
	},

	// Update user name
	async updateName(newName: string): Promise<boolean> {
		if (typeof window === 'undefined') {
			return false;
		}

		try {
			const updatedUser = await updateAnonymousUserName(newName);

			if (updatedUser) {
				currentUser = updatedUser;
				return true;
			}

			return false;
		} catch (error) {
			debug.error('user', 'Failed to update user name:', error);
			return false;
		}
	},

	// Refresh user from localStorage
	refresh() {
		if (typeof window !== 'undefined') {
			const user = getCurrentAnonymousUser();
			if (user) {
				currentUser = user;
				debug.log('user', '✅ Refreshed user from localStorage:', user.name);
			}
		}
	}
};