/**
 * Route Permission Configuration
 *
 * Defines which WebSocket routes can be reached before signing in. Clopen has
 * one account — the owner — so every other route only needs an authenticated
 * connection. Used by the auth gate in WSRouter.handleMessage().
 */

import { getAuthMode } from '$backend/settings/system-settings';

/** Routes that can be accessed WITHOUT authentication */
export const PUBLIC_ROUTES = new Set([
	'auth:status',
	'auth:login',
	'auth:setup',
	'auth:setup-no-auth',
	'auth:auto-login-no-auth',
	'auth:claim-device-code',
	'ws:set-context'
]);

/**
 * Check if a route action is allowed for the given auth state.
 * In no-auth mode, all routes are allowed (bypasses authentication check).
 */
export function checkRouteAccess(
	action: string,
	authenticated: boolean
): { allowed: boolean; error?: string } {
	// Public routes — always allowed
	if (PUBLIC_ROUTES.has(action)) {
		return { allowed: true };
	}

	// No-auth mode — bypass authentication for all routes
	if (getAuthMode() === 'none') {
		return { allowed: true };
	}

	if (!authenticated) {
		return { allowed: false, error: 'Authentication required' };
	}

	return { allowed: true };
}
