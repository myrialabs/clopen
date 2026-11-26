/**
 * Health for a hosting account: can it still say who it is.
 *
 * Used for accounts with no work capability (Gitea, Bitbucket, or GitHub with
 * Issues & PRs switched off), whose only job is to push and publish — so the
 * only question worth asking is whether the credential still signs in.
 */

import { integrationAccountQueries } from '$backend/database/queries';
import { HostApiError } from './http';
import { credentialsForUse } from './credentials';
import { getHostAdapter } from './registry';

export async function probeHostAccount(
	accountId: string
): Promise<{ status: 'ok' | 'needs_auth' | 'needs_config' | 'error'; detail: string | null } | null> {
	const account = integrationAccountQueries.getById(accountId);
	if (!account) return null;
	const adapter = getHostAdapter(account.provider);
	if (!adapter) return null;

	try {
		const credentials = await credentialsForUse(account);
		const viewer = await adapter.viewer(credentials);
		if (viewer.missingScopes.length > 0) {
			return {
				status: 'needs_config',
				detail: `Signed in as ${viewer.login}, but the token is missing: ${viewer.missingScopes.join(', ')}. Reconnect to grant them.`
			};
		}
		return { status: 'ok', detail: `Signed in as ${viewer.login}` };
	} catch (error) {
		if (error instanceof HostApiError) {
			const status = error.kind === 'auth' ? 'needs_auth' : error.kind === 'config' ? 'needs_config' : 'error';
			return { status, detail: error.message };
		}
		return { status: 'error', detail: error instanceof Error ? error.message : String(error) };
	}
}
