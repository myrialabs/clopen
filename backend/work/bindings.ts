/**
 * Which remote project a Clopen project is looking at.
 *
 * The binding is discovered rather than asked for. A project that pushes to
 * `git@github.com:acme/web.git` and has a GitHub account connected already
 * answered the question, and making the user pick from a list of their 200
 * repositories to say what `git remote -v` says is exactly the kind of setup
 * step that makes an integration feel like homework.
 *
 * Detection is recorded as detection (`detected: true`) so the UI can say where
 * the answer came from, and it is always overridable — a monorepo whose issues
 * live in a different repository is a real, ordinary case.
 */

import { gitService } from '$backend/git/git-service';
import {
	integrationAccountQueries,
	workBindingQueries,
	parseBindingConfig,
	type IntegrationAccountRow
} from '$backend/database/queries';
import type { IssueBinding } from '$shared/types/work';
import { DEFAULT_BINDING_CONFIG } from '$shared/types/work';
import type { WorkProviderAdapter, ResolvedBinding } from './types';
import { debug } from '$shared/utils/logger';

/**
 * Locators this adapter recognises among the project's git remotes.
 *
 * Ordered by how likely each remote is to be the one that matters: `origin`
 * first, then `upstream` (a fork's parent, where the issues usually live), then
 * whatever else is configured.
 */
export async function suggestLocators(
	adapter: WorkProviderAdapter,
	credentials: Record<string, string>,
	projectRoot: string
): Promise<string[]> {
	let remotes: { name: string; fetchUrl: string; pushUrl: string }[] = [];
	try {
		remotes = await gitService.getRemotes(projectRoot);
	} catch (error) {
		// A project that is not a repository has no remotes, which is a normal
		// state and not worth surfacing — the user simply picks a locator.
		debug.log('work', `No git remotes for ${projectRoot}: ${error instanceof Error ? error.message : error}`);
		return [];
	}

	const rank = (name: string): number => (name === 'origin' ? 0 : name === 'upstream' ? 1 : 2);
	const ordered = [...remotes].sort((a, b) => rank(a.name) - rank(b.name));

	const seen = new Set<string>();
	const locators: string[] = [];
	for (const remote of ordered) {
		for (const url of [remote.fetchUrl, remote.pushUrl]) {
			const locator = url ? adapter.locatorFromRemote(url, credentials) : null;
			if (locator && !seen.has(locator)) {
				seen.add(locator);
				locators.push(locator);
			}
		}
	}
	return locators;
}

/** The stored binding for one account on one project, or null. */
export function readBinding(projectId: string, accountId: string): ResolvedBinding | null {
	const row = workBindingQueries.get(projectId, accountId);
	if (!row) return null;
	return {
		locator: row.locator,
		detected: row.detected === 1,
		defaultBranch: row.default_branch,
		config: parseBindingConfig(row.config_json)
	};
}

/**
 * The binding, detecting and persisting one when there is none.
 *
 * Persisting the detected value rather than re-deriving it on every call is
 * deliberate: it means the binding a user later edits has a row to edit, and it
 * means changing a git remote does not silently repoint a project whose issues
 * someone has already started working.
 */
export async function resolveBinding(
	adapter: WorkProviderAdapter,
	account: IntegrationAccountRow,
	projectId: string,
	projectRoot: string
): Promise<ResolvedBinding | null> {
	const existing = readBinding(projectId, account.id);
	if (existing) return existing;

	const credentials = integrationAccountQueries.credentialsOf(account);
	const [detected] = await suggestLocators(adapter, credentials, projectRoot);
	if (!detected) return null;

	workBindingQueries.upsert({
		projectId,
		accountId: account.id,
		locator: detected,
		detected: true,
		config: { ...DEFAULT_BINDING_CONFIG }
	});
	debug.log('work', `Bound project ${projectId} to ${account.provider}:${detected} from a git remote`);

	return readBinding(projectId, account.id);
}

/** Shape a binding for the client, or null when the project has none. */
export function toBindingInfo(
	adapter: WorkProviderAdapter,
	binding: ResolvedBinding | null
): IssueBinding | null {
	if (!binding) return null;
	return {
		locator: binding.locator,
		displayName: adapter.describeLocator(binding.locator),
		detected: binding.detected,
		defaultBranch: binding.defaultBranch,
		config: binding.config
	};
}
