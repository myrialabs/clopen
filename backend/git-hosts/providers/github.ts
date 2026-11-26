/**
 * GitHub (and Enterprise Server) as a repository host.
 *
 * Shares the Issues & PRs client, so both surfaces spend one ETag cache and
 * one rate limit — a 304 on `/user` here is a 304 for the work view too.
 */

import type { CommitCiState, CommitCiStatus, HostedRepo, HostOwner, HostViewer } from '$shared/types/git-hosting';
import {
	GitHubError,
	githubRequest,
	invalidateGitHubCache,
	webBaseOf,
	type GitHubCredentials
} from '$backend/work/providers/github/client';
import { HostApiError, mapLimited, waitFor } from '../http';
import { rollUp } from '../ci';
import { hostOfBase, parseRemoteUrl } from '../urls';
import type { CreateRepoInput, GitHostAdapter, HostCredentials, RepoQuery } from '../types';

/** What Clopen needs from a classic or OAuth token. `read:org` is only needed for SAML orgs, so it is not demanded. */
const REQUIRED_SCOPES = ['repo', 'workflow'];

function creds(credentials: HostCredentials): GitHubCredentials {
	return { token: credentials.token ?? '', baseUrl: credentials.baseUrl };
}

/** GitHub's errors, re-thrown in the vocabulary every hosting adapter speaks. */
async function call<T>(credentials: HostCredentials, path: string, options: Parameters<typeof githubRequest>[2] = {}) {
	try {
		return await githubRequest<T>(creds(credentials), path, options);
	} catch (error) {
		if (error instanceof GitHubError) {
			const kind = error.status === 422 ? 'conflict' : error.kind;
			throw new HostApiError(error.message, error.status, kind);
		}
		throw error;
	}
}

interface GitHubRepoWire {
	full_name: string;
	name: string;
	owner: { login: string };
	description: string | null;
	private: boolean;
	fork: boolean;
	parent?: { full_name: string };
	default_branch?: string;
	clone_url: string;
	ssh_url?: string;
	html_url: string;
	updated_at?: string;
	pushed_at?: string;
	permissions?: { push?: boolean; admin?: boolean };
}

function toRepo(raw: GitHubRepoWire): HostedRepo {
	return {
		fullName: raw.full_name,
		owner: raw.owner.login,
		name: raw.name,
		description: raw.description,
		isPrivate: raw.private,
		isFork: raw.fork,
		parentFullName: raw.parent?.full_name ?? null,
		defaultBranch: raw.default_branch ?? null,
		cloneUrlHttps: raw.clone_url,
		cloneUrlSsh: raw.ssh_url ?? null,
		webUrl: raw.html_url,
		updatedAt: raw.pushed_at ?? raw.updated_at ?? null,
		canPush: raw.permissions ? raw.permissions.push === true || raw.permissions.admin === true : null
	};
}

const REPO_PAGE = 50;

/** Pages read when a search is typed. The listing has no search parameter, so it filters what it reads. */
const SEARCH_PAGES = 6;

function matchesSearch(repo: HostedRepo, needle: string): boolean {
	return `${repo.fullName} ${repo.description ?? ''}`.toLowerCase().includes(needle);
}

function ciFromConclusion(status: string, conclusion: string | null): CommitCiState {
	if (status !== 'completed') return 'pending';
	if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') return 'success';
	if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure' || conclusion === 'action_required') return 'failure';
	return 'none';
}

export const githubHost: GitHostAdapter = {
	kind: 'github',
	serviceName: 'GitHub',

	webBase: (credentials) => webBaseOf(creds(credentials)),
	host: (credentials) => hostOfBase(webBaseOf(creds(credentials))),

	locatorFromRemote(url, credentials) {
		const parsed = parseRemoteUrl(url);
		if (!parsed || parsed.host !== this.host(credentials)) return null;
		const parts = parsed.path.split('/').filter(Boolean);
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
	},

	// GitHub ignores the username for a token; it only has to be non-empty.
	gitUsername: () => 'x-access-token',

	async viewer(credentials): Promise<HostViewer> {
		const response = await call<{ login: string; name: string | null; avatar_url: string | null }>(
			credentials,
			'/user',
			{ noCache: true }
		);
		const header = response.headers.get('x-oauth-scopes');
		// Fine-grained tokens report no scopes header at all; their permissions
		// are per repository and cannot be read off the token, so nothing is
		// reported missing rather than everything.
		const scopes = header === null ? null : header.split(',').map((scope) => scope.trim()).filter(Boolean);
		return {
			login: response.data.login,
			name: response.data.name,
			avatarUrl: response.data.avatar_url,
			scopes,
			missingScopes: scopes ? REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope)) : []
		};
	},

	async listOwners(credentials): Promise<HostOwner[]> {
		const [user, orgs] = await Promise.all([
			call<{ login: string; name: string | null; avatar_url: string | null }>(credentials, '/user'),
			call<{ login: string; description: string | null; avatar_url: string | null }[]>(credentials, '/user/orgs?per_page=100')
		]);
		return [
			{ login: user.data.login, kind: 'user', name: user.data.name, avatarUrl: user.data.avatar_url },
			...(orgs.data ?? []).map((org): HostOwner => ({
				login: org.login,
				kind: 'org',
				name: null,
				avatarUrl: org.avatar_url
			}))
		];
	},

	async listRepos(credentials, query: RepoQuery) {
		const needle = (query.search ?? '').trim().toLowerCase();
		const owner = (query.owner ?? '').trim().toLowerCase();
		// One listing for everything the user can reach. `/users/{org}/repos`
		// would only ever show an organisation's PUBLIC repositories.
		const base = `/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=${REPO_PAGE}`;

		if (!needle && !owner) {
			const response = await call<GitHubRepoWire[]>(credentials, `${base}&page=${query.page}`);
			return { repos: (response.data ?? []).map(toRepo), hasMore: response.nextUrl !== null };
		}

		const keep = (repo: HostedRepo) =>
			(!owner || repo.owner.toLowerCase() === owner) && (!needle || matchesSearch(repo, needle));
		const found: HostedRepo[] = [];
		let page = 1;
		let hasMore = true;
		while (hasMore && page <= SEARCH_PAGES && found.length < REPO_PAGE) {
			const response = await call<GitHubRepoWire[]>(credentials, `${base}&page=${page}`);
			found.push(...(response.data ?? []).map(toRepo).filter(keep));
			hasMore = response.nextUrl !== null;
			page += 1;
		}
		return { repos: found, hasMore: false };
	},

	async getRepo(credentials, locator) {
		const response = await call<GitHubRepoWire>(credentials, `/repos/${locator}`, { noCache: true });
		return toRepo(response.data);
	},

	async createRepo(credentials, input: CreateRepoInput) {
		const path = input.owner.kind === 'org' ? `/orgs/${encodeURIComponent(input.owner.login)}/repos` : '/user/repos';
		const response = await call<GitHubRepoWire>(credentials, path, {
			method: 'POST',
			body: {
				name: input.name,
				description: input.description || undefined,
				private: input.isPrivate,
				// The local repository already has history (or is about to): an
				// initialised remote would diverge from it on the first push.
				auto_init: false
			}
		});
		invalidateGitHubCache(credentials.token ?? '');
		return toRepo(response.data);
	},

	async fork(credentials, locator) {
		const response = await call<GitHubRepoWire>(credentials, `/repos/${locator}/forks`, { method: 'POST', body: {} });
		const forkName = response.data.full_name;
		// GitHub creates the fork asynchronously and answers 202 straight away;
		// pushing before it exists is a 404 from git with no explanation.
		const ready = await waitFor(async () => {
			const check = await call<GitHubRepoWire>(credentials, `/repos/${forkName}`, { noCache: true });
			return check.data?.full_name ? toRepo(check.data) : null;
		}, 60_000);
		if (!ready) throw new HostApiError(`GitHub is still creating ${forkName}. Try again in a minute.`, 0, 'error');
		invalidateGitHubCache(credentials.token ?? '');
		return ready;
	},

	async commitStatuses(credentials, locator, shas): Promise<CommitCiStatus[]> {
		const web = webBaseOf(creds(credentials));
		return mapLimited(shas, 4, async (sha): Promise<CommitCiStatus> => {
			// Two systems report on a commit: Checks (Actions and most apps) and
			// the older commit statuses (many external CIs). Reading one of them
			// shows a green tick on a commit whose other half is failing.
			const [checks, statuses] = await Promise.all([
				call<{ total_count: number; check_runs: { status: string; conclusion: string | null }[] }>(
					credentials,
					`/repos/${locator}/commits/${sha}/check-runs?per_page=100`
				).catch(() => null),
				call<{ state: string; total_count: number; statuses: { state: string }[] }>(
					credentials,
					`/repos/${locator}/commits/${sha}/status`
				).catch(() => null)
			]);

			const states: CommitCiState[] = [
				...(checks?.data.check_runs ?? []).map((run) => ciFromConclusion(run.status, run.conclusion)),
				...(statuses?.data.statuses ?? []).map((status): CommitCiState =>
					status.state === 'success' ? 'success'
						: status.state === 'pending' ? 'pending'
							: status.state === 'failure' || status.state === 'error' ? 'failure'
								: 'none')
			].filter((state) => state !== 'none');

			return rollUp(sha, states, `${web}/${locator}/commit/${sha}`);
		});
	},

	links(credentials, locator) {
		const repo = `${webBaseOf(creds(credentials))}/${locator}`;
		return {
			repo,
			commit: `${repo}/commit/{sha}`,
			branch: `${repo}/tree/{branch}`,
			file: `${repo}/blob/{ref}/{path}`,
			fileLine: '#L{line}',
			compare: `${repo}/compare/{base}...{head}`,
			newPullRequest: `${repo}/compare/{base}...{head}?expand=1`
		};
	},

	templates: {
		async gitignoreList(credentials) {
			const response = await call<string[]>(credentials, '/gitignore/templates');
			return (response.data ?? []).map((name) => ({ key: name, name }));
		},
		async gitignore(credentials, key) {
			const response = await call<{ source: string }>(credentials, `/gitignore/templates/${encodeURIComponent(key)}`);
			return response.data.source;
		},
		async licenseList(credentials) {
			const response = await call<{ key: string; name: string }[]>(credentials, '/licenses');
			return (response.data ?? []).map((license) => ({ key: license.key, name: license.name }));
		},
		async license(credentials, key, holder) {
			const response = await call<{ body: string }>(credentials, `/licenses/${encodeURIComponent(key)}`);
			return response.data.body
				.replace(/\[year\]/g, holder.year)
				.replace(/\[fullname\]/g, holder.fullname);
		}
	}
};
