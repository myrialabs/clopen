/**
 * Git Identity Store
 *
 * Reactive state for Settings → Git Accounts and the Git panel's "committing
 * as" line. Identities are per user, so this store holds the signed-in user's
 * own accounts; the server resolves the owner from the connection and this
 * never sends a user id.
 *
 * NOTHING SECRET IS HELD HERE. The server's DTO reduces the private key, its
 * passphrase and the HTTPS token to `hasSshKey` / `hasSshPassphrase` /
 * `hasHttpsToken`, so a secret can only travel one way: typed into a form and
 * posted. On the way back there is only ever a boolean, and the public key.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import type {
	GitIdentityDTO,
	GitIdentityInput,
	ResolvedGitIdentity
} from '$shared/types/git-identity';

let identities = $state<GitIdentityDTO[]>([]);
let loaded = $state(false);
/**
 * Resolved identity per project id.
 *
 * Keyed rather than single-valued because the Git panel and a Settings tab can
 * ask about different projects at once, and a stale answer rendered against the
 * wrong project is exactly the bug this feature exists to prevent.
 */
let resolved = $state<Record<string, ResolvedGitIdentity>>({});

export const gitIdentityStore = {
	get identities() {
		return identities;
	},
	get loaded() {
		return loaded;
	},

	/** The user's default, or null when they have none. */
	get defaultIdentity(): GitIdentityDTO | null {
		return identities.find((i) => i.isDefault) ?? null;
	},

	/** The resolved identity for a project, if it has been fetched. */
	resolvedFor(projectId: string | null | undefined): ResolvedGitIdentity | null {
		if (!projectId) return null;
		return resolved[projectId] ?? null;
	},

	/**
	 * Drop every cached resolution.
	 *
	 * Called after a change that can alter what a project resolves to without
	 * naming the project — switching the default reaches every project that
	 * inherits it. Clearing is right rather than refetching: the next read of a
	 * project fetches it, and refetching all of them would fire a request per
	 * project for answers nothing is showing.
	 */
	invalidateResolved(): void {
		resolved = {};
	},

	async refresh(force = false): Promise<void> {
		if (loaded && !force) return;
		try {
			const result = await ws.http('git:identities', {});
			identities = result.identities;
			loaded = true;
		} catch (error) {
			debug.error('git', 'Could not load git identities:', error);
		}
	},

	async create(input: GitIdentityInput): Promise<GitIdentityDTO> {
		const result = await ws.http('git:identity-create', input);
		await this.refresh(true);
		return result.identity;
	},

	async update(id: string, input: GitIdentityInput): Promise<GitIdentityDTO> {
		const result = await ws.http('git:identity-update', { id, ...input });
		await this.refresh(true);
		return result.identity;
	},

	async remove(id: string): Promise<void> {
		await ws.http('git:identity-delete', { id });
		await this.refresh(true);
	},

	async setDefault(id: string): Promise<void> {
		await ws.http('git:identity-set-default', { id });
		await this.refresh(true);
	},

	/** Generate a keypair server-side. Only the public half comes back. */
	async generateKey(id: string): Promise<{ publicKey: string; fingerprint: string }> {
		const result = await ws.http('git:identity-generate-key', { id });
		await this.refresh(true);
		return result;
	},

	/** Projects bound to this identity — shown before a delete. */
	async usage(id: string): Promise<number> {
		try {
			const result = await ws.http('git:identity-usage', { id });
			return result.projectCount;
		} catch {
			return 0;
		}
	},

	/** Bind a project to an identity, or pass null to fall back to the default. */
	async bind(projectId: string, identityId: string | null): Promise<void> {
		await ws.http('git:identity-bind', { projectId, identityId });
		await this.fetchResolved(projectId);
	},

	/**
	 * Fetch who the next commit in this project will be attributed to.
	 *
	 * Failure clears the entry rather than leaving the previous project's answer
	 * in place — showing the wrong author is worse than showing none.
	 */
	async fetchResolved(projectId: string): Promise<ResolvedGitIdentity | null> {
		try {
			const result = await ws.http('git:identity-resolved', { projectId });
			resolved = { ...resolved, [projectId]: result };
			return result;
		} catch (error) {
			debug.warn('git', 'Could not resolve the git identity for this project:', error);
			const next = { ...resolved };
			delete next[projectId];
			resolved = next;
			return null;
		}
	}
};
