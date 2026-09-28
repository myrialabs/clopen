/**
 * Git identities — public facade.
 *
 * Three seams the rest of Clopen uses:
 *  - `gitIdentityService` — CRUD for the Settings surface.
 *  - `resolveGitEnv` — the one call every git-running surface makes to get the
 *    environment fragment for a (project, user). Panel, engine, and terminal all
 *    go through it so they cannot drift apart.
 *  - `buildGitIdentityEnv` / `remoteHost` — the primitives, for tests and the
 *    credential helper.
 */

import { gitIdentityQueries } from '$backend/database/queries';
import { buildGitIdentityEnv, remoteHost } from './env';
import { helperCommand, pickCredentialIdentity, resolveIdentity, toEnvIdentity } from './resolve';
import { toDTO } from './service';
import type { ResolvedGitIdentity } from '$shared/types/git-identity';

export { gitIdentityService, toDTO } from './service';
export { buildGitIdentityEnv, buildGitConfigPairs, remoteHost } from './env';
export type { GitEnvIdentity, HelperCommand } from './env';
export { resolveIdentity, pickCredentialIdentity, toEnvIdentity, helperCommand } from './resolve';
export { identityKeyPath, removeKeyFiles, writeKeyFile } from './keys';
export { writeScopeConfig, removeScopeConfig, refreshScopeConfigsForUser, scopeConfigPath } from './scope-config';
export { readMachineIdentity, syncLocalMachineIdentity } from './import-local';

/**
 * The environment fragment for a (project, user), optionally scoped to a remote.
 *
 * `remoteUrl` is what lets a fork workflow work: the host it points at decides
 * which identity's credential answers, while attribution always comes from the
 * project's own identity. Callers that are not talking to a remote (a commit, a
 * rebase) leave it out and get attribution only.
 *
 * Returns `{}` when the user has no identity, so every call site can merge the
 * result unconditionally.
 */
export function resolveGitEnv(
	projectId: string,
	userId: string,
	remoteUrl?: string | null
): Record<string, string> {
	const { row } = resolveIdentity(projectId, userId);
	if (!row) return {};

	const host = remoteUrl ? remoteHost(remoteUrl) : null;
	const credential = pickCredentialIdentity(userId, host, row);
	return buildGitIdentityEnv(toEnvIdentity(row, credential), helperCommand());
}

/**
 * What the UI shows above the commit box: who this will be committed as, and
 * whether that was chosen for this project or inherited.
 */
export function describeIdentity(
	projectId: string,
	userId: string,
	remoteUrl?: string | null
): ResolvedGitIdentity {
	const { row, source } = resolveIdentity(projectId, userId);
	if (!row) return { identity: null, source: 'none', credentialIdentity: null };

	const host = remoteUrl ? remoteHost(remoteUrl) : null;
	const credential = pickCredentialIdentity(userId, host, row);

	return {
		identity: toDTO(row),
		source,
		// Only reported when it differs, so the UI can stay quiet in the common
		// case and speak up exactly when a second account is in play.
		credentialIdentity: credential && credential.id !== row.id ? toDTO(credential) : null
	};
}

/** Every identity a user owns, as rows — for the credential helper. */
export function identitiesOf(userId: string) {
	return gitIdentityQueries.listByUser(userId);
}
