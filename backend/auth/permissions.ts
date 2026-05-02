/**
 * Route Permission Configuration
 *
 * Defines which WebSocket routes require authentication and which require admin role.
 * Used by the auth gate in WSRouter.handleMessage().
 */

import { getAuthMode } from './auth-service';

/** Routes that can be accessed WITHOUT authentication */
export const PUBLIC_ROUTES = new Set([
	'auth:status',
	'auth:login',
	'auth:setup',
	'auth:setup-no-auth',
	'auth:auto-login-no-auth',
	'auth:accept-invite',
	'auth:validate-invite',
	'ws:set-context'
]);

/** Routes that require admin role */
export const ADMIN_ONLY_ROUTES = new Set([
	'auth:create-invite',
	'auth:list-invites',
	'auth:revoke-invite',
	'auth:list-users',
	'auth:remove-user',
	'settings:update',
	'settings:update-batch',
	'system:run-update',
	'system:clear-data',
	// System Tools — binary installation is an admin-only operation.
	'system-tools:status',
	'system-tools:status-all',
	'system-tools:install-start',
	'system-tools:install-cancel',
	'system-tools:install-session'
]);

/**
 * Check if a route action is allowed for the given auth state.
 * In no-auth mode, all routes are allowed (bypasses authentication check).
 */
export function checkRouteAccess(
	action: string,
	authenticated: boolean,
	role: string | null
): { allowed: boolean; error?: string } {
	// Public routes — always allowed
	if (PUBLIC_ROUTES.has(action)) {
		return { allowed: true };
	}

	// No-auth mode — bypass authentication for all routes
	if (getAuthMode() === 'none') {
		return { allowed: true };
	}

	// Must be authenticated for everything else
	if (!authenticated) {
		return { allowed: false, error: 'Authentication required' };
	}

	// Admin-only routes
	if (ADMIN_ONLY_ROUTES.has(action) && role !== 'admin') {
		return { allowed: false, error: 'Admin access required' };
	}

	// All other routes — any authenticated user
	return { allowed: true };
}

