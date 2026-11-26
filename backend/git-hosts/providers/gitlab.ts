/**
 * GitLab (gitlab.com and self-managed) as a repository host.
 *
 * Where GitLab differs from GitHub, it differs here and nowhere else:
 * repositories are "projects", owners are users or (nested) GROUPS, so a
 * locator is a full path of any depth, and a namespace is addressed by id
 * when creating into it.
 */

import type { CommitCiState, CommitCiStatus, HostedRepo, HostOwner, HostViewer } from '$shared/types/git-hosting';
import { HostApiError, mapLimited, waitFor } from '../http';
import { hostOfBase, parseRemoteUrl } from '../urls';
import type { CreateRepoInput, GitHostAdapter, HostCredentials, RepoQuery } from '../types';
import { gitlabRequest, gitlabWebBase, projectRef } from './gitlab-client';

const REQUIRED_SCOPES = ['api', 'write_repository'];

interface GitLabProjectWire {
	id: number;
	path_with_namespace: string;
	path: string;
	name: string;
	namespace: { full_path: string; kind?: string };
	description: string | null;
	visibility: 'private' | 'internal' | 'public';
	forked_from_project?: { path_with_namespace: string } | null;
	default_branch?: string | null;
	http_url_to_repo: string;
	ssh_url_to_repo?: string | null;
	web_url: string;
	last_activity_at?: string;
	import_status?: string;
	permissions?: {
		project_access?: { access_level: number } | null;
		group_access?: { access_level: number } | null;
	};
}

/** Developer (30) is the lowest role that may push to an unprotected branch. */
const DEVELOPER = 30;

function toRepo(raw: GitLabProjectWire): HostedRepo {
	const access = Math.max(
		raw.permissions?.project_access?.access_level ?? 0,
		raw.permissions?.group_access?.access_level ?? 0
	);
	return {
		fullName: raw.path_with_namespace,
		owner: raw.namespace.full_path,
		name: raw.path,
		description: raw.description,
		// `internal` is visible to every signed-in user of the instance, which is
		// not what anyone means by public.
		isPrivate: raw.visibility !== 'public',
		isFork: !!raw.forked_from_project,
		parentFullName: raw.forked_from_project?.path_with_namespace ?? null,
		defaultBranch: raw.default_branch ?? null,
		cloneUrlHttps: raw.http_url_to_repo,
		cloneUrlSsh: raw.ssh_url_to_repo ?? null,
		webUrl: raw.web_url,
		updatedAt: raw.last_activity_at ?? null,
		canPush: raw.permissions ? access >= DEVELOPER : null
	};
}

function pipelineState(status: string | undefined): CommitCiState {
	switch (status) {
		case 'success':
			return 'success';
		case 'failed':
			return 'failure';
		case 'running':
		case 'pending':
		case 'created':
		case 'preparing':
		case 'waiting_for_resource':
		case 'waiting_for_callback':
		case 'scheduled':
		case 'manual':
			return 'pending';
		default:
			return 'none';
	}
}

const REPO_PAGE = 50;

export const gitlabHost: GitHostAdapter = {
	kind: 'gitlab',
	serviceName: 'GitLab',

	webBase: (credentials) => gitlabWebBase(credentials),
	host: (credentials) => hostOfBase(gitlabWebBase(credentials)),

	locatorFromRemote(url, credentials) {
		const parsed = parseRemoteUrl(url);
		if (!parsed || parsed.host !== this.host(credentials)) return null;
		// Every segment counts: `group/subgroup/project` is one project.
		const parts = parsed.path.split('/').filter(Boolean);
		return parts.length >= 2 ? parts.join('/') : null;
	},

	gitUsername: () => 'oauth2',

	async viewer(credentials): Promise<HostViewer> {
		const user = await gitlabRequest<{ username: string; name: string | null; avatar_url: string | null }>(credentials, '/user');

		// A personal access token can describe itself; an OAuth token describes
		// itself through a different endpoint at the server root. Either way the
		// answer is the scope list — and if neither works, the scopes are simply
		// not reported rather than reported as all missing.
		let scopes: string[] | null = null;
		try {
			const self = await gitlabRequest<{ scopes?: string[] }>(credentials, '/personal_access_tokens/self');
			scopes = self.data.scopes ?? null;
		} catch {
			try {
				const info = await gitlabRequest<{ scope?: string[]; scopes?: string[] }>(
					credentials,
					`${gitlabWebBase(credentials)}/oauth/token/info`
				);
				scopes = info.data.scope ?? info.data.scopes ?? null;
			} catch {
				scopes = null;
			}
		}

		return {
			login: user.data.username,
			name: user.data.name,
			avatarUrl: user.data.avatar_url,
			scopes,
			missingScopes: scopes ? REQUIRED_SCOPES.filter((scope) => !scopes!.includes(scope)) : []
		};
	},

	async listOwners(credentials): Promise<HostOwner[]> {
		const [user, groups] = await Promise.all([
			gitlabRequest<{ username: string; name: string | null; avatar_url: string | null }>(credentials, '/user'),
			// Developer is the lowest role that can create a project in a group
			// whose settings allow it; anything lower is offered and then refused.
			gitlabRequest<{ full_path: string; full_name: string; avatar_url: string | null }[]>(
				credentials,
				`/groups?min_access_level=${DEVELOPER}&per_page=100&order_by=path`
			)
		]);
		return [
			{ login: user.data.username, kind: 'user', name: user.data.name, avatarUrl: user.data.avatar_url },
			...(groups.data ?? []).map((group): HostOwner => ({
				login: group.full_path,
				kind: 'org',
				name: group.full_name,
				avatarUrl: group.avatar_url
			}))
		];
	},

	async listRepos(credentials, query: RepoQuery) {
		const params = new URLSearchParams({
			membership: 'true',
			order_by: 'last_activity_at',
			per_page: String(REPO_PAGE),
			page: String(query.page),
			simple: 'false'
		});
		if (query.search?.trim()) params.set('search', query.search.trim());

		const path = query.owner
			? `/groups/${projectRef(query.owner)}/projects?include_subgroups=true&${params.toString()}`
			: `/projects?${params.toString()}`;
		// A user namespace is not a group; asking the groups endpoint for one is
		// a 404, so a user owner lists their own projects instead.
		const viewer = query.owner
			? await gitlabRequest<{ username: string }>(credentials, '/user').then((r) => r.data.username).catch(() => '')
			: '';
		const resolved = query.owner && query.owner === viewer
			? `/users/${encodeURIComponent(viewer)}/projects?${params.toString()}`
			: path;

		const response = await gitlabRequest<GitLabProjectWire[]>(credentials, resolved);
		return { repos: (response.data ?? []).map(toRepo), hasMore: response.nextPage !== null };
	},

	async getRepo(credentials, locator) {
		const response = await gitlabRequest<GitLabProjectWire>(credentials, `/projects/${projectRef(locator)}`);
		return toRepo(response.data);
	},

	async createRepo(credentials, input: CreateRepoInput) {
		let namespaceId: number | undefined;
		if (input.owner.kind === 'org') {
			const group = await gitlabRequest<{ id: number }>(credentials, `/groups/${projectRef(input.owner.login)}`);
			namespaceId = group.data.id;
		}
		const response = await gitlabRequest<GitLabProjectWire>(credentials, '/projects', {
			method: 'POST',
			body: {
				name: input.name,
				path: input.name,
				description: input.description || undefined,
				visibility: input.isPrivate ? 'private' : 'public',
				...(namespaceId !== undefined && { namespace_id: namespaceId }),
				initialize_with_readme: false
			}
		});
		return toRepo(response.data);
	},

	async fork(credentials, locator) {
		const response = await gitlabRequest<GitLabProjectWire>(credentials, `/projects/${projectRef(locator)}/fork`, {
			method: 'POST',
			body: {}
		});
		const id = response.data.id;
		// A fork is an import job; until it finishes the repository is empty and
		// a push to it would race the copy.
		const ready = await waitFor(async () => {
			const check = await gitlabRequest<GitLabProjectWire>(credentials, `/projects/${id}`);
			const status = check.data.import_status;
			if (status === 'failed') throw new HostApiError('GitLab could not create the fork', 0, 'error');
			return !status || status === 'finished' || status === 'none' ? toRepo(check.data) : null;
		}, 120_000, 2000);
		if (!ready) throw new HostApiError('GitLab is still creating the fork. Try again in a minute.', 0, 'error');
		return ready;
	},

	async commitStatuses(credentials, locator, shas): Promise<CommitCiStatus[]> {
		return mapLimited(shas, 4, async (sha): Promise<CommitCiStatus> => {
			try {
				const commit = await gitlabRequest<{ last_pipeline?: { status?: string; web_url?: string } | null }>(
					credentials,
					`/projects/${projectRef(locator)}/repository/commits/${encodeURIComponent(sha)}`
				);
				const pipeline = commit.data.last_pipeline;
				const state = pipelineState(pipeline?.status);
				return {
					sha,
					state,
					url: pipeline?.web_url ?? null,
					summary: pipeline?.status ? `Pipeline ${pipeline.status.replace(/_/g, ' ')}` : 'No pipeline'
				};
			} catch {
				// A commit the server has never seen (not pushed yet) is a 404,
				// which is "no CI", not an error worth showing.
				return { sha, state: 'none', url: null, summary: 'No pipeline' };
			}
		});
	},

	links(credentials, locator) {
		const repo = `${gitlabWebBase(credentials)}/${locator}`;
		return {
			repo,
			commit: `${repo}/-/commit/{sha}`,
			branch: `${repo}/-/tree/{branch}`,
			file: `${repo}/-/blob/{ref}/{path}`,
			fileLine: '#L{line}',
			compare: `${repo}/-/compare/{base}...{head}`,
			newPullRequest: `${repo}/-/merge_requests/new?merge_request%5Bsource_branch%5D={head}&merge_request%5Btarget_branch%5D={base}`
		};
	},

	templates: {
		async gitignoreList(credentials) {
			const response = await gitlabRequest<{ key: string; name: string }[]>(credentials, '/templates/gitignores?per_page=100');
			return (response.data ?? []).map((entry) => ({ key: entry.key, name: entry.name }));
		},
		async gitignore(credentials, key) {
			const response = await gitlabRequest<{ content: string }>(credentials, `/templates/gitignores/${encodeURIComponent(key)}`);
			return response.data.content;
		},
		async licenseList(credentials) {
			const response = await gitlabRequest<{ key: string; name: string }[]>(credentials, '/templates/licenses?per_page=100');
			return (response.data ?? []).map((entry) => ({ key: entry.key, name: entry.name }));
		},
		async license(credentials, key, holder) {
			const params = new URLSearchParams({ fullname: holder.fullname });
			const response = await gitlabRequest<{ content: string }>(
				credentials,
				`/templates/licenses/${encodeURIComponent(key)}?${params.toString()}`
			);
			return response.data.content.replace(/\[year\]/g, holder.year);
		}
	}
};
