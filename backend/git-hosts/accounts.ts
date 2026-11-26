/**
 * Which connected account answers for a host — and for a remote on it.
 *
 * A hosting account is any ENABLED integration account whose provider has a
 * hosting adapter. No capability gates it: an account connected for Issues &
 * PRs can obviously push to the same service, and making the user tick a
 * second box to say so would be a setting that only exists to be forgotten.
 *
 * ── Two accounts on one host ──
 * Personal and work GitHub accounts are a normal setup. The remote's OWNER
 * decides between them: the account whose login is the owner, or whose
 * organisations include it, wins. When that still leaves more than one, the
 * strict lookup (used for git credentials) answers "none" — authenticating as
 * an account nobody chose is the failure this exists to prevent — while the
 * lenient one (used to show issues) takes the first, and the panel names
 * which account it used.
 */

import { integrationAccountQueries, type IntegrationAccountRow } from '$backend/database/queries';
import type { GitHostKind } from '$shared/types/git-hosting';
import { getHostAdapter } from './registry';
import { parseRemoteUrl } from './urls';
import type { GitHostAdapter } from './types';

export interface HostAccountRef {
	account: IntegrationAccountRow;
	adapter: GitHostAdapter;
	provider: GitHostKind;
	host: string;
	/** The stored snapshot — use `credentialsForUse` before calling the service. */
	credentials: Record<string, string>;
}

/** Owners (user + organisations) each account is known to reach, learned as they are listed. */
const ownerCache = new Map<string, Set<string>>();

export function rememberOwners(accountId: string, owners: string[]): void {
	ownerCache.set(accountId, new Set(owners.map((owner) => owner.toLowerCase())));
}

export function forgetOwners(accountId: string): void {
	ownerCache.delete(accountId);
}

function toRef(account: IntegrationAccountRow): HostAccountRef | null {
	const adapter = getHostAdapter(account.provider);
	if (!adapter) return null;
	const credentials = integrationAccountQueries.credentialsOf(account);
	const host = adapter.host(credentials);
	if (!host) return null;
	return { account, adapter, provider: adapter.kind, host, credentials };
}

/** Every enabled hosting account visible to a project (or every one, without a project). */
export function hostAccounts(projectId?: string | null): HostAccountRef[] {
	return integrationAccountQueries
		.getAll()
		.filter((account) => account.is_enabled === 1)
		.filter((account) => !projectId || account.project_id === null || account.project_id === projectId)
		.map(toRef)
		.filter((ref): ref is HostAccountRef => ref !== null);
}

export function hostAccountById(accountId: string): HostAccountRef | null {
	const account = integrationAccountQueries.getById(accountId);
	if (!account || account.is_enabled !== 1) return null;
	return toRef(account);
}

function ownerMatches(ref: HostAccountRef, owner: string): boolean {
	const wanted = owner.toLowerCase();
	if ((ref.credentials.login ?? '').toLowerCase() === wanted) return true;
	return ownerCache.get(ref.account.id)?.has(wanted) ?? false;
}

/**
 * The account that answers for a remote URL, and the repository it names.
 *
 * `strict` refuses to choose between accounts the owner does not tell apart.
 */
export function accountForRemote(
	url: string,
	projectId: string | null,
	options: { strict: boolean }
): { ref: HostAccountRef; locator: string } | null {
	const parsed = parseRemoteUrl(url);
	if (!parsed) return null;

	const candidates = hostAccounts(projectId)
		.filter((ref) => ref.host === parsed.host)
		.map((ref) => ({ ref, locator: ref.adapter.locatorFromRemote(url, ref.credentials) }))
		.filter((entry): entry is { ref: HostAccountRef; locator: string } => entry.locator !== null);

	if (candidates.length <= 1) return candidates[0] ?? null;

	const owner = candidates[0]!.locator.split('/')[0] ?? '';
	const byOwner = candidates.filter((entry) => ownerMatches(entry.ref, owner));
	if (byOwner.length === 1) return byOwner[0]!;

	// A project-bound account is a choice the user made for this project.
	const pool = byOwner.length > 1 ? byOwner : candidates;
	const bound = pool.filter((entry) => projectId && entry.ref.account.project_id === projectId);
	if (bound.length === 1) return bound[0]!;

	return options.strict ? null : pool[0]!;
}
