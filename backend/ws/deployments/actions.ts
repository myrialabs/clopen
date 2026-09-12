/**
 * Acting on a deployment, and following one.
 *
 *   deployments:action          redeploy, cancel, roll back or promote
 *   deployments:send-logs       a failed build's log, as chat-ready text
 *   deployments:follow-start    begin streaming a running build's log
 *   deployments:follow-stop     stop one stream
 *
 * `deployments:action` is the only route in this surface that changes anything
 * outward-facing. The CONFIRMATION lives in the client, because that is where a
 * human is: the dialog names the environment and the hostname that will change
 * before this route is ever called. What the server owes in return is an
 * audit-visible log line and an honest status — `pending` when the provider
 * moves traffic asynchronously, never `done` on a promise.
 *
 * Nothing here is reachable by an agent. This surface exposes no MCP tool, so a
 * build is only ever triggered by a person pressing a button.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '$backend/git/git-service';
import { repoPathOf } from '$backend/deployments/bindings';
import {
	buildDeployFailurePrompt,
	deployService,
	startBuildLogStream,
	stopBuildLogStream,
	stopBuildLogStreamsForUser
} from '$backend/deployments';
import { getProvider } from '$backend/integrations';
import { integrationAccountQueries } from '$backend/database/queries';
import type { DeployAction } from '$shared/types/deployments';
import { ws } from '$backend/utils/ws';
import { debug } from '$shared/utils/logger';
import { resolveDeployProject } from './context';
import { announceDeploymentsChanged } from './crud';
import {
	ACTION_RESULT_SCHEMA,
	DEPLOY_ACTION_SCHEMA,
	PROJECT_STATUS_SCHEMA,
	DEPLOY_INFO_SCHEMA,
	DEPLOY_TARGET_SCHEMA,
	NEW_PROJECT_DEFAULTS_SCHEMA
} from './schemas';

const PROJECT_FIELD = { projectId: t.Optional(t.String()) };

/**
 * `owner/repo` for a working tree, or null.
 *
 * Soft on every failure: a project that is not a repository, or has no remote,
 * simply has nothing to suggest — which is a normal state, not an error worth
 * failing a dialog over.
 */
/**
 * The branch checked out right now, or null.
 *
 * Detached HEAD answers null rather than a commit hash: a hash is a valid ref
 * to build, but offering one as a default would silently deploy a commit the
 * user has not named — and on a detached HEAD they almost certainly meant a
 * branch they have yet to pick.
 */
async function localBranch(root: string): Promise<string | null> {
	try {
		const info = await gitService.getBranches(root);
		return info.detached ? null : info.current || null;
	} catch {
		return null;
	}
}

async function localRepoPath(root: string): Promise<string | null> {
	try {
		const remotes = await gitService.getRemotes(root);
		const origin = remotes.find((remote) => remote.name === 'origin') ?? remotes[0];
		return origin ? repoPathOf(origin.fetchUrl || origin.pushUrl) : null;
	} catch {
		return null;
	}
}

export const deploymentsActionsHandler = createRouter()
	.http('deployments:action', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			deploymentId: t.String({ minLength: 1 }),
			action: DEPLOY_ACTION_SCHEMA
		}),
		response: ACTION_RESULT_SCHEMA
	}, async ({ data, conn }) => {
		const { projectId, project } = resolveDeployProject(conn, data.projectId);
		const action = data.action as DeployAction;

		// Logged before the call, not after: if the provider hangs or the process
		// dies mid-request, the record that someone asked for a production change
		// is the thing worth having.
		debug.log(
			'deployments',
			`${ws.getUserId(conn)} requested ${action} on ${data.deploymentId} for project ${project.name}`
		);

		const result = await deployService.runAction(projectId, data.accountId, action, data.deploymentId);
		announceDeploymentsChanged(projectId);
		return result;
	})

	/**
	 * A failed build's log, as the text the chat will send.
	 *
	 * The text is handed BACK to the client rather than injected into a session
	 * here, for the reason the Issues surface hands its prompts back: the chat
	 * pipeline is browser-owned, and a second injection path would race it.
	 */
	.http('deployments:send-logs', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			deploymentId: t.String({ minLength: 1 })
		}),
		response: t.Object({ prompt: t.String() })
	}, async ({ data, conn }) => {
		const { projectId, project } = resolveDeployProject(conn, data.projectId);

		const [deployment, bundle] = await Promise.all([
			deployService.get(projectId, data.accountId, data.deploymentId),
			deployService.fetchLogs(projectId, data.accountId, data.deploymentId)
		]);

		const account = integrationAccountQueries.getById(data.accountId);
		const providerName = account ? getProvider(account.provider)?.name ?? account.provider : 'the provider';

		return {
			prompt: buildDeployFailurePrompt(deployment, bundle, {
				projectName: project.name,
				providerName
			})
		};
	})

	.http('deployments:follow-start', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			deploymentId: t.String({ minLength: 1 })
		}),
		response: t.Object({ streamId: t.String(), backlog: t.String() })
	}, async ({ data, conn }) => {
		const { projectId } = resolveDeployProject(conn, data.projectId);
		const userId = ws.getUserId(conn);

		const started = await startBuildLogStream(projectId, data.accountId, data.deploymentId, userId);
		// The follow belongs to the socket that asked for it: closing the tab must
		// close the request against the provider, not leave it open for the life
		// of the process with nothing listening.
		ws.addCleanup(conn, () => stopBuildLogStreamsForUser(userId));
		return started;
	})

	.http('deployments:follow-stop', {
		data: t.Object({ streamId: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		stopBuildLogStream(data.streamId, ws.getUserId(conn));
		return { ok: true };
	})

	/**
	 * Start a new build.
	 *
	 * Its own route rather than a case of `deployments:action`, because it acts
	 * on a BRANCH rather than on an existing deployment — and a project that has
	 * never been deployed has no deployment to act on. That gap is what made the
	 * panel a dead end for exactly the project a user most wants to get live.
	 */
	.http('deployments:deploy', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			ref: t.String({ minLength: 1, maxLength: 255 }),
			production: t.Boolean()
		}),
		response: ACTION_RESULT_SCHEMA
	}, async ({ data, conn }) => {
		const { projectId, project } = resolveDeployProject(conn, data.projectId);

		debug.log(
			'deployments',
			`${ws.getUserId(conn)} started a ${data.production ? 'production' : 'preview'} build of ${data.ref} for ${project.name}`
		);

		const result = await deployService.createDeployment(projectId, data.accountId, {
			ref: data.ref,
			production: data.production
		});
		announceDeploymentsChanged(projectId);
		return result;
	})

	/**
	 * What the deploy dialog needs, composed from both sides.
	 *
	 * The adapter answers for the REMOTE project; the suggested repository comes
	 * from the LOCAL one. Composing here rather than in the adapter keeps the
	 * adapter free of any notion that a Clopen project has a working tree.
	 */
	.http('deployments:project-status', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 })
		}),
		response: PROJECT_STATUS_SCHEMA
	}, async ({ data, conn }) => {
		const { projectId } = resolveDeployProject(conn, data.projectId);
		return deployService.projectStatus(projectId, data.accountId);
	})

	.http('deployments:deploy-info', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 })
		}),
		response: DEPLOY_INFO_SCHEMA
	}, async ({ data, conn }) => {
		const { projectId, root } = resolveDeployProject(conn, data.projectId);

		// Both run at once. They are independent — one asks the provider about
		// the remote project, the other reads a file in the working tree — and
		// running them in series was half of why this dialog felt slow.
		const [info, suggestedRepo, currentBranch] = await Promise.all([
			deployService.deployInfo(projectId, data.accountId),
			localRepoPath(root),
			localBranch(root)
		]);

		// Only asked when it could matter. A project that already builds has
		// nothing to connect, and the check costs another request.
		const access =
			!info.canDeploy && suggestedRepo
				? await deployService
						.repositoryAccess(projectId, data.accountId, suggestedRepo)
						.catch(() => ({ state: 'unknown' as const, reason: null, actionUrl: null }))
				: { state: 'unavailable' as const, reason: null, actionUrl: null };

		return {
			...info,
			suggestedRepo,
			connectState: access.state,
			connectHint: access.reason,
			connectUrl: access.actionUrl,
			currentBranch
		};
	})

	/**
	 * Attach a git repository to the bound remote project.
	 *
	 * Outward-facing in the sense that matters here: it changes how the remote
	 * project behaves for everyone, and it enables automatic deploys on push. The
	 * dialog that calls it names the repository first.
	 */
	/** Whether a repository could be attached — asked before anything offers it. */
	.http('deployments:repo-access', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			gitRepo: t.String({ minLength: 1, maxLength: 255 })
		}),
		response: t.Object({
			state: t.Union([t.Literal('ready'), t.Literal('blocked'), t.Literal('unknown')]),
			reason: t.Union([t.String(), t.Null()]),
			actionUrl: t.Union([t.String(), t.Null()])
		})
	}, async ({ data, conn }) => {
		const { projectId } = resolveDeployProject(conn, data.projectId);
		return deployService.repositoryAccess(projectId, data.accountId, data.gitRepo);
	})

	.http('deployments:connect-repo', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			gitRepo: t.String({ minLength: 1, maxLength: 255 }),
			gitProvider: t.Optional(t.Union([t.String(), t.Null()]))
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const { projectId, project } = resolveDeployProject(conn, data.projectId);

		debug.log(
			'deployments',
			`${ws.getUserId(conn)} connected ${data.gitRepo} to the deploy target for ${project.name}`
		);

		await deployService.connectRepository(projectId, data.accountId, {
			gitRepo: data.gitRepo,
			gitProvider: data.gitProvider ?? 'github'
		});
		announceDeploymentsChanged(projectId);
		return { ok: true };
	})

	/**
	 * What to prefill the new-project form with.
	 *
	 * Read from the LOCAL project, because it already answers both questions: a
	 * project called `calc-2` that pushes to `acme/calc-2` does not need the user
	 * to retype either. Failures are soft — an empty form is a working form.
	 */
	.http('deployments:new-project-defaults', {
		data: t.Object({ ...PROJECT_FIELD }),
		response: NEW_PROJECT_DEFAULTS_SCHEMA
	}, async ({ data, conn }) => {
		const { project, root } = resolveDeployProject(conn, data.projectId);
		const gitRepo = await localRepoPath(root);

		return {
			// Vercel project names are lowercase and hyphenated; offering a name
			// that will be rejected is worse than offering none.
			suggestedName: project.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''),
			gitRepo,
			gitProvider: gitRepo ? 'github' : null
		};
	})

	.http('deployments:create-project', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			name: t.String({ minLength: 1, maxLength: 100 }),
			gitRepo: t.Optional(t.Union([t.String(), t.Null()])),
			gitProvider: t.Optional(t.Union([t.String(), t.Null()])),
			framework: t.Optional(t.Union([t.String(), t.Null()]))
		}),
		response: DEPLOY_TARGET_SCHEMA
	}, async ({ data, conn }) => {
		const { projectId, project } = resolveDeployProject(conn, data.projectId);

		debug.log('deployments', `${ws.getUserId(conn)} created a deploy project for ${project.name}`);

		const target = await deployService.createProject(projectId, data.accountId, {
			name: data.name,
			gitRepo: data.gitRepo ?? null,
			gitProvider: data.gitProvider ?? null,
			framework: data.framework ?? null
		});
		announceDeploymentsChanged(projectId);
		return target;
	})

	.emit('deployments:log-chunk', t.Object({
		streamId: t.String(),
		deploymentId: t.String(),
		data: t.String(),
		/** Stage the provider reports, pushed the moment it changes. */
		phase: t.Optional(t.String()),
		done: t.Optional(t.Boolean()),
		error: t.Optional(t.Union([t.String(), t.Null()]))
	}));
