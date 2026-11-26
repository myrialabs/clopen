/**
 * The hosting accounts' half of the git credential helper.
 *
 * Runs inside the short-lived helper process git spawns (see
 * `backend/git/identity/cli.ts`). Picks the account the way the Git panel
 * does — host, then repository owner — and hands back the token as it should
 * be used now: re-read from a linked CLI, or refreshed when an OAuth token is
 * about to expire.
 */

import { accountForRemote } from './accounts';
import { credentialsForUse } from './credentials';

export async function answerHostedCredential(
	host: string,
	path: string,
	projectId: string | null
): Promise<{ username: string; password: string } | null> {
	const url = `https://${host}/${path.replace(/^\/+/, '')}`;
	// Without a path (`useHttpPath` off, or an old git) the owner is unknown, so
	// the lookup can only succeed when one account serves the host.
	const match = accountForRemote(url, projectId, { strict: true })
		?? (path ? null : accountForRemote(`https://${host}/_/_`, projectId, { strict: true }));
	if (!match) return null;

	const credentials = await credentialsForUse(match.ref.account, { reproject: false });
	const token = credentials.token;
	if (!token) return null;
	return { username: match.ref.adapter.gitUsername(credentials), password: token };
}
