/**
 * The bridge from a WebSocket connection to a git identity.
 *
 * Handlers already know the project (`data.projectId`); this adds the other
 * half, the user, from the connection. Both are needed because an identity is
 * owned by a person and chosen per project, so neither alone identifies one.
 *
 * Every helper here degrades to `{}` rather than throwing. A user with no
 * identity, an unreadable row, a project that was never bound — all of them
 * mean "run git the way Clopen always did", which is a working commit, not an
 * error dialog.
 */

import { resolveGitEnv } from '$backend/git/identity';
import { gitService } from '$backend/git/git-service';
import type { GitIdentityEnv } from '$backend/git/git-executor';
import { ws } from '$backend/utils/ws';
import type { WSConnection } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';

/**
 * Attribution-only environment: who authors what this command creates.
 *
 * For commits, merges, stashes, tags — anything that writes a git object
 * without reaching the network.
 */
export function identityEnvFor(conn: WSConnection, projectId: string): GitIdentityEnv {
	try {
		const userId = ws.getUserId(conn);
		if (!userId) return {};
		return resolveGitEnv(projectId, userId);
	} catch (error) {
		debug.warn('git', 'Could not resolve a git identity for this connection:', error);
		return {};
	}
}

/**
 * Attribution plus the credential that reaches `remote`.
 *
 * The remote's URL — not its name — decides which identity authenticates, so
 * the name is resolved to a URL first. `origin` on one account and `upstream`
 * on another is the case this exists for.
 *
 * When the name cannot be resolved to a URL the result is attribution only:
 * that is what happens for a branch pushing to an upstream Clopen did not
 * name, and falling back to the machine's credentials there is the same
 * behaviour as before this feature.
 */
export async function identityEnvForRemote(
	conn: WSConnection,
	projectId: string,
	cwd: string,
	remoteName?: string
): Promise<GitIdentityEnv> {
	try {
		const userId = ws.getUserId(conn);
		if (!userId) return {};

		const url = await remoteUrl(cwd, remoteName);
		return resolveGitEnv(projectId, userId, url);
	} catch (error) {
		debug.warn('git', 'Could not resolve a git identity for this remote:', error);
		return {};
	}
}

/**
 * The URL behind a remote name.
 *
 * Falls back to `origin` when no name is given, because that is what git itself
 * does for a branch with no upstream — and a branch WITH an upstream is
 * overwhelmingly tracking origin too.
 */
async function remoteUrl(cwd: string, remoteName?: string): Promise<string | null> {
	try {
		const remotes = await gitService.getRemotes(cwd);
		if (remotes.length === 0) return null;
		const wanted = remoteName ?? 'origin';
		const match = remotes.find((r) => r.name === wanted);
		// A repo with exactly one remote under a different name is unambiguous, so
		// using it beats declining to pick a credential at all.
		const chosen = match ?? (remotes.length === 1 ? remotes[0] : undefined);
		if (!chosen) return null;
		// Push URL first: it is the one that needs a credential, and a remote
		// configured with separate fetch/push URLs is doing so deliberately.
		return chosen.pushUrl || chosen.fetchUrl || null;
	} catch {
		return null;
	}
}
