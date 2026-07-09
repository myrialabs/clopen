/**
 * Profiles Handlers (Settings → Profiles) + per-session picker + project default.
 *
 *   - profiles:list / get / inventory / create / update / delete   (admin)
 *   - profiles:get-permissions / save-permissions                  (admin, Fase 3)
 *   - profiles:set-project-default                                 (admin)
 *   - profiles:available / project-default                         (non-admin)
 *
 * A Profile bundles references to existing artifacts (Skills, Commands,
 * Subagents, MCP Connectors) by slug plus an optional per-engine allow/deny
 * overlay. Nothing is duplicated — see `backend/profiles`. Admin gating lives in
 * `backend/auth/permissions.ts`; the picker/default-read routes stay non-admin
 * (choosing a profile for a session is a run choice like the model).
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { profileService } from '$backend/profiles';
import { permissionService } from '$backend/permissions';
import { projectQueries } from '$backend/database/queries';
import type { PermissionScope } from '$backend/database/queries';
import type { EngineType } from '$shared/types/unified';

const ITEMS_SCHEMA = t.Object({
	skill: t.Array(t.String()),
	command: t.Array(t.String()),
	subagent: t.Array(t.String()),
	mcp: t.Array(t.String())
});

const PROFILE_SCHEMA = t.Object({
	id: t.Number(),
	slug: t.String(),
	name: t.String(),
	description: t.String(),
	items: ITEMS_SCHEMA,
	itemCount: t.Number(),
	createdAt: t.String(),
	updatedAt: t.String()
});

const ITEM_INPUT_SCHEMA = t.Array(t.Object({
	artifactType: t.Union([t.Literal('skill'), t.Literal('command'), t.Literal('subagent'), t.Literal('mcp')]),
	ref: t.String()
}));

const INVENTORY_ENTRY = t.Array(t.Object({ slug: t.String(), name: t.String(), enabled: t.Boolean() }));

const PERMISSION_OVERLAY_SCHEMA = t.Object({
	engine: t.String(),
	allow: t.Array(t.String()),
	deny: t.Array(t.String())
});

export const profilesCrudHandler = createRouter()
	.http('profiles:list', {
		data: t.Object({}),
		response: t.Object({ profiles: t.Array(PROFILE_SCHEMA) })
	}, () => {
		debug.log('path', 'profiles:list');
		return { profiles: profileService.list() };
	})
	.http('profiles:get', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ profile: PROFILE_SCHEMA })
	}, ({ data }) => {
		debug.log('path', `profiles:get ${data.id}`);
		const profile = profileService.get(data.id);
		if (!profile) throw new Error('Profile not found');
		return { profile };
	})
	.http('profiles:inventory', {
		data: t.Object({}),
		response: t.Object({ skill: INVENTORY_ENTRY, command: INVENTORY_ENTRY, subagent: INVENTORY_ENTRY, mcp: INVENTORY_ENTRY })
	}, () => {
		debug.log('path', 'profiles:inventory');
		return profileService.inventory();
	})
	.http('profiles:create', {
		data: t.Object({ name: t.String(), description: t.String(), items: ITEM_INPUT_SCHEMA }),
		response: t.Object({ profile: PROFILE_SCHEMA })
	}, ({ data }) => {
		debug.log('path', `profiles:create ${data.name}`);
		if (!data.name.trim()) throw new Error('A profile name is required');
		return { profile: profileService.create(data.name.trim(), data.description, data.items) };
	})
	.http('profiles:update', {
		data: t.Object({ id: t.Number(), name: t.String(), description: t.String(), items: ITEM_INPUT_SCHEMA }),
		response: t.Object({ profile: PROFILE_SCHEMA })
	}, ({ data }) => {
		debug.log('path', `profiles:update ${data.id}`);
		if (!data.name.trim()) throw new Error('A profile name is required');
		return { profile: profileService.update(data.id, data.name.trim(), data.description, data.items) };
	})
	.http('profiles:delete', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ success: t.Boolean() })
	}, ({ data }) => {
		debug.log('path', `profiles:delete ${data.id}`);
		profileService.remove(data.id);
		return { success: true };
	})

	// ── Per-profile permission overlay (Fase 3) ────────────────────────────────
	.http('profiles:get-permissions', {
		data: t.Object({ id: t.Number() }),
		response: t.Object({ sets: t.Array(PERMISSION_OVERLAY_SCHEMA) })
	}, ({ data }) => {
		debug.log('path', `profiles:get-permissions ${data.id}`);
		const sets = permissionService.listForProfile(data.id).map(s => ({ engine: s.engine, allow: s.allow, deny: s.deny }));
		return { sets };
	})
	.http('profiles:save-permissions', {
		data: t.Object({ id: t.Number(), engine: t.String(), allow: t.Array(t.String()), deny: t.Array(t.String()) }),
		response: t.Object({ success: t.Boolean() })
	}, ({ data }) => {
		debug.log('path', `profiles:save-permissions ${data.id}/${data.engine}`);
		permissionService.save('profile' as PermissionScope, null, data.id, data.engine as EngineType, data.allow, data.deny);
		return { success: true };
	})

	// ── Project default (shared) ───────────────────────────────────────────────
	.http('profiles:set-project-default', {
		data: t.Object({ projectId: t.String(), profileId: t.Union([t.Number(), t.Null()]) }),
		response: t.Object({ success: t.Boolean() })
	}, ({ data }) => {
		debug.log('path', `profiles:set-project-default ${data.projectId}`);
		projectQueries.setDefaultProfileId(data.projectId, data.profileId);
		return { success: true };
	})

	// ── Non-admin: per-session picker + default read ───────────────────────────
	.http('profiles:available', {
		data: t.Object({}),
		response: t.Object({
			profiles: t.Array(t.Object({ id: t.Number(), slug: t.String(), name: t.String(), description: t.String() }))
		})
	}, () => {
		debug.log('path', 'profiles:available');
		return { profiles: profileService.available() };
	})
	.http('profiles:project-default', {
		data: t.Object({ projectId: t.String() }),
		response: t.Object({ profileId: t.Union([t.Number(), t.Null()]) })
	}, ({ data }) => {
		debug.log('path', `profiles:project-default ${data.projectId}`);
		return { profileId: projectQueries.getDefaultProfileId(data.projectId) };
	});
