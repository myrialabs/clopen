/**
 * Git identities — public facade.
 *
 * Three seams the rest of Clopen uses:
 *  - `gitIdentityService` — CRUD for the Settings surface.
 *  - `resolveGitEnv` — the one call every git-running surface makes to get the
 *    environment fragment for a project. Panel, engine, and terminal all
 *    go through it so they cannot drift apart.
 *  - `buildGitIdentityEnv` / `remoteHost` — the primitives, for tests and the
 *    credential helper.
 */

import { buildGitIdentityEnv, buildHostedCredentialPairs, remoteHost } from './env';
import { helperCommand, pickCredentialIdentity, resolveIdentity, toEnvIdentity } from './resolve';
import { toDTO } from './service';
import { hostAccounts } from '$backend/git-hosts/accounts';
import type { GitIdentityRow } from '$backend/database/queries';
import { debug } from '$shared/utils/logger';
import type { ResolvedGitIdentity } from '$shared/types/git-identity';

export { gitIdentityService, toDTO } from './service';
export { buildGitIdentityEnv, buildGitConfigPairs, buildHostedCredentialPairs, remoteHost } from './env';
export type { GitEnvIdentity, HelperCommand } from './env';
export { resolveIdentity, pickCredentialIdentity, toEnvIdentity, helperCommand } from './resolve';
export { identityKeyPath, removeKeyFiles, writeKeyFile } from './keys';
export { writeScopeConfig, removeScopeConfig, refreshScopeConfigs, scopeConfigPath } from './scope-config';
export { readMachineIdentity, syncLocalMachineIdentity } from './import-local';

/**
 * The environment fragment for a project, optionally scoped to a remote.
 *
 * `remoteUrl` is what lets a fork workflow work: the host it points at decides
 * which identity's credential answers, while attribution always comes from the
 * project's own identity. Callers that are not talking to a remote (a commit, a
 * rebase) leave it out and get attribution only.
 *
 * Returns `{}` when there is no identity, so every call site can merge the
 * result unconditionally.
 */
export function resolveGitEnv(projectId: string, remoteUrl?: string | null): Record<string, string> {
	const { row } = resolveIdentity(projectId);
	const host = remoteUrl ? remoteHost(remoteUrl) : null;
	const credential = row ? pickCredentialIdentity(host, row) : null;
	const hosted = buildHostedCredentialPairs(hostedHosts(projectId, row), projectId, helperCommand());
	return buildGitIdentityEnv(row ? toEnvIdentity(row, credential) : null, helperCommand(), hosted);
}

/**
 * Hosts a connected hosting account answers for, in this project.
 *
 * A host an identity's own credential claims is left out: a token chosen in
 * Settings → Git Accounts is an explicit override, and it keeps winning over
 * the account connected for the Git panel.
 */
export function hostedHosts(projectId: string, row: GitIdentityRow | null): string[] {
	try {
		const hosts = new Set(hostAccounts(projectId).map((ref) => ref.host));
		return [...hosts].filter((host) => !(row && pickCredentialIdentity(host, row)));
	} catch (error) {
		debug.warn('git', 'Could not list hosting accounts for git credentials:', error);
		return [];
	}
}

/**
 * What the UI shows above the commit box: who this will be committed as, and
 * whether that was chosen for this project or inherited.
 */
export function describeIdentity(projectId: string, remoteUrl?: string | null): ResolvedGitIdentity {
	const { row, source } = resolveIdentity(projectId);
	if (!row) return { identity: null, source: 'none', credentialIdentity: null };

	const host = remoteUrl ? remoteHost(remoteUrl) : null;
	const credential = pickCredentialIdentity(host, row);

	return {
		identity: toDTO(row),
		source,
		// Only reported when it differs, so the UI can stay quiet in the common
		// case and speak up exactly when a second account is in play.
		credentialIdentity: credential && credential.id !== row.id ? toDTO(credential) : null
	};
}
