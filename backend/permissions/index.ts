/**
 * Permissions — public facade. Settings → Permissions manages per-engine tool
 * allow/deny rules; enforcement is a runtime hook each engine adapter consults
 * at its auto-approve point (see `resolvePermissionsFromDb` + `isToolAllowed`).
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
