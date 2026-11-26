/**
 * Git hosting routes — what the Git panel asks about the service a repository
 * lives on.
 *
 *   hosting:context          remotes matched to accounts, in one call (no network)
 *   hosting:viewer           who an account is, and which scopes it lacks
 *   hosting:owners           where a repository can be created
 *   hosting:repos            repositories to pick from, for Add Remote
 *   hosting:templates        .gitignore and license choices for Publish
 *   hosting:publish          create the repository, add the remote, push
 *   hosting:fork             fork the remote's repository and push there
 *   hosting:can-push         whether a push refusal is a permission problem
 *   hosting:commit-statuses  CI roll-up per commit, for the history list
 *
 * Importing `$backend/git-hosts` wires the hosting layer's one side effect —
 * terminals' git config follows account changes — so merging this router is
 * what switches hosting on.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { hostingService } from '$backend/git-hosts';
import { gitRepoContext, withRepoLock } from '../git/repo-context';
import { requireProjectWorkspace } from '../access';

const HOST_KIND_SCHEMA = t.Union([t.Literal('github'), t.Literal('gitlab'), t.Literal('gitea'), t.Literal('bitbucket')]);
const STATUS_SCHEMA = t.Union([
	t.Literal('unknown'),
	t.Literal('ok'),
	t.Literal('needs_auth'),
	t.Literal('needs_config'),
	t.Literal('error')
]);

const LINKS_SCHEMA = t.Object({
	repo: t.String(),
	commit: t.String(),
	branch: t.String(),
	file: t.String(),
	fileLine: t.String(),
	compare: t.String(),
	newPullRequest: t.String()
});

const ACCOUNT_SCHEMA = t.Object({
	accountId: t.String(),
	provider: HOST_KIND_SCHEMA,
	providerName: t.String(),
	label: t.String(),
	host: t.String(),
	login: t.Union([t.String(), t.Null()]),
	offersWork: t.Boolean(),
	status: STATUS_SCHEMA,
	statusDetail: t.Union([t.String(), t.Null()])
});

const REPO_SCHEMA = t.Object({
	fullName: t.String(),
	owner: t.String(),
	name: t.String(),
	description: t.Union([t.String(), t.Null()]),
	isPrivate: t.Boolean(),
	isFork: t.Boolean(),
	parentFullName: t.Union([t.String(), t.Null()]),
	defaultBranch: t.Union([t.String(), t.Null()]),
	cloneUrlHttps: t.String(),
	cloneUrlSsh: t.Union([t.String(), t.Null()]),
	webUrl: t.String(),
	updatedAt: t.Union([t.String(), t.Null()]),
	canPush: t.Union([t.Boolean(), t.Null()])
});

const OPTION_SCHEMA = t.Object({ key: t.String(), name: t.String() });

export const hostingRouter = createRouter()
	.http('hosting:context', {
		data: t.Object({ projectId: t.String() }),
		response: t.Object({
			remotes: t.Array(t.Object({
				name: t.String(),
				url: t.String(),
				host: t.Union([t.String(), t.Null()]),
				provider: t.Union([HOST_KIND_SCHEMA, t.Null()]),
				locator: t.Union([t.String(), t.Null()]),
				accountId: t.Union([t.String(), t.Null()]),
				links: t.Union([LINKS_SCHEMA, t.Null()]),
				defaultBranch: t.Union([t.String(), t.Null()])
			})),
			accounts: t.Array(ACCOUNT_SCHEMA),
			primaryRemote: t.Union([t.String(), t.Null()]),
			unservedProvider: t.Union([t.Object({ provider: HOST_KIND_SCHEMA, host: t.String() }), t.Null()])
		})
	}, async ({ data, conn }) => {
		const { project, root } = requireProjectWorkspace(conn, data.projectId);
		return hostingService.context(project.id, root);
	})

	.http('hosting:viewer', {
		data: t.Object({ accountId: t.String({ minLength: 1 }) }),
		response: t.Object({
			login: t.String(),
			name: t.Union([t.String(), t.Null()]),
			avatarUrl: t.Union([t.String(), t.Null()]),
			scopes: t.Union([t.Array(t.String()), t.Null()]),
			missingScopes: t.Array(t.String())
		})
	}, async ({ data }) => hostingService.viewer(data.accountId))

	.http('hosting:owners', {
		data: t.Object({ projectId: t.String(), accountId: t.String({ minLength: 1 }) }),
		response: t.Array(t.Object({
			login: t.String(),
			kind: t.Union([t.Literal('user'), t.Literal('org')]),
			name: t.Union([t.String(), t.Null()]),
			avatarUrl: t.Union([t.String(), t.Null()])
		}))
	}, async ({ data, conn }) => {
		const { project } = requireProjectWorkspace(conn, data.projectId);
		return hostingService.owners(data.accountId, project.id);
	})

	.http('hosting:repos', {
		data: t.Object({
			projectId: t.String(),
			accountId: t.String({ minLength: 1 }),
			search: t.Optional(t.String({ maxLength: 200 })),
			owner: t.Optional(t.String({ maxLength: 200 })),
			page: t.Optional(t.Number({ minimum: 1, maximum: 100 }))
		}),
		response: t.Object({ repos: t.Array(REPO_SCHEMA), hasMore: t.Boolean() })
	}, async ({ data, conn }) => {
		const { project } = requireProjectWorkspace(conn, data.projectId);
		return hostingService.repos(data.accountId, project.id, {
			search: data.search,
			owner: data.owner,
			page: data.page ?? 1
		});
	})

	.http('hosting:templates', {
		data: t.Object({ projectId: t.String(), accountId: t.String({ minLength: 1 }) }),
		response: t.Object({
			gitignore: t.Array(OPTION_SCHEMA),
			licenses: t.Array(OPTION_SCHEMA),
			suggestedGitignore: t.Union([t.String(), t.Null()]),
			existing: t.Object({ gitignore: t.Boolean(), license: t.Boolean(), readme: t.Boolean() }),
			needsFirstCommit: t.Boolean(),
			pendingFiles: t.Number()
		})
	}, async ({ data, conn }) => {
		const { project, root } = requireProjectWorkspace(conn, data.projectId);
		return hostingService.templates(data.accountId, project.id, root);
	})

	.http('hosting:publish', {
		data: t.Object({
			projectId: t.String(),
			accountId: t.String({ minLength: 1 }),
			owner: t.String({ minLength: 1 }),
			name: t.String({ minLength: 1, maxLength: 100 }),
			description: t.String({ maxLength: 350 }),
			isPrivate: t.Boolean(),
			remoteName: t.String({ maxLength: 64 }),
			gitignore: t.Union([t.String(), t.Null()]),
			license: t.Union([t.String(), t.Null()]),
			readme: t.Boolean(),
			createFirstCommit: t.Boolean(),
			protocol: t.Union([t.Literal('https'), t.Literal('ssh')])
		}),
		response: t.Object({
			repo: REPO_SCHEMA,
			remoteName: t.String(),
			pushed: t.Boolean(),
			pushMessage: t.Union([t.String(), t.Null()])
		})
	}, async ({ data, conn }) => {
		debug.log('path', `hosting:publish ${data.owner}/${data.name}`);
		const ctx = gitRepoContext(conn, data.projectId);
		return withRepoLock(ctx, { category: 'push', label: 'Publish', target: data.name }, () =>
			hostingService.publish(ctx.projectId, ctx.root, data));
	})

	.http('hosting:fork', {
		data: t.Object({
			projectId: t.String(),
			accountId: t.String({ minLength: 1 }),
			remote: t.String({ minLength: 1 })
		}),
		response: t.Object({
			fork: REPO_SCHEMA,
			forkRemote: t.String(),
			upstreamRemote: t.Union([t.String(), t.Null()]),
			pushed: t.Boolean(),
			pushMessage: t.Union([t.String(), t.Null()])
		})
	}, async ({ data, conn }) => {
		debug.log('path', `hosting:fork ${data.remote}`);
		const ctx = gitRepoContext(conn, data.projectId);
		return withRepoLock(ctx, { category: 'push', label: 'Fork', target: data.remote }, () =>
			hostingService.fork(ctx.projectId, ctx.root, { accountId: data.accountId, remote: data.remote }));
	})

	.http('hosting:can-push', {
		data: t.Object({ projectId: t.String(), remote: t.String({ minLength: 1 }) }),
		response: t.Object({
			canPush: t.Union([t.Boolean(), t.Null()]),
			accountId: t.Union([t.String(), t.Null()]),
			repo: t.Union([REPO_SCHEMA, t.Null()])
		})
	}, async ({ data, conn }) => {
		const { project, root } = requireProjectWorkspace(conn, data.projectId);
		return hostingService.canPush(project.id, root, data.remote);
	})

	.http('hosting:commit-statuses', {
		data: t.Object({
			projectId: t.String(),
			remote: t.Optional(t.String()),
			shas: t.Array(t.String({ pattern: '^[0-9a-fA-F]{7,64}$' }), { maxItems: 60 })
		}),
		response: t.Array(t.Object({
			sha: t.String(),
			state: t.Union([t.Literal('success'), t.Literal('failure'), t.Literal('pending'), t.Literal('none')]),
			url: t.Union([t.String(), t.Null()]),
			summary: t.String()
		}))
	}, async ({ data, conn }) => {
		const { project, root } = requireProjectWorkspace(conn, data.projectId);
		return hostingService.commitStatuses(project.id, root, data.remote ?? null, data.shas);
	});
