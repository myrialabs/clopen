/**
 * Which identity a git command runs as.
 *
 * ── The chain ──
 *   binding (project, user)  →  the user's default  →  nothing
 * "Nothing" is a real answer, not a failure: Clopen then runs git exactly as it
 * did before this feature existed, deferring to `.git/config` and the machine.
 * That is what keeps the feature opt-in for people who already have git set up.
 *
 * ── Why the credential can come from a different identity ──
 * Attribution is a property of the person; a credential is a property of the
 * host. A fork workflow has `origin` on a personal account and `upstream` on a
 * work one, and the commits belong to the same human either way. So the
 * project's identity always decides `user.name`/`user.email`, while the
 * credential is chosen by matching the remote's host against each identity's
 * claimed hosts — falling back to the project identity when it claims the host
 * itself, and to nothing when no identity does.
 */

import {
	gitIdentityQueries,
	gitIdentityBindingQueries,
	parseHosts,
	type GitIdentityRow
} from '$backend/database/queries';
import { debug } from '$shared/utils/logger';
import type { GitEnvIdentity, HelperCommand } from './env';
import { identityKeyPath } from './keys';

/** Where the identity came from, for the "committing as…" line in the UI. */
export type IdentitySource = 'project' | 'user-default' | 'none';

export interface IdentityResolution {
	row: GitIdentityRow | null;
	source: IdentitySource;
}

/**
 * The identity for a project, for one user.
 *
 * A binding pointing at a deleted identity resolves to the user's default
 * rather than to nothing — `ON DELETE CASCADE` removes such bindings, so this
 * only guards against a row that outlived its target.
 */
export function resolveIdentity(projectId: string, userId: string): IdentityResolution {
	const binding = gitIdentityBindingQueries.get(projectId, userId);
	if (binding) {
		const row = gitIdentityQueries.getById(binding.identity_id);
		if (row && row.owner_user_id === userId) return { row, source: 'project' };
		debug.warn('git', `Identity binding for project ${projectId} points at a missing identity`);
	}

	const fallback = gitIdentityQueries.getDefaultForUser(userId);
	return fallback ? { row: fallback, source: 'user-default' } : { row: null, source: 'none' };
}

/** True when this identity can authenticate to `host`. */
function claimsHost(row: GitIdentityRow, host: string): boolean {
	if (row.auth_method === 'none') return false;
	return parseHosts(row.hosts).includes(host);
}

/**
 * The identity whose credential should answer for `host`.
 *
 * Prefers the one already chosen for the project, so the common case never
 * looks past it. Otherwise the user's other identities are searched, and a
 * single match wins. AMBIGUITY IS RESOLVED AS "NO CREDENTIAL": if two
 * identities claim the same host, picking one arbitrarily would authenticate
 * as an account the user did not choose, and a push that fails asking for a
 * credential is far easier to understand than a push that lands under the
 * wrong name.
 */
export function pickCredentialIdentity(
	userId: string,
	host: string | null,
	primary: GitIdentityRow | null
): GitIdentityRow | null {
	if (!host) return null;
	if (primary && claimsHost(primary, host)) return primary;

	const candidates = gitIdentityQueries
		.listByUser(userId)
		.filter((row) => claimsHost(row, host));

	if (candidates.length === 1) return candidates[0]!;
	if (candidates.length > 1) {
		debug.warn(
			'git',
			`${candidates.length} identities claim ${host}; refusing to guess which credential to use`
		);
	}
	return null;
}

/**
 * Flatten a row (plus an optional credential row) into what the env builder needs.
 *
 * The two halves can come from different identities, which is the whole point
 * of `pickCredentialIdentity` — attribution from one, credential from another.
 */
export function toEnvIdentity(
	row: GitIdentityRow,
	credential: GitIdentityRow | null
): GitEnvIdentity {
	const credentialRow = credential ?? null;
	const usesSsh = credentialRow?.auth_method === 'ssh-key' && !!credentialRow.ssh_private_key;
	const usesHttps =
		credentialRow?.auth_method === 'https-token' || credentialRow?.auth_method === 'https-account';

	return {
		// The helper is invoked with the CREDENTIAL identity's id when one exists,
		// because that is the row holding the token it must read back.
		id: credentialRow?.id ?? row.id,
		name: row.name,
		email: row.email,
		sshKeyPath: usesSsh ? identityKeyPath(credentialRow!.id) : null,
		needsPassphrase: usesSsh ? !!credentialRow!.ssh_passphrase : false,
		httpsUsername: usesHttps ? credentialRow!.https_username : null,
		credentialHosts: usesHttps ? parseHosts(credentialRow!.hosts) : []
	};
}

/**
 * How to re-invoke this Clopen for the credential/askpass helpers.
 *
 * Taken from the running process rather than from a configured path: whichever
 * runtime and entry script are executing right now are, by definition, the ones
 * that work. A hardcoded `clopen` on PATH would break for a source checkout, and
 * a packaged path would break for a global install.
 */
export function helperCommand(): HelperCommand | undefined {
	const runtime = process.execPath;
	const script = Bun.main;
	if (!runtime || !script) {
		debug.warn('git', 'Cannot locate the Clopen entry point; git credential helpers disabled');
		return undefined;
	}
	return { runtime, script };
}
