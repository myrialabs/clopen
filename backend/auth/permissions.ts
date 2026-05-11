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
	'auth:list-user-projects',
	'auth:assign-project',
	'auth:unassign-project',
	// Project lifecycle — members can only access projects they are assigned to
	// by an admin. Create/delete remain admin-only operations.
	'projects:create',
	'projects:delete',
	'settings:update',
	'settings:update-batch',
	'system:run-update',
	'system:clear-data',
	// System Tools — binary installation is an admin-only operation.
	'system-tools:status',
	'system-tools:status-all',
	'system-tools:install-start',
	'system-tools:install-cancel',
	'system-tools:install-session',
	// Engine — account/provider mutations are global system credentials and
	// must only be changed by admins. Read-only routes (status, *-list) stay
	// open so any authenticated user can see what is configured.
	'engine:claude-accounts-switch',
	'engine:claude-accounts-delete',
	'engine:claude-accounts-rename',
	'engine:claude-account-setup-start',
	'engine:claude-account-setup-submit',
	'engine:claude-account-setup-cancel',
	'engine:codex-accounts-add-api-key',
	'engine:codex-accounts-switch',
	'engine:codex-accounts-delete',
	'engine:codex-accounts-rename',
	'engine:codex-account-setup-start',
	'engine:codex-account-setup-cancel',
	'engine:codex-restart',
	'engine:copilot-accounts-add',
	'engine:copilot-accounts-switch',
	'engine:copilot-accounts-delete',
	'engine:copilot-accounts-rename',
	'engine:copilot-restart',
	'engine:qwen-accounts-add',
	'engine:qwen-accounts-switch',
	'engine:qwen-accounts-delete',
	'engine:qwen-accounts-rename',
	'engine:opencode-provider-add',
	'engine:opencode-provider-remove',
	'engine:opencode-provider-toggle',
	'engine:opencode-provider-update-options',
	'engine:opencode-account-add',
	'engine:opencode-account-switch',
	'engine:opencode-account-delete',
	'engine:opencode-account-rename',
	'engine:opencode-server-restart',
	'engine:opencode-models-dev-fetch',
	// Tunnel — remote/local management mutates global Cloudflare credentials,
	// cloudflared auth, and ingress rules. Quick Tunnel is ephemeral and stays
	// open. Read-only routes (status, *-list, ingress, auth-status) stay open so
	// any authenticated user can see what is active.
	'tunnel:remote:config:add',
	'tunnel:remote:config:remove',
	'tunnel:remote:start',
	'tunnel:remote:stop',
	'tunnel:local:login-start',
	'tunnel:local:login-cancel',
	'tunnel:local:logout',
	'tunnel:local:set-zone',
	'tunnel:local:create',
	'tunnel:local:delete',
	'tunnel:local:ingress:add',
	'tunnel:local:ingress:remove',
	'tunnel:local:start',
	'tunnel:local:stop'
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

