/**
 * Permission resolution — the pure decision logic behind Settings → Permissions.
 *
 * A permission set is a pair of tool-pattern lists (`allow` + `deny`) stored per
 * `(scope, project, engine)`. This module answers one question at the engine's
 * auto-approve hook: *is this tool allowed to run?* The stored sets are enforced
 * at runtime (each engine consults {@link isToolAllowed} in the hook it already
 * uses to auto-approve tools — see the adapters), which is why enforcement is
 * real even though every engine otherwise auto-approves.
 *
 * Resolution across the two scopes (documented in migration 049):
 *   - deny  = global.deny ∪ project.deny        (deny always adds restriction)
 *   - allow = project.allow if non-empty, else global.allow
 *   - deny WINS over allow; an empty allow means "all tools except deny".
 *
 * Everything here is pure (no DB) so it is unit-tested directly; the DB-reading
 * wrapper lives in {@link resolvePermissionsFromDb} (service.ts).
 */

import type { EngineType } from '$shared/types/unified';
import type { PermissionSet } from '$backend/database/queries';

export interface ResolvedPermissions {
	allow: string[];
	deny: string[];
}

export const EMPTY_PERMISSIONS: ResolvedPermissions = { allow: [], deny: [] };

/**
 * Match a tool name against one pattern. Supports an exact name or a single
 * trailing `*` wildcard (e.g. `mcp__github__*`). Kept deliberately simple and
 * consistent across engines — argument-scoped rules (Claude's `Bash(git:*)`) are
 * intentionally out of scope for v1.
 */
export function matchesPattern(pattern: string, tool: string): boolean {
	if (pattern === tool) return true;
	if (pattern.endsWith('*')) {
		return tool.startsWith(pattern.slice(0, -1));
	}
	return false;
}

/** True when `tool` matches ANY pattern in the list. */
export function matchesAny(patterns: string[], tool: string): boolean {
	return patterns.some(p => matchesPattern(p, tool));
}

/**
 * Merge a global and a project set into the effective allow/deny for one engine.
 * `undefined` means "no rule at that scope".
 */
export function mergePermissions(
	global: ResolvedPermissions | undefined,
	project: ResolvedPermissions | undefined
): ResolvedPermissions {
	const deny = Array.from(new Set([...(global?.deny ?? []), ...(project?.deny ?? [])]));
	// A project allowlist, when present, replaces the global one (tightening a
	// specific project); otherwise the global allowlist applies. Unioning allow
	// lists would loosen rather than scope, so we deliberately override.
	const allow = project?.allow && project.allow.length > 0 ? project.allow : (global?.allow ?? []);
	return { allow, deny };
}

/**
 * Merge an ordered list of scope layers (least → most specific, e.g.
 * global → project → profile) into one effective policy.
 *   - `deny`  unions across every layer (deny always tightens);
 *   - `allow` uses the MOST specific non-empty allowlist (a more specific scope's
 *     allowlist replaces a broader one, mirroring {@link mergePermissions}).
 * `undefined`/absent layers are skipped.
 */
export function mergeLayers(layers: (ResolvedPermissions | undefined)[]): ResolvedPermissions {
	const denySet = new Set<string>();
	let allow: string[] = [];
	for (const layer of layers) {
		if (!layer) continue;
		for (const d of layer.deny) denySet.add(d);
		if (layer.allow.length > 0) allow = layer.allow; // most specific non-empty wins
	}
	return { allow, deny: Array.from(denySet) };
}

/**
 * The core decision. Deny wins; then, if an allowlist exists, the tool must match
 * it; otherwise everything not denied is allowed.
 */
export function isToolAllowed(resolved: ResolvedPermissions, tool: string): boolean {
	if (matchesAny(resolved.deny, tool)) return false;
	if (resolved.allow.length > 0 && !matchesAny(resolved.allow, tool)) return false;
	return true;
}

/** Whether a resolved set imposes any restriction at all (used to skip work). */
export function hasAnyRestriction(resolved: ResolvedPermissions): boolean {
	return resolved.allow.length > 0 || resolved.deny.length > 0;
}

/**
 * Pick the set for one engine out of a scope's rows (each row is one engine).
 * Pure so it can be tested without a DB.
 */
export function pickEngineSet(sets: PermissionSet[], engine: EngineType): ResolvedPermissions | undefined {
	const row = sets.find(s => s.engine === engine);
	return row ? { allow: row.allow, deny: row.deny } : undefined;
}
