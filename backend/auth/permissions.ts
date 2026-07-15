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
	// Auth session controls with global impact.
	'auth:logout-all',
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
	'settings:update-system',
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
	'engine:opencode-provider-update',
	'engine:opencode-provider-update-options',
	'engine:opencode-provider-fetch-models',
	'engine:opencode-account-add',
	'engine:opencode-account-switch',
	'engine:opencode-account-delete',
	'engine:opencode-account-rename',
	'engine:opencode-server-restart',
	'engine:opencode-models-dev-fetch',
	'engine:restart-all',
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
	'tunnel:local:stop',
	// External MCP — installing/removing servers from the official registry is a
	// global, system-wide operation (it applies to every engine and project), so
	// the whole surface is admin-only, mirroring System Tools and Engines.
	'mcp:catalog',
	'mcp:list',
	'mcp:parse-config',
	'mcp:install',
	'mcp:toggle',
	'mcp:update-config',
	'mcp:uninstall',
	'mcp:status',
	'mcp:oauth-start',
	'mcp:oauth-complete',
	// Per-tool control + inspector — introspects/filters an installed server's
	// tools and can invoke them, so it stays within the admin-only MCP surface.
	'mcp:tools',
	'mcp:set-tool-overrides',
	'mcp:call-tool',
	// Agent Skills — creating/importing/installing skills writes to the shared
	// canonical store and applies to every engine, so the whole surface is
	// admin-only, mirroring MCP and System Tools.
	'skills:list',
	'skills:get',
	'skills:create',
	'skills:update',
	'skills:parse-import',
	'skills:import',
	'skills:toggle',
	'skills:delete',
	'skills:catalog',
	'skills:install',
	// Custom Commands — same shared-store rationale as Skills; admin-only surface.
	'commands:list',
	'commands:get',
	'commands:create',
	'commands:update',
	'commands:parse-import',
	'commands:import',
	'commands:toggle',
	'commands:delete',
	'commands:detect',
	// Subagents — shared canonical store applied to every engine; admin-only.
	'subagents:list',
	'subagents:get',
	'subagents:create',
	'subagents:update',
	'subagents:parse-import',
	'subagents:import',
	'subagents:toggle',
	'subagents:delete',
	'subagents:detect',
	// Project Instructions — writes managed regions into engine memory files; admin-only.
	'instructions:get-global',
	'instructions:save-global',
	'instructions:get-project',
	'instructions:save-project',
	// Permissions — per-engine tool allow/deny applied to every engine/project;
	// same shared-store rationale as Skills/MCP, admin-only surface.
	'permissions:list',
	'permissions:inventory',
	'permissions:save',
	// AI authoring of artifacts — part of the admin artifact editors.
	'artifacts:generate',
	// Profiles — reusable artifact bundles applied to every collaborator's
	// sessions; same shared-store rationale as Skills/MCP, admin-only surface.
	// (profiles:available / profiles:project-default stay non-admin — choosing a
	// profile for a session is a run choice like the model.)
	'profiles:list',
	'profiles:get',
	'profiles:inventory',
	'profiles:create',
	'profiles:update',
	'profiles:delete',
	'profiles:get-permissions',
	'profiles:save-permissions',
	'profiles:set-project-default'
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

