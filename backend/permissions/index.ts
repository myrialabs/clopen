/**
 * Permissions — public facade. Settings → Permissions manages per-engine tool
 * allow/deny rules; enforcement is a runtime check each engine adapter performs
 * (see `resolvePermissionsFromDb` + `isToolAllowed`) at whichever surface fires
 * for every tool call — for Claude that is a `PreToolUse` hook, because its
 * permission callback is shadowed under `bypassPermissions`.
 */

export {
	permissionService,
	resolvePermissionsFromDb,
	excludedBuiltinTools,
	toArtifactEngine,
	type PermissionSetDTO,
	type PermissionInventory,
	type EngineInventory,
	type ArtifactEngineKey
} from './service';
export {
	isToolAllowed,
	hasAnyRestriction,
	matchesPattern,
	matchesAny,
	mergePermissions,
	pickEngineSet,
	EMPTY_PERMISSIONS,
	type ResolvedPermissions
} from './resolve';
export { syncPermissions } from './materialize';
