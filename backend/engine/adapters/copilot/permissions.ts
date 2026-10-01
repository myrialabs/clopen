/**
 * Clopen permission policy → Copilot permission decisions.
 *
 * Two layers enforce the same policy:
 *
 * 1. `managedSettings.permissions.deny` — the runtime refuses a denied tool
 *    before `onPermissionRequest` is ever consulted, so it holds even for tools
 *    that never surface a permission request. Only the `Shell`, `Write` and
 *    `Read` rule families exist: runtime 1.0.90 rejects session creation for any
 *    other family (`url`, `memory`, MCP server names were all tried), so a rule
 *    outside these three would break every turn rather than restrict it.
 *
 * 2. `onPermissionRequest` — covers what the managed layer cannot express:
 *    `url`, `memory` and MCP tools.
 *
 * Only deny rules are injected. A managed `allow` list must admit every
 * operation, including the families Clopen's policy never mentions, so
 * translating an allowlist would block tools the user allowed. Computing the
 * denied families through `isToolAllowed` gives the same result for an
 * allowlist without that risk.
 */

import type { ManagedSettings, PermissionRequest, PermissionRequestResult } from '@github/copilot-sdk';
import { hasAnyRestriction, isToolAllowed, type ResolvedPermissions } from '$backend/permissions';
import { debug } from '$shared/utils/logger';

/** Copilot permission kind → the managed rule family the runtime accepts for it. */
const MANAGED_RULE_FAMILIES: ReadonlyArray<readonly [kind: string, family: string]> = [
	['shell', 'Shell'],
	['write', 'Write'],
	['read', 'Read']
];

/**
 * Managed settings that deny every rule family the policy blocks, or undefined
 * when none is blocked. Must be passed on resume too: the runtime does not
 * persist injected settings, and omitting them clears the layer.
 */
export function buildCopilotManagedSettings(permissions: ResolvedPermissions): ManagedSettings | undefined {
	if (!hasAnyRestriction(permissions)) return undefined;
	const deny = MANAGED_RULE_FAMILIES
		.filter(([kind]) => !isToolAllowed(permissions, kind))
		.map(([, family]) => family);
	return deny.length > 0 ? { permissions: { deny } } : undefined;
}

/**
 * Map a Copilot permission request to the token the permission policy matches on.
 * MCP / custom tools carry a `toolName`; everything else is matched by its
 * operation `kind` (`shell` / `write` / `read` / `url` / `memory` / …), which is
 * why the Copilot builtin catalog lists kinds rather than tool names.
 */
function copilotPermissionToken(request: PermissionRequest): string {
	const named = (request as { toolName?: string }).toolName;
	return named && named.trim() ? named : request.kind;
}

/**
 * Enforce the resolved permission policy for one Copilot request. Returns a
 * reject decision for blocked tools, or null to fall through to auto-approve.
 */
export function enforceCopilotPermission(
	permissions: ResolvedPermissions,
	request: PermissionRequest
): PermissionRequestResult | null {
	const token = copilotPermissionToken(request);
	if (!isToolAllowed(permissions, token)) {
		debug.log('permissions', `⛔ Blocked tool "${token}" (Clopen permission policy)`);
		return { kind: 'reject', feedback: `Blocked by Clopen permission policy: ${token}` };
	}
	return null;
}
