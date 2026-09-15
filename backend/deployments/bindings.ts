/**
 * Which remote project a Clopen project deploys to.
 *
 * Discovered rather than asked for, in two passes that go from certain to
 * plausible:
 *
 *  1. The provider's own CLI config in the working tree. A project someone has
 *     run `vercel link` in already carries the answer in `.vercel/project.json`,
 *     and making them pick it out of a dropdown would be asking them to retype
 *     a file that is sitting in their repository.
 *  2. The git remote. Every deploy target names the repository it builds from,
 *     so a project whose `origin` matches one of them has answered the question
 *     too — just less definitively, since two Vercel projects can build the same
 *     repository from different directories.
 *
 * Both are recorded as detection (`detected: true`) so the UI can say where the
 * answer came from, and both are always overridable. A monorepo deploying three
 * apps from one repository is a real, ordinary case, and it is exactly the case
 * pass 2 gets wrong.
 */

import { join } from 'path';
import { gitService } from '$backend/git/git-service';
import {
	deployBindingQueries,
	integrationAccountQueries,
	parseDeployConfig,
	type IntegrationAccountRow
} from '$backend/database/queries';
import type { DeployBinding, DeployTarget } from '$shared/types/deployments';
import { DEFAULT_DEPLOY_BINDING_CONFIG } from '$shared/types/deployments';
import type { DeployProviderAdapter, ResolvedDeployBinding } from './types';
import { debug } from '$shared/utils/logger';

/** The stored binding for one account on one project, or null. */
export function readDeployBinding(projectId: string, accountId: string): ResolvedDeployBinding | null {
	const row = deployBindingQueries.get(projectId, accountId);
	if (!row) return null;
	return {
		locator: row.locator,
		displayName: row.display_name,
		detected: row.detected === 1,
		teamId: row.team_id,
		config: parseDeployConfig(row.config_json)
	};
}

/**
 * `owner/repo` for every remote this project has, lowercased for comparison.
 *
 * Host-agnostic on purpose: a deploy target reports the repository as
 * `acme/web` without saying which host it is on, and the account that reaches
 * it has already decided the host. Comparing the path alone is what lets a
 * self-hosted GitLab mirror match.
 */
async function remoteRepoPaths(projectRoot: string): Promise<Set<string>> {
	const paths = new Set<string>();
	let remotes: { name: string; fetchUrl: string; pushUrl: string }[] = [];
	try {
		remotes = await gitService.getRemotes(projectRoot);
	} catch (error) {
		// A project that is not a repository has no remotes, which is a normal
		// state: it can still be bound by hand or by the CLI config.
		debug.log('deployments', `No git remotes for ${projectRoot}: ${error instanceof Error ? error.message : error}`);
		return paths;
	}

	for (const remote of remotes) {
		for (const url of [remote.fetchUrl, remote.pushUrl]) {
			const path = repoPathOf(url);
			if (path) paths.add(path);
		}
	}
	return paths;
}

/** `owner/repo` out of either git URL form, without the `.git` suffix. */
export function repoPathOf(url: string): string | null {
	if (!url) return null;
	const trimmed = url.trim().replace(/\.git$/, '');
	// scp-like: git@host:owner/repo
	const scp = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
	if (scp) return scp[1].toLowerCase();
	// URL form: https://host/owner/repo, ssh://git@host/owner/repo
	try {
		const parsed = new URL(trimmed);
		const path = parsed.pathname.replace(/^\/+/, '');
		return path ? path.toLowerCase() : null;
	} catch {
		return null;
	}
}

/**
 * Targets worth offering for this project, most likely first.
 *
 * Ordered rather than filtered: a repository match is a strong hint, not a
 * fact, so the ones that do not match stay in the list below them instead of
 * disappearing. A user deploying from a directory this project does not push to
 * must still be able to find their project.
 */
export async function suggestTargets(
	adapter: DeployProviderAdapter,
	context: { projectId: string; account: IntegrationAccountRow; credentials: Record<string, string> },
	projectRoot: string
): Promise<DeployTarget[]> {
	const targets = await adapter.listTargets(context);
	const repos = await remoteRepoPaths(projectRoot);
	if (repos.size === 0) return targets;

	const matches = (target: DeployTarget): boolean =>
		target.gitRepo !== null && repos.has(target.gitRepo.toLowerCase());

	return [...targets].sort((a, b) => Number(matches(b)) - Number(matches(a)));
}

/**
 * The binding, detecting and persisting one when there is none.
 *
 * Persisting the detected value rather than re-deriving it on every call is
 * deliberate: it gives the user a row to edit, and it means adding a second
 * Vercel project to the same repository later does not silently repoint a
 * project someone has been deploying from.
 */
export async function resolveDeployBinding(
	adapter: DeployProviderAdapter,
	account: IntegrationAccountRow,
	projectId: string,
	projectRoot: string
): Promise<ResolvedDeployBinding | null> {
	const existing = readDeployBinding(projectId, account.id);
	if (existing) return existing;

	const credentials = integrationAccountQueries.credentialsOf(account);
	const context = { projectId, account, credentials };

	const detected = await detectLocator(adapter, context, projectRoot);
	if (!detected) return null;

	deployBindingQueries.upsert({
		projectId,
		accountId: account.id,
		locator: detected.locator,
		displayName: detected.displayName,
		teamId: detected.teamId,
		detected: true,
		config: { ...DEFAULT_DEPLOY_BINDING_CONFIG }
	});
	debug.log('deployments', `Bound project ${projectId} to ${account.provider}:${detected.displayName} (${detected.via})`);

	return readDeployBinding(projectId, account.id);
}

/** The two detection passes, in order, or null when neither answers. */
async function detectLocator(
	adapter: DeployProviderAdapter,
	context: { projectId: string; account: IntegrationAccountRow; credentials: Record<string, string> },
	projectRoot: string
): Promise<{ locator: string; teamId: string | null; displayName: string; via: string } | null> {
	if (adapter.detectFromProject) {
		try {
			const linked = await adapter.detectFromProject(projectRoot);
			if (linked) {
				// The name is worth one extra call: a binding bar showing `prj_8Qc…`
				// is unreadable, and this is the only moment we know we need it.
				const described = await adapter
					.describeTarget(context, linked.locator, linked.teamId)
					.catch(() => null);
				return {
					locator: linked.locator,
					teamId: linked.teamId,
					displayName: described?.name ?? linked.locator,
					via: 'the linked CLI project'
				};
			}
		} catch (error) {
			debug.warn('deployments', 'CLI-config detection failed:', error);
		}
	}

	try {
		const repos = await remoteRepoPaths(projectRoot);
		if (repos.size === 0) return null;

		const targets = await adapter.listTargets(context);
		const match = targets.find((target) => target.gitRepo && repos.has(target.gitRepo.toLowerCase()));
		if (!match) return null;

		return {
			locator: match.id,
			teamId: match.teamId,
			displayName: match.name,
			via: 'a matching git remote'
		};
	} catch (error) {
		debug.warn('deployments', 'Git-remote detection failed:', error);
		return null;
	}
}

/** Shape a binding for the client, or null when the project has none. */
export function toDeployBindingInfo(binding: ResolvedDeployBinding | null): DeployBinding | null {
	if (!binding) return null;
	return {
		locator: binding.locator,
		displayName: binding.displayName || binding.locator,
		detected: binding.detected,
		teamId: binding.teamId,
		config: binding.config
	};
}

/** Where a provider's CLI config would live, for adapters that have one. */
export function projectConfigPath(projectRoot: string, ...segments: string[]): string {
	return join(projectRoot, ...segments);
}
