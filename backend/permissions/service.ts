/**
 * Permission service — bridges the `permission_sets` table and Settings →
 * Permissions, and resolves the effective allow/deny for one engine at stream
 * start (consumed by each adapter's auto-approve hook).
 *
 * The inventory (what the UI offers as allow/deny targets) is the union of:
 *   - built-in engine tools ({@link ENGINE_BUILTIN_TOOLS}),
 *   - live MCP tools from enabled Connectors (best-effort; a server that fails to
 *     connect is simply skipped),
 *   - tool names named by subagent allowlists.
 */

import type { EngineType } from '$shared/types/unified';
import { ENGINES } from '$shared/constants/engines';
import { ENGINE_BUILTIN_TOOLS, ENGINE_TOOLS_BEST_EFFORT } from '$shared/constants/engine-tools';
import { permissionSetQueries, subagentQueries, type PermissionScope } from '$backend/database/queries';
import { getEnabledExternalServers, listExternalServerTools } from '$backend/mcp';
import { isBestEffortTarget, parseEngineMap } from '$backend/artifacts';
import { debug } from '$shared/utils/logger';
import { mergeLayers, pickEngineSet, isToolAllowed, hasAnyRestriction, type ResolvedPermissions } from './resolve';

/** Engine keys used by the artifact matrix (config-dir slugs). */
export type ArtifactEngineKey = 'claude' | 'codex' | 'copilot' | 'qwen' | 'opencode' | 'pi';

const ENGINE_TYPE_TO_ARTIFACT: Record<EngineType, ArtifactEngineKey> = {
	'claude-code': 'claude',
	codex: 'codex',
	copilot: 'copilot',
	qwen: 'qwen',
	opencode: 'opencode',
	pi: 'pi'
};

export function toArtifactEngine(engine: EngineType): ArtifactEngineKey {
	return ENGINE_TYPE_TO_ARTIFACT[engine];
}

/**
 * The engine's built-in tools that a policy blocks (denied, or excluded by a
 * non-empty allowlist). Used by adapters whose per-call permission hook does NOT
 * fire for every tool (e.g. Qwen's `canUseTool` only runs for write tools) — the
 * blocked names are passed to the SDK's `excludeTools` so read-only tools are
 * hidden too. MCP tools are handled separately at the bridge, so only the
 * built-in catalog is considered here.
 */
export function excludedBuiltinTools(permissions: ResolvedPermissions, engine: EngineType): string[] {
	if (!hasAnyRestriction(permissions)) return [];
	return (ENGINE_BUILTIN_TOOLS[engine] ?? []).filter(name => !isToolAllowed(permissions, name));
}

/**
 * Effective allow/deny for one engine, merging the global set with the project
 * set (if a project is streaming) and the active profile's overlay (if a profile
 * is active). Layers apply least → most specific (global → project → profile);
 * deny unions across all, the most specific allowlist wins. Reads the DB; the
 * merge logic itself is pure (see resolve.ts).
 */
export function resolvePermissionsFromDb(engine: EngineType, projectId?: string, profileId?: number): ResolvedPermissions {
	const global = pickEngineSet(permissionSetQueries.getGlobal(), engine);
	const project = projectId
		? pickEngineSet(permissionSetQueries.getForProject(projectId), engine)
		: undefined;
	const profile = profileId != null
		? pickEngineSet(permissionSetQueries.getForProfile(profileId), engine)
		: undefined;
	return mergeLayers([global, project, profile]);
}

/** One engine's stored rules for the Settings UI (scopes flattened by caller). */
export interface PermissionSetDTO {
	scope: PermissionScope;
	projectId: string | null;
	profileId: number | null;
	engine: EngineType;
	allow: string[];
	deny: string[];
}

export interface EngineInventory {
	engine: EngineType;
	/** Built-in tool names for this engine. */
	builtin: string[];
	/** Whether this engine's builtin names / enforcement are best-effort. */
	bestEffort: boolean;
}

export interface PermissionInventory {
	engines: EngineInventory[];
	/** Live MCP tool names (namespaced), shared across engines. */
	mcp: string[];
	/** Tool names referenced by subagent allowlists. */
	subagent: string[];
}

export const permissionService = {
	/** All stored global/project permission sets for the admin listing. Profile
	 *  overlays are excluded — they are managed in the profile editor. */
	list(projectId?: string): PermissionSetDTO[] {
		const rows = projectId
			? [...permissionSetQueries.getGlobal(), ...permissionSetQueries.getForProject(projectId)]
			: permissionSetQueries.getAll();
		return rows
			.filter(r => r.scope !== 'profile')
			.map(r => ({ scope: r.scope, projectId: r.projectId, profileId: r.profileId, engine: r.engine, allow: r.allow, deny: r.deny }));
	},

	/** One profile's per-engine allow/deny overlay, for the profile editor. */
	listForProfile(profileId: number): PermissionSetDTO[] {
		return permissionSetQueries.getForProfile(profileId)
			.map(r => ({ scope: r.scope, projectId: r.projectId, profileId: r.profileId, engine: r.engine, allow: r.allow, deny: r.deny }));
	},

	/** Upsert one (scope, project, profile, engine) rule set. Empty lists delete the row. */
	save(
		scope: PermissionScope,
		projectId: string | null,
		profileId: number | null,
		engine: EngineType,
		allow: string[],
		deny: string[]
	): void {
		const clean = (list: string[]) => Array.from(new Set(list.map(s => s.trim()).filter(Boolean)));
		permissionSetQueries.save(scope, projectId, profileId, engine, clean(allow), clean(deny));
		const suffix = scope === 'project' && projectId ? `/${projectId.slice(0, 8)}` : scope === 'profile' && profileId ? `/p${profileId}` : '';
		debug.log('permissions', `🔐 Saved permission set: ${engine}/${scope}${suffix}`);
	},

	/** Tool inventory offered by the UI as allow/deny targets. */
	async inventory(): Promise<PermissionInventory> {
		const engines: EngineInventory[] = ENGINES.map(e => ({
			engine: e.type,
			builtin: ENGINE_BUILTIN_TOOLS[e.type] ?? [],
			bestEffort: ENGINE_TOOLS_BEST_EFFORT[e.type] ?? isBestEffortTarget('permission', toArtifactEngine(e.type))
		}));

		// Live MCP tools — best-effort: skip any server we can't connect to.
		const mcpSet = new Set<string>();
		for (const server of getEnabledExternalServers()) {
			try {
				const tools = await listExternalServerTools(server.slug);
				// Claude-style namespaced name (`mcp__<namespace>__<tool>`) — the form
				// the authoritative Claude hook sees. MCP exposure is primarily
				// governed by Connectors (Prompt 2); these are a belt-and-suspenders
				// deny target.
				for (const tool of tools) mcpSet.add(`mcp__${server.namespace}__${tool.name}`);
			} catch (error) {
				debug.warn('permissions', `Inventory: could not list tools for MCP "${server.slug}" (skipping):`, error);
			}
		}

		// Subagent allowlists — the tools individual subagents are scoped to
		// (tools are per-engine now; union every engine's allowlist).
		const subagentSet = new Set<string>();
		for (const row of subagentQueries.getAll()) {
			for (const list of Object.values(parseEngineMap(row.tools_by_engine))) {
				for (const name of list.split(/[\s,]+/).map(t => t.trim()).filter(Boolean)) {
					subagentSet.add(name);
				}
			}
		}

		return {
			engines,
			mcp: Array.from(mcpSet).sort(),
			subagent: Array.from(subagentSet).sort()
		};
	}
};
