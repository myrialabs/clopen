/**
 * Bitbucket Cloud as a repository host.
 *
 * Authenticated with an Atlassian API token: `email:token` over Basic auth for
 * the REST API. Owners are WORKSPACES, and a repository's locator is
 * `workspace/slug`.
 */

import type { CommitCiState, CommitCiStatus, HostedRepo, HostOwner, HostViewer } from '$shared/types/git-hosting';
import { HostApiError, hostRequest, mapLimited, type HostRequestOptions } from '../http';
import { parseRemoteUrl, withoutUserInfo } from '../urls';
import type { CreateRepoInput, GitHostAdapter, HostCredentials, RepoQuery } from '../types';
import { rollUp } from '../ci';

const API = 'https://api.bitbucket.org/2.0';
const WEB = 'https://bitbucket.org';

async function bbRequest<T>(credentials: HostCredentials, path: string, options: HostRequestOptions = {}) {
	const email = credentials.email ?? '';
	const token = credentials.token ?? '';
	if (!email || !token) throw new HostApiError('This Bitbucket account needs an email and an API token', 0, 'config');
	const basic = Buffer.from(`${email}:${token}`).toString('base64');
	return hostRequest<T>('Bitbucket', path.startsWith('http') ? path : `${API}${path}`, {
		...options,
		headers: { Authorization: `Basic ${basic}`, ...options.headers }
	});
}

interface BitbucketRepoWire {
	full_name: string;
	slug: string;
	name: string;
	workspace?: { slug: string };
	description: string;
	is_private: boolean;
	parent?: { full_name: string } | null;
	mainbranch?: { name: string } | null;
	updated_on?: string;
	links: {
		html: { href: string };
		clone?: { name: string; href: string }[];
	};
}

function toRepo(raw: BitbucketRepoWire): HostedRepo {
	const clone = raw.links.clone ?? [];
	const https = clone.find((entry) => entry.name === 'https')?.href ?? `${WEB}/${raw.full_name}.git`;
	return {
		fullName: raw.full_name,
		owner: raw.workspace?.slug ?? raw.full_name.split('/')[0] ?? '',
		name: raw.slug,
		description: raw.description || null,
		isPrivate: raw.is_private,
		isFork: !!raw.parent,
		parentFullName: raw.parent?.full_name ?? null,
		defaultBranch: raw.mainbranch?.name ?? null,
		// The clone link carries the user's name; written into `.git/config` it
		// would override the credential helper's username.
		cloneUrlHttps: withoutUserInfo(https),
		cloneUrlSsh: clone.find((entry) => entry.name === 'ssh')?.href ?? null,
		webUrl: raw.links.html.href,
		updatedAt: raw.updated_on ?? null,
		canPush: null
	};
}

const REPO_PAGE = 50;

export const bitbucketHost: GitHostAdapter = {
	kind: 'bitbucket',
	serviceName: 'Bitbucket',

	webBase: () => WEB,
	host: () => 'bitbucket.org',

	locatorFromRemote(url) {
		const parsed = parseRemoteUrl(url);
		if (!parsed || parsed.host !== 'bitbucket.org') return null;
		const parts = parsed.path.split('/').filter(Boolean);
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
	},

	// The fixed username Bitbucket expects for git over HTTPS with an API token.
	gitUsername: () => 'x-bitbucket-api-token-auth',

	async viewer(credentials): Promise<HostViewer> {
		const response = await bbRequest<{ username: string; display_name: string | null; links?: { avatar?: { href: string } } }>(
			credentials,
			'/user'
		);
		return {
			login: response.data.username,
			name: response.data.display_name,
			avatarUrl: response.data.links?.avatar?.href ?? null,
			scopes: null,
			missingScopes: []
		};
	},

	async listOwners(credentials): Promise<HostOwner[]> {
		const [user, workspaces] = await Promise.all([
			bbRequest<{ username: string }>(credentials, '/user'),
			bbRequest<{ values: { workspace: { slug: string; name: string } }[] }>(credentials, '/user/workspaces?pagelen=100')
		]);
		const login = user.data.username;
		return (workspaces.data.values ?? [])
			.map(({ workspace }): HostOwner => ({
				login: workspace.slug,
				kind: workspace.slug === login ? 'user' : 'org',
				name: workspace.name,
				avatarUrl: null
			}))
			// The personal workspace first, like the other services.
			.sort((a, b) => (a.kind === 'user' ? -1 : b.kind === 'user' ? 1 : a.login.localeCompare(b.login)));
	},

	async listRepos(credentials, query: RepoQuery) {
		const params = new URLSearchParams({ role: 'member', sort: '-updated_on', pagelen: String(REPO_PAGE), page: String(query.page) });
		const clauses: string[] = [];
		if (query.search?.trim()) clauses.push(`name ~ "${query.search.trim().replace(/"/g, '')}"`);
		if (clauses.length) params.set('q', clauses.join(' AND '));
		const path = query.owner
			? `/repositories/${encodeURIComponent(query.owner)}?${params.toString()}`
			: `/repositories?${params.toString()}`;
		const response = await bbRequest<{ values: BitbucketRepoWire[]; next?: string }>(credentials, path);
		return { repos: (response.data.values ?? []).map(toRepo), hasMore: !!response.data.next };
	},

	async getRepo(credentials, locator) {
		const response = await bbRequest<BitbucketRepoWire>(credentials, `/repositories/${locator}`);
		return toRepo(response.data);
	},

	async createRepo(credentials, input: CreateRepoInput) {
		const slug = input.name.toLowerCase();
		const response = await bbRequest<BitbucketRepoWire>(
			credentials,
			`/repositories/${encodeURIComponent(input.owner.login)}/${encodeURIComponent(slug)}`,
			{
				method: 'POST',
				body: { scm: 'git', is_private: input.isPrivate, description: input.description, name: input.name }
			}
		);
		return toRepo(response.data);
	},

	async fork(credentials, locator) {
		const response = await bbRequest<BitbucketRepoWire>(credentials, `/repositories/${locator}/forks`, {
			method: 'POST',
			body: {}
		});
		return toRepo(response.data);
	},

	async commitStatuses(credentials, locator, shas): Promise<CommitCiStatus[]> {
		return mapLimited(shas, 4, async (sha): Promise<CommitCiStatus> => {
			try {
				const response = await bbRequest<{ values: { state: string }[] }>(
					credentials,
					`/repositories/${locator}/commit/${encodeURIComponent(sha)}/statuses?pagelen=50`
				);
				const states = (response.data.values ?? []).map((entry): CommitCiState =>
					entry.state === 'SUCCESSFUL' ? 'success'
						: entry.state === 'INPROGRESS' ? 'pending'
							: entry.state === 'FAILED' ? 'failure'
								: 'none').filter((state) => state !== 'none');
				return rollUp(sha, states, `${WEB}/${locator}/commits/${sha}`);
			} catch {
				return { sha, state: 'none', url: null, summary: 'No checks' };
			}
		});
	},

	links(_credentials, locator) {
		const repo = `${WEB}/${locator}`;
		return {
			repo,
			commit: `${repo}/commits/{sha}`,
			branch: `${repo}/branch/{branch}`,
			file: `${repo}/src/{ref}/{path}`,
			fileLine: '#lines-{line}',
			compare: `${repo}/branches/compare/{head}%0D{base}`,
			newPullRequest: `${repo}/pull-requests/new?source={head}&dest={base}`
		};
	}
};
