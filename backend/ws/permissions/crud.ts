/**
 * Permissions Handlers (Settings → Permissions)
 *
 *   - permissions:list      — stored allow/deny sets (global + optional project)
 *   - permissions:inventory — tool inventory offered as allow/deny targets
 *   - permissions:save      — upsert one (scope, project, engine) rule set
 *
 * Rules are enforced at each engine's runtime auto-approve hook (real on
 * Claude/Qwen/Copilot; best-effort/unverified on OpenCode/Codex). Mutations are
 * admin-gated in `backend/auth/permissions.ts`. Changes take effect on the next
 * chat stream.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { permissionService } from '$backend/permissions';
import type { PermissionScope } from '$backend/database/queries';
import type { EngineType } from '$shared/types/unified';

const PERMISSION_SET_SCHEMA = t.Object({
	scope: t.Union([t.Literal('global'), t.Literal('project'), t.Literal('profile')]),
	projectId: t.Union([t.String(), t.Null()]),
	profileId: t.Union([t.Number(), t.Null()]),
	engine: t.String(),
	allow: t.Array(t.String()),
	deny: t.Array(t.String())
});

const INVENTORY_SCHEMA = t.Object({
	engines: t.Array(t.Object({
		engine: t.String(),
		builtin: t.Array(t.String()),
		bestEffort: t.Boolean()
	})),
	mcp: t.Array(t.String()),
	subagent: t.Array(t.String())
});

export const permissionsCrudHandler = createRouter()
	.http('permissions:list', {
		data: t.Object({ projectId: t.Optional(t.String()) }),
		response: t.Object({ sets: t.Array(PERMISSION_SET_SCHEMA) })
	}, async ({ data }) => {
		debug.log('path', 'permissions:list');
		return { sets: permissionService.list(data.projectId) };
	})
	.http('permissions:inventory', {
		data: t.Object({}),
		response: INVENTORY_SCHEMA
	}, async () => {
		debug.log('path', 'permissions:inventory');
		return permissionService.inventory();
	})
	.http('permissions:save', {
		data: t.Object({
			scope: t.Union([t.Literal('global'), t.Literal('project')]),
			projectId: t.Optional(t.Union([t.String(), t.Null()])),
			engine: t.String(),
			allow: t.Array(t.String()),
			deny: t.Array(t.String())
		}),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		debug.log('path', `permissions:save ${data.engine}/${data.scope}`);
		const projectId = data.scope === 'project' ? (data.projectId ?? null) : null;
		if (data.scope === 'project' && !projectId) throw new Error('A project is required for project-scoped permissions');
		// This admin endpoint only manages global/project scope. Profile-scoped
		// permission overlays are edited through the profiles editor (profiles:save-permissions).
		permissionService.save(data.scope as PermissionScope, projectId, null, data.engine as EngineType, data.allow, data.deny);
		return { success: true };
	});
