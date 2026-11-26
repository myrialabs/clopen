/**
 * Gitea and Forgejo as a repository host.
 *
 * Forgejo kept Gitea's API, so one adapter serves both. Always self-hosted:
 * there is no default server, and the account's `baseUrl` is required.
 */

import type { CommitCiState, CommitCiStatus, HostedRepo, HostOwner, HostViewer } from '$shared/types/git-hosting';
import { HostApiError, hostRequest, mapLimited, type HostRequestOptions } from '../http';
import { hostOfBase, normaliseBaseUrl, parseRemoteUrl } from '../urls';
import type { CreateRepoInput, GitHostAdapter, HostCredentials, RepoQuery } from '../types';

function webBase(credentials: HostCredentials): string {
	return normaliseBaseUrl(credentials.baseUrl);
}

async function giteaRequest<T>(credentials: HostCredentials, path: string, options: HostRequestOptions = {}) {
	const base = webBase(credentials);
	if (!base) throw new HostApiError('This Gitea account has no server URL', 0, 'config');
	return hostRequest<T>('Gitea', `${base}/api/v1${path}`, {
		...options,
		headers: { Authorization: `Bearer ${credentials.token ?? ''}`, ...options.headers }
	});
}

interface GiteaRepoWire {
	full_name: string;
	name: string;
	owner: { login: string };
	description: string | null;
	private: boolean;
	fork: boolean;
	parent?: { full_name: string } | null;
	default_branch?: string;
	clone_url: string;
	ssh_url?: string;
	html_url: string;
	updated_at?: string;
	permissions?: { push?: boolean; admin?: boolean };
}

function toRepo(raw: GiteaRepoWire): HostedRepo {
	return {
		fullName: raw.full_name,
		owner: raw.owner.login,
		name: raw.name,
		description: raw.description || null,
		isPrivate: raw.private,
		isFork: raw.fork,
		parentFullName: raw.parent?.full_name ?? null,
		defaultBranch: raw.default_branch ?? null,
		cloneUrlHttps: raw.clone_url,
		cloneUrlSsh: raw.ssh_url ?? null,
		webUrl: raw.html_url,
		updatedAt: raw.updated_at ?? null,
		canPush: raw.permissions ? raw.permissions.push === true || raw.permissions.admin === true : null
	};
}

const REPO_PAGE = 50;

export const giteaHost: GitHostAdapter = {
	kind: 'gitea',
	serviceName: 'Gitea',

	webBase,
	host: (credentials) => hostOfBase(webBase(credentials)),

	locatorFromRemote(url, credentials) {
		const parsed = parseRemoteUrl(url);
		if (!parsed || parsed.host !== this.host(credentials)) return null;
		const parts = parsed.path.split('/').filter(Boolean);
		// A Gitea served under a sub-path puts that prefix in front of every
		// repository path; the last two segments are always owner/name.
		return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
	},

	// Gitea checks the token, not the name, but the name must be one it knows.
	gitUsername: (credentials) => credentials.login || 'oauth2',

	async viewer(credentials): Promise<HostViewer> {
		const response = await giteaRequest<{ login: string; full_name: string | null; avatar_url: string | null }>(credentials, '/user');
		return {
			login: response.data.login,
			name: response.data.full_name || null,
			avatarUrl: response.data.avatar_url,
			scopes: null,
			missingScopes: []
		};
	},

	async listOwners(credentials): Promise<HostOwner[]> {
		const [user, orgs] = await Promise.all([
			giteaRequest<{ login: string; full_name: string | null; avatar_url: string | null }>(credentials, '/user'),
			giteaRequest<{ username: string; full_name: string | null; avatar_url: string | null }[]>(credentials, '/user/orgs?limit=50')
		]);
		return [
			{ login: user.data.login, kind: 'user', name: user.data.full_name || null, avatarUrl: user.data.avatar_url },
			...(orgs.data ?? []).map((org): HostOwner => ({
				login: org.username,
				kind: 'org',
				name: org.full_name || null,
				avatarUrl: org.avatar_url
			}))
		];
	},

	async listRepos(credentials, query: RepoQuery) {
		const needle = (query.search ?? '').trim().toLowerCase();
		const owner = (query.owner ?? '').trim().toLowerCase();
		const response = await giteaRequest<GiteaRepoWire[]>(
			credentials,
			`/user/repos?limit=${REPO_PAGE}&page=${query.page}`
		);
		const page = response.data ?? [];
		const repos = page.map(toRepo).filter((repo) =>
			(!owner || repo.owner.toLowerCase() === owner)
			&& (!needle || `${repo.fullName} ${repo.description ?? ''}`.toLowerCase().includes(needle)));
		return { repos, hasMore: page.length === REPO_PAGE };
	},

	async getRepo(credentials, locator) {
		const response = await giteaRequest<GiteaRepoWire>(credentials, `/repos/${locator}`);
		return toRepo(response.data);
	},

	async createRepo(credentials, input: CreateRepoInput) {
		const path = input.owner.kind === 'org' ? `/orgs/${encodeURIComponent(input.owner.login)}/repos` : '/user/repos';
		const response = await giteaRequest<GiteaRepoWire>(credentials, path, {
			method: 'POST',
			body: {
				name: input.name,
				description: input.description,
				private: input.isPrivate,
				auto_init: false
			}
		});
		return toRepo(response.data);
	},

	async fork(credentials, locator) {
		const response = await giteaRequest<GiteaRepoWire>(credentials, `/repos/${locator}/forks`, {
			method: 'POST',
			body: {}
		});
		return toRepo(response.data);
	},

	async commitStatuses(credentials, locator, shas): Promise<CommitCiStatus[]> {
		return mapLimited(shas, 4, async (sha): Promise<CommitCiStatus> => {
			try {
				const response = await giteaRequest<{ state: string; total_count: number }>(
					credentials,
					`/repos/${locator}/commits/${encodeURIComponent(sha)}/status`
				);
				const raw = response.data;
				if (!raw.total_count) return { sha, state: 'none', url: null, summary: 'No checks' };
				const state: CommitCiState = raw.state === 'success' ? 'success'
					: raw.state === 'pending' ? 'pending'
						: raw.state === 'failure' || raw.state === 'error' ? 'failure'
							: 'none';
				return {
					sha,
					state,
					url: `${webBase(credentials)}/${locator}/commit/${sha}`,
					summary: `${raw.total_count} check${raw.total_count === 1 ? '' : 's'}: ${raw.state}`
				};
			} catch {
				return { sha, state: 'none', url: null, summary: 'No checks' };
			}
		});
	},

	links(credentials, locator) {
		const repo = `${webBase(credentials)}/${locator}`;
		return {
			repo,
			commit: `${repo}/commit/{sha}`,
			branch: `${repo}/src/branch/{branch}`,
			file: `${repo}/src/branch/{ref}/{path}`,
			fileLine: '#L{line}',
			compare: `${repo}/compare/{base}...{head}`,
			newPullRequest: `${repo}/compare/{base}...{head}`
		};
	},

	templates: {
		async gitignoreList(credentials) {
			const response = await giteaRequest<string[]>(credentials, '/gitignore/templates');
			return (response.data ?? []).map((name) => ({ key: name, name }));
		},
		async gitignore(credentials, key) {
			const response = await giteaRequest<{ source: string }>(credentials, `/gitignore/templates/${encodeURIComponent(key)}`);
			return response.data.source;
		},
		async licenseList(credentials) {
			const response = await giteaRequest<{ key: string; name: string }[]>(credentials, '/licenses');
			return (response.data ?? []).map((entry) => ({ key: entry.key, name: entry.name }));
		},
		async license(credentials, key, holder) {
			const response = await giteaRequest<{ body: string }>(credentials, `/licenses/${encodeURIComponent(key)}`);
			// Gitea ships the SPDX texts, whose placeholders vary by license.
			return response.data.body
				.replace(/<year>|\[year\]|\[yyyy\]|<yyyy>/gi, holder.year)
				.replace(/<name of author>|<copyright holders?>|\[fullname\]|\[name of copyright owner\]/gi, holder.fullname);
		}
	}
};
