/**
 * Vercel — the first provider behind the Deployments surface.
 *
 * Three things here are Vercel facts that the interface deliberately absorbs so
 * no other provider inherits them:
 *
 * TEAMS. One token reaches a personal account and every team the user belongs
 * to, and a request that omits `teamId` simply does not see that team's
 * projects — an empty list, not an error. So the team travels on the BINDING,
 * not on the account: which team a project belongs to is a fact about the
 * project you picked, and putting it on the credential would force a second
 * connect for a second team with the same token.
 *
 * PREVIEW IS NOT A FILTER. `target` is `production` for a production build and
 * NULL for a preview one; there is no `target=preview` to send. Production
 * filters server-side, everything else is filtered here — which means a page
 * can come back nearly empty on a busy project, so the filtered paths fill the
 * page rather than returning whatever survived one request. That is the same
 * mistake the Issues list made with `state=all`, fixed here before it shipped.
 *
 * LIVE IS NOT A STATE. `readyState: READY` and `target: production` together do
 * not mean a build is serving traffic — a superseded or rolled-back-away-from
 * deployment is both. The project's `targets.production.id` is the only honest
 * answer, so it is read once per list and passed down.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type {
	BuildLogBundle,
	Deployment,
	DeploymentDetail,
	DeploymentDraft,
	DeploymentPage,
	DeployProjectStatus,
	DeployTarget,
	NewProjectDraft
} from '$shared/types/deployments';
import type {
	AdapterDeployInfo,
	DeployContext,
	RepositoryAccess,
	DeployProviderAdapter,
	DeploymentQuery,
	LogStreamCallbacks,
	LogStreamHandle,
	ResolvedDeployBinding,
	UnboundDeployContext
} from '../../types';
import { vercelRequest, VercelError, type VercelCredentials } from './client';
import { durationOf, toDeployment, toEnvironment } from './normalise';
import { fetchBuildLogs, streamBuildLogs } from './build-logs';
import type {
	VercelDeployment,
	VercelGitNamespace,
	VercelDeploymentList,
	VercelProject,
	VercelProjectList,
	VercelTeamList,
	VercelUser
} from './types';
import { debug } from '$shared/utils/logger';

/** Rows asked for per provider request. */
const PAGE_SIZE = 20;
/**
 * Provider requests one filtered page may spend.
 *
 * Bounded because the preview filter discards rows: on a project that deploys
 * production hourly, filling a page of previews could otherwise walk the whole
 * deployment history. Four pages is enough to fill a screen and small enough to
 * be invisible on the rate limit.
 */
const MAX_FILL_REQUESTS = 4;
/** Teams scanned when listing targets, so a large org cannot fan out unbounded. */
const MAX_TEAMS = 20;

function credentialsOf(context: UnboundDeployContext): VercelCredentials {
	return { token: context.credentials.token ?? '' };
}

/** `owner/repo` for a project's connected repository, when it has one. */
function repoOf(project: VercelProject): string | null {
	const org = project.link?.org;
	const repo = project.link?.repo;
	return org && repo ? `${org}/${repo}` : null;
}

function toTarget(project: VercelProject, team: { id: string; name: string } | null): DeployTarget {
	return {
		id: project.id,
		name: project.name,
		teamId: team?.id ?? null,
		teamName: team?.name ?? null,
		framework: project.framework ?? null,
		gitRepo: repoOf(project)
	};
}

/** The project row, which is also where "what is live" is read from. */
async function fetchProject(
	credentials: VercelCredentials,
	locator: string,
	teamId: string | null
): Promise<VercelProject> {
	const response = await vercelRequest<VercelProject>(
		credentials,
		`/v9/projects/${encodeURIComponent(locator)}`,
		{ query: { teamId: teamId ?? undefined } }
	);
	return response.data;
}

function currentProductionIdOf(project: VercelProject): string | null {
	const production = project.targets?.production;
	return production?.id ?? null;
}

export const vercelDeployAdapter: DeployProviderAdapter = {
	provider: 'vercel',

	capabilities: {
		logs: true,
		streamLogs: true,
		createDeployment: true,
		createProject: true,
		connectRepository: true,
		deleteDeployment: true,
		redeploy: true,
		cancel: true,
		rollback: true,
		promote: true,
		environments: true,
		branchFilter: true
	},

	/**
	 * Read `.vercel/project.json`, which `vercel link` writes.
	 *
	 * `orgId` is a team id only when it looks like one: a personal account's id
	 * is also stored in that field, and sending it as `teamId` turns every
	 * subsequent call into a 403 for a team the user does not belong to.
	 */
	async detectFromProject(projectRoot: string) {
		try {
			const raw = await readFile(join(projectRoot, '.vercel', 'project.json'), 'utf8');
			const parsed = JSON.parse(raw) as { projectId?: unknown; orgId?: unknown };
			if (typeof parsed.projectId !== 'string' || !parsed.projectId) return null;

			const orgId = typeof parsed.orgId === 'string' ? parsed.orgId : '';
			return {
				locator: parsed.projectId,
				teamId: orgId.startsWith('team_') ? orgId : null
			};
		} catch {
			// No link file, or one we cannot read. Both mean "nothing to detect".
			return null;
		}
	},

	/**
	 * Every project this credential can reach, each one once.
	 *
	 * The scoped listing and the default listing OVERLAP. `/v10/projects` with no
	 * `teamId` returns the token's default scope, and when that default is one of
	 * the user's teams the same project also arrives under that team — so a naive
	 * concatenation lists it twice.
	 *
	 * Which copy survives is the part that matters, and it is not a tie. A
	 * project id is globally unique, so the two entries describe one project, but
	 * only one of them carries the `teamId` that every later call needs: reading
	 * the deployment list, the logs and every action all 404 for a team project
	 * addressed without its team. So a team-scoped entry always replaces an
	 * unscoped one, never the other way round. Position is kept, because the
	 * caller orders these by git-remote match afterwards.
	 */
	async listTargets(context) {
		const credentials = credentialsOf(context);
		const byId = new Map<string, DeployTarget>();

		const add = (target: DeployTarget): void => {
			const existing = byId.get(target.id);
			if (existing && existing.teamId !== null && target.teamId === null) return;
			byId.set(target.id, target);
		};

		const personal = await vercelRequest<VercelProjectList>(credentials, '/v10/projects', {
			query: { limit: 100 }
		});
		for (const project of personal.data?.projects ?? []) add(toTarget(project, null));

		let teams: VercelTeamList['teams'] = [];
		try {
			const response = await vercelRequest<VercelTeamList>(credentials, '/v2/teams', {
				query: { limit: MAX_TEAMS }
			});
			teams = response.data?.teams ?? [];
		} catch (error) {
			// A token scoped to one project cannot list teams, and that is not a
			// reason to show the user nothing — the default-scope projects stand.
			debug.log('deployments', 'Could not list Vercel teams:', error);
		}

		for (const team of teams.slice(0, MAX_TEAMS)) {
			try {
				const response = await vercelRequest<VercelProjectList>(credentials, '/v10/projects', {
					query: { limit: 100, teamId: team.id }
				});
				const label = { id: team.id, name: team.name || team.slug || team.id };
				for (const project of response.data?.projects ?? []) add(toTarget(project, label));
			} catch (error) {
				debug.log('deployments', `Could not list projects for team ${team.id}:`, error);
			}
		}

		return [...byId.values()];
	},

	async describeTarget(context, locator, teamId) {
		try {
			const project = await fetchProject(credentialsOf(context), locator, teamId);
			return toTarget(project, teamId ? { id: teamId, name: teamId } : null);
		} catch (error) {
			debug.log('deployments', `Could not describe Vercel project ${locator}:`, error);
			return null;
		}
	},

	/**
	 * Two questions, answered separately.
	 *
	 * Whether the token works at all, and whether it reaches the bound project.
	 * Collapsing them would report a perfectly good token as broken because a
	 * project was deleted, and send the user to re-issue a credential that was
	 * never the problem.
	 */
	async probe(context, binding: ResolvedDeployBinding | null) {
		const credentials = credentialsOf(context);
		if (!credentials.token) {
			return { status: 'needs_auth' as const, detail: 'No access token is stored for this account.' };
		}

		let viewer: string | null = null;
		try {
			const response = await vercelRequest<VercelUser>(credentials, '/v2/user');
			viewer = response.data?.user?.username ?? response.data?.user?.email ?? null;
		} catch (error) {
			if (error instanceof VercelError) {
				return {
					status: error.kind === 'auth' ? ('needs_auth' as const) : ('error' as const),
					detail: error.message
				};
			}
			return { status: 'error' as const, detail: error instanceof Error ? error.message : String(error) };
		}

		if (!binding) {
			return {
				status: 'ok' as const,
				detail: viewer ? `Signed in as ${viewer}. No project is bound yet.` : 'No project is bound yet.'
			};
		}

		try {
			const project = await fetchProject(credentials, binding.locator, binding.teamId);
			return { status: 'ok' as const, detail: `${viewer ? `${viewer} · ` : ''}${project.name}` };
		} catch (error) {
			const detail = error instanceof VercelError ? error.message : String(error);
			return { status: 'needs_config' as const, detail };
		}
	},

	async list(context: DeployContext, query: DeploymentQuery): Promise<DeploymentPage> {
		const credentials = credentialsOf(context);
		const { locator, teamId } = context.binding;

		const project = await fetchProject(credentials, locator, teamId);
		const currentProductionId = currentProductionIdOf(project);

		const limit = query.limit ?? PAGE_SIZE;
		const wantsServerFilter = query.environment === 'production';

		const items: Deployment[] = [];
		// A row seen twice across fill iterations is a crash, not a cosmetic
		// problem: the list is keyed by id, and a build landing mid-fill can shift
		// the timestamp window so a page repeats one.
		const seen = new Set<string>();
		let cursor = query.cursor ? Number(query.cursor) : undefined;
		let rateLimit = null as DeploymentPage['rateLimit'];
		let hasMore = false;
		let requests = 0;

		// Fill the page rather than returning whatever one request left behind.
		// The preview and custom filters discard rows after the fact, so a single
		// request against a production-heavy project can answer with almost
		// nothing while more pages clearly exist.
		while (items.length < limit && requests < MAX_FILL_REQUESTS) {
			requests += 1;

			const response = await vercelRequest<VercelDeploymentList>(credentials, '/v7/deployments', {
				query: {
					projectId: locator,
					teamId: teamId ?? undefined,
					limit,
					until: cursor,
					target: wantsServerFilter ? 'production' : undefined,
					branch: query.branch || undefined
				}
			});
			rateLimit = response.rateLimit ?? rateLimit;

			const page = response.data?.deployments ?? [];
			for (const raw of page) {
				const deployment = toDeployment(raw, currentProductionId);
				if (query.environment !== 'all' && deployment.environment !== query.environment) continue;
				if (seen.has(deployment.id)) continue;
				if (items.length >= limit) break;
				seen.add(deployment.id);
				items.push(deployment);
			}

			const next = response.data?.pagination?.next ?? null;
			if (next === null) {
				hasMore = false;
				cursor = undefined;
				break;
			}
			cursor = next;
			hasMore = true;
		}

		return {
			items,
			hasMore,
			// The cursor is where the FILL stopped, not `page + 1`. Resuming from
			// anywhere else re-reads rows this page already discarded.
			nextCursor: hasMore && cursor !== undefined ? String(cursor) : null,
			rateLimit
		};
	},

	async get(context: DeployContext, id: string): Promise<DeploymentDetail> {
		const credentials = credentialsOf(context);
		const { locator, teamId } = context.binding;

		const [detail, project] = await Promise.all([
			vercelRequest<VercelDeployment>(credentials, `/v13/deployments/${encodeURIComponent(id)}`, {
				query: { withGitRepoInfo: 1, teamId: teamId ?? undefined }
			}),
			fetchProject(credentials, locator, teamId)
		]);

		const raw = detail.data;
		const base = toDeployment(raw, currentProductionIdOf(project));

		return {
			...base,
			// Ordered here, not in the panel. The first alias is the one a reader
			// should be shown, and deciding which that is takes Vercel knowledge:
			// the custom domain is short (`acme.com`) while the generated ones
			// carry the branch and a build hash (`acme-git-fix-x-team.vercel.app`).
			// Shortest-first encodes that without the panel having to know it, and
			// a provider whose aliases do not work that way sorts its own.
			aliases: [...(raw.alias ?? [])].sort((a, b) => a.length - b.length),
			framework: raw.projectSettings?.framework ?? project.framework ?? null,
			durationMs: durationOf(raw)
		};
	},

	fetchLogs(context: DeployContext, id: string): Promise<BuildLogBundle> {
		return fetchBuildLogs(credentialsOf(context), id, context.binding.teamId);
	},

	streamLogs(context: DeployContext, id: string, callbacks: LogStreamCallbacks): Promise<LogStreamHandle> {
		return streamBuildLogs(credentialsOf(context), id, context.binding.teamId, callbacks);
	},

	/**
	 * Rebuild an existing deployment.
	 *
	 * `forceNew=1` because without it Vercel deduplicates against an identical
	 * recent deployment and hands back the one that already exists — which for a
	 * user who pressed "Redeploy" to retry a flaky build looks exactly like the
	 * button doing nothing. The environment is carried over explicitly so
	 * redeploying a production build does not quietly produce a preview.
	 */
	async redeploy(context: DeployContext, id: string) {
		const credentials = credentialsOf(context);
		const { teamId } = context.binding;

		const existing = await vercelRequest<VercelDeployment>(
			credentials,
			`/v13/deployments/${encodeURIComponent(id)}`,
			{ query: { teamId: teamId ?? undefined } }
		);
		const source = existing.data;

		const created = await vercelRequest<VercelDeployment>(credentials, '/v13/deployments', {
			method: 'POST',
			query: { forceNew: 1, teamId: teamId ?? undefined },
			body: {
				name: source.name,
				deploymentId: id,
				target: toEnvironment(source) === 'production' ? 'production' : undefined
			}
		});

		const newId = created.data?.uid ?? created.data?.id ?? null;
		return { deploymentId: newId, message: 'A new build has been queued.' };
	},

	async cancel(context: DeployContext, id: string) {
		await vercelRequest(credentialsOf(context), `/v12/deployments/${encodeURIComponent(id)}/cancel`, {
			method: 'PATCH',
			query: { teamId: context.binding.teamId ?? undefined }
		});
		return { message: 'The build has been cancelled.' };
	},

	/**
	 * Point production traffic back at an earlier build.
	 *
	 * Reported as PENDING, not done. Vercel accepts the request and moves the
	 * aliases afterwards; the outcome is read from the project's
	 * `lastAliasRequest.jobStatus`. Saying "done" here would tell someone their
	 * production incident was over while the old build was still serving.
	 */
	async rollback(context: DeployContext, id: string) {
		const { locator, teamId } = context.binding;
		await vercelRequest(
			credentialsOf(context),
			`/v1/projects/${encodeURIComponent(locator)}/rollback/${encodeURIComponent(id)}`,
			{ method: 'POST', query: { teamId: teamId ?? undefined } }
		);
		return {
			status: 'pending' as const,
			message: 'Rollback requested. Production traffic moves once Vercel reassigns the domains.'
		};
	},

	async promote(context: DeployContext, id: string) {
		const { locator, teamId } = context.binding;
		await vercelRequest(
			credentialsOf(context),
			`/v10/projects/${encodeURIComponent(locator)}/promote/${encodeURIComponent(id)}`,
			{ method: 'POST', query: { teamId: teamId ?? undefined } }
		);
		return {
			status: 'pending' as const,
			message: 'Promotion requested. Production traffic moves once Vercel reassigns the domains.'
		};
	},

	/**
	 * Can a build be started here, and from which branch by default.
	 *
	 * A Vercel project with no git connection can only be deployed by uploading
	 * a file tree, which is what the CLI does and is not something this surface
	 * should grow. Saying so plainly beats a Deploy button that fails.
	 */
	async deployInfo(context: DeployContext): Promise<AdapterDeployInfo> {
		const { locator, teamId } = context.binding;
		const project = await fetchProject(credentialsOf(context), locator, teamId);
		const repo = repoOf(project);

		if (!repo || !project.link?.repoId) {
			return {
				gitRepo: repo,
				productionBranch: project.link?.productionBranch ?? null,
				canDeploy: false,
				reason:
					'This Vercel project is not connected to a git repository, so a build can only be started by uploading files with the Vercel CLI.'
			};
		}

		return {
			gitRepo: repo,
			// Vercel leaves this null when the repository's default branch is
			// being used, which is `main` far more often than anything else.
			productionBranch: project.link.productionBranch ?? 'main',
			canDeploy: true,
			reason: null
		};
	},

	/**
	 * Start a build from a branch.
	 *
	 * `project` rather than `name` identifies the target: the docs note that
	 * `project` overrides `name`, and a name alone would CREATE a project when
	 * it does not match an existing one — silently making a second project
	 * beside the one the user is bound to.
	 *
	 * Omitting `target` yields a preview build, which is what "not production"
	 * means here. There is no `target: 'preview'` to send.
	 */
	async createDeployment(context: DeployContext, draft: DeploymentDraft) {
		const credentials = credentialsOf(context);
		const { locator, teamId } = context.binding;

		const project = await fetchProject(credentials, locator, teamId);
		const repoId = project.link?.repoId;
		if (!repoId) {
			throw new VercelError(
				'This Vercel project is not connected to a git repository, so there is nothing to build from.',
				400,
				'config'
			);
		}

		const created = await vercelRequest<VercelDeployment>(credentials, '/v13/deployments', {
			method: 'POST',
			query: { forceNew: 1, teamId: teamId ?? undefined },
			body: {
				name: project.name,
				project: locator,
				...(draft.production && { target: 'production' }),
				gitSource: {
					// The git provider is the project's, not a guess: a GitLab-linked
					// project rejects `type: 'github'` outright.
					type: project.link?.type ?? 'github',
					ref: draft.ref,
					repoId
				}
			}
		});

		const id = created.data?.uid ?? created.data?.id ?? null;
		return {
			deploymentId: id,
			message: draft.production
				? `Production build queued from ${draft.ref}.`
				: `Preview build queued from ${draft.ref}.`
		};
	},

	/**
	 * Create a Vercel project, connected to a repository when one is given.
	 *
	 * Connecting the repository at creation is what makes the project useful
	 * immediately — an unconnected project cannot be deployed from here at all,
	 * per `deployInfo` above. It requires the Vercel account to have access to
	 * that repository already, and the error when it does not is Vercel's own,
	 * which names the missing installation better than we could.
	 */
	async createProject(context: UnboundDeployContext, draft: NewProjectDraft): Promise<DeployTarget> {
		const credentials = credentialsOf(context);
		// Teams are not offered here. A new project lands in the token's default
		// scope, which is the one place we know the credential can write.
		const created = await vercelRequest<VercelProject>(credentials, '/v11/projects', {
			method: 'POST',
			body: {
				name: draft.name,
				...(draft.framework && { framework: draft.framework }),
				...(draft.gitRepo && {
					gitRepository: { type: draft.gitProvider || 'github', repo: draft.gitRepo }
				})
			}
		});

		return toTarget(created.data, null);
	},

	/**
	 * Can this repository be attached, and if not, what would fix it.
	 *
	 * Vercel needs the ACCOUNT to hold a git login connection before any project
	 * can be linked, and it reports the absence as "You need to add a Login
	 * Connection to your GitHub account first" — at the moment the user presses
	 * Connect, having already been promised it would work. Asking the namespaces
	 * endpoint first turns that into a sentence with a link in it.
	 *
	 * The check also covers the narrower case: a Vercel account CAN have GitHub
	 * connected and still not reach one particular owner, because the GitHub App
	 * is installed per account or organisation.
	 */
	async repositoryAccess(context: UnboundDeployContext, gitRepo: string): Promise<RepositoryAccess> {
		// Two DIFFERENT things, and conflating them is what made the first version
		// wrong. A "Login Connection" is how you sign in to Vercel; the GitHub App
		// installation is what lets Vercel read your repositories. An account can
		// have the first without the second, and this endpoint reports the second.
		const installUrl = 'https://github.com/apps/vercel/installations/new';
		let namespaces: VercelGitNamespace[] = [];

		try {
			// NO `teamId` HERE. Nearly every other Vercel endpoint requires it, and
			// this one rejects it outright with a 400 — git namespaces belong to the
			// signed-in USER, not to a team.
			const response = await vercelRequest<VercelGitNamespace[] | { gitNamespaces?: VercelGitNamespace[] }>(
				credentialsOf(context),
				'/v1/integrations/git-namespaces',
				{ query: { provider: 'github' } }
			);
			const data = response.data;
			// Documented as a bare array, but tolerate a wrapper rather than read a
			// wrapped response as "no namespaces".
			namespaces = Array.isArray(data) ? data : (data?.gitNamespaces ?? []);
		} catch (error) {
			debug.log('deployments', 'Could not list Vercel git namespaces:', error);
			return {
				state: 'unknown',
				reason:
					'Could not check which repositories this Vercel account can reach. Connecting may still work — if it does not, the reason will be shown here.',
				actionUrl: installUrl
			};
		}

		const owner = gitRepo.split('/')[0]?.toLowerCase() ?? '';
		const match = namespaces.find((entry) => entry.slug?.toLowerCase() === owner);

		if (match && !match.isAccessRestricted) {
			return { state: 'ready', reason: null, actionUrl: null };
		}

		if (match?.isAccessRestricted) {
			return {
				state: 'blocked',
				reason: `Vercel can see "${owner}" but its access there is restricted — an owner has to approve Vercel's GitHub app before its repositories can be linked.`,
				actionUrl: installUrl
			};
		}

		// AN EMPTY LIST IS NOT PROOF OF ANYTHING. The first version treated it as
		// "this account has no GitHub connection" and DISABLED the button on that
		// inference — which was wrong for an account that had GitHub connected and
		// working. This endpoint's silence can also mean a token that cannot read
		// integrations, so an empty answer is reported as unknown and the real
		// attempt is left to give the authoritative answer.
		if (namespaces.length === 0) {
			return {
				state: 'unknown',
				reason:
					"Vercel reports no repositories it can reach with this token. That usually means Vercel's GitHub app is not installed yet — but the token may simply not be allowed to read that, so connecting is still worth trying.",
				actionUrl: installUrl
			};
		}

		// A non-empty list that omits the owner IS informative: the app is
		// installed somewhere, just not where this repository lives.
		const reachable = namespaces.map((entry) => entry.slug).filter(Boolean).join(', ');
		return {
			state: 'blocked',
			reason: `Vercel can reach ${reachable}, but not "${owner}". Install Vercel's GitHub app on that account or organisation and it will appear here.`,
			actionUrl: installUrl
		};
	},

	/**
	 * Attach a repository to an existing project.
	 *
	 * THIS ENDPOINT IS NOT IN VERCEL'S PUBLISHED OPENAPI DOCUMENT. It is what
	 * `vercel git connect` calls, so it is exercised by the official CLI on every
	 * install rather than being a browser-internal route — but it carries no
	 * compatibility promise, and it is the one call in this adapter that could
	 * change without notice.
	 *
	 * It is here because the alternative is worse: `PATCH /v9/projects/{id}`
	 * accepts no `gitRepository`, and the only documented way to get a connected
	 * project is to create a NEW one — which means telling someone their existing
	 * project is unusable from Clopen and they should make a second one. The
	 * failure path says exactly that, so a break here degrades to the documented
	 * route rather than to a dead end.
	 */
	async connectRepository(context: DeployContext, repo: { gitRepo: string; gitProvider: string }) {
		const { locator, teamId } = context.binding;
		try {
			await vercelRequest(
				credentialsOf(context),
				`/v9/projects/${encodeURIComponent(locator)}/link`,
				{
					method: 'POST',
					query: { teamId: teamId ?? undefined },
					body: { type: repo.gitProvider || 'github', repo: repo.gitRepo }
				}
			);
		} catch (error) {
			// Vercel's own wording names the prerequisite but not where to fix it,
			// and it arrives at the moment the user has already committed to the
			// action. The pre-check normally prevents this; when it does not, the
			// message at least has to carry the address.
			const message = error instanceof Error ? error.message : String(error);
			if (/login connection/i.test(message)) {
				throw new VercelError(
					`${message} Add it at https://vercel.com/account/login-connections, then try again.`,
					error instanceof VercelError ? error.status : 400,
					'config'
				);
			}
			throw error;
		}
	},

	/**
	 * Delete a deployment.
	 *
	 * Vercel refuses for whatever is currently serving production, which is the
	 * right refusal — the caller does not offer it there either, so reaching
	 * that error means something raced.
	 */
	async deleteDeployment(context: DeployContext, id: string) {
		await vercelRequest(credentialsOf(context), `/v13/deployments/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			query: { teamId: context.binding.teamId ?? undefined }
		});
		return { message: 'The deployment has been deleted.' };
	},

	/**
	 * Whether the project is paused, and whether a traffic move is still running.
	 *
	 * Both are read-only. `lastAliasRequest` is what makes `pending` finishable:
	 * rollback and promote both return as soon as Vercel accepts them, and this
	 * is the only place the outcome shows up.
	 */
	async projectStatus(context: DeployContext): Promise<DeployProjectStatus> {
		const { locator, teamId } = context.binding;
		const project = await fetchProject(credentialsOf(context), locator, teamId);
		const request = project.lastAliasRequest;

		return {
			paused: project.paused === true,
			aliasRequest:
				request?.type && request.jobStatus
					? {
							type: request.type,
							status: request.jobStatus,
							toDeploymentId: request.toDeploymentId ?? null
						}
					: null
		};
	},

	async viewer(context) {
		try {
			const response = await vercelRequest<VercelUser>(credentialsOf(context), '/v2/user');
			return response.data?.user?.username ?? response.data?.user?.email ?? null;
		} catch {
			return null;
		}
	},

	async currentProduction(context: DeployContext): Promise<Deployment | null> {
		const credentials = credentialsOf(context);
		const { locator, teamId } = context.binding;

		const project = await fetchProject(credentials, locator, teamId);
		const currentId = currentProductionIdOf(project);
		if (!currentId) return null;

		const detail = await vercelRequest<VercelDeployment>(
			credentials,
			`/v13/deployments/${encodeURIComponent(currentId)}`,
			{ query: { teamId: teamId ?? undefined } }
		);
		return toDeployment(detail.data, currentId);
	}
};
