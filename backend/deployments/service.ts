/**
 * The Deployments surface, provider-agnostic.
 *
 * Every route in `backend/ws/deployments/` goes through here, and nothing here
 * mentions Vercel. The service resolves which connected accounts can serve the
 * current project, assembles the adapter context (account + decoded credential
 * + binding), and hands the call on.
 *
 * The credential is decoded HERE and dies here. No function in this file
 * returns it, and the shapes the routes serialise (`DeploySource`,
 * `Deployment`) have nowhere to put it.
 *
 * Outward-facing actions go through `runAction`, which is the single place that
 * checks a capability before calling a provider. A route that called
 * `adapter.promote` directly would work for Vercel and crash for the first
 * provider that does not have one.
 */

import {
	deployBindingQueries,
	integrationAccountQueries,
	parseDeployConfig,
	type IntegrationAccountRow
} from '$backend/database/queries';
import { getProvider } from '$backend/integrations';
import type {
	BuildLogBundle,
	DeployAction,
	DeployActionResult,
	DeployBindingConfig,
	Deployment,
	DeploymentDetail,
	DeploymentDraft,
	DeploymentPage,
	DeployProjectStatus,
	DeploySource,
	DeployTarget,
	NewProjectDraft
} from '$shared/types/deployments';
import { getDeployAdapter } from './registry';
import {
	readDeployBinding,
	resolveDeployBinding,
	suggestTargets,
	toDeployBindingInfo
} from './bindings';
import type {
	AdapterDeployInfo,
	DeployContext,
	DeploymentQuery,
	DeployProviderAdapter,
	RepositoryAccess
} from './types';
import { debug } from '$shared/utils/logger';

/**
 * Accounts that can serve deployments here.
 *
 * Three filters, in order of what they mean: the account offers `deployments`,
 * it is switched on, and there is code registered that knows how to talk to it.
 * The third is why a provider declaring the capability before its adapter
 * exists is harmless — it simply does not appear.
 */
function accountsFor(projectId: string): { account: IntegrationAccountRow; adapter: DeployProviderAdapter }[] {
	return integrationAccountQueries
		.getAll()
		.filter((account) => account.is_enabled === 1)
		.filter((account) => integrationAccountQueries.capabilitiesOf(account).includes('deployments'))
		// A project-bound account belongs to that project alone; a null binding
		// means "available everywhere". Same rule the webhook gateway uses.
		.filter((account) => account.project_id === null || account.project_id === projectId)
		.flatMap((account) => {
			const adapter = getDeployAdapter(account.provider);
			return adapter ? [{ account, adapter }] : [];
		});
}

export const deployService = {
	/**
	 * Every source the panel can show, with its binding already resolved.
	 *
	 * Detection runs here, which is why this is async: opening the panel on a
	 * project that has never been bound is the moment we have both the account
	 * and the working tree in hand, and asking the user to bind manually at that
	 * point would be asking them to retype a file already in their repository.
	 */
	async listSources(projectId: string, projectRoot: string): Promise<DeploySource[]> {
		const sources: DeploySource[] = [];

		for (const { account, adapter } of accountsFor(projectId)) {
			const provider = getProvider(account.provider);
			const credentials = integrationAccountQueries.credentialsOf(account);

			let binding = readDeployBinding(projectId, account.id);
			if (!binding) {
				try {
					binding = await resolveDeployBinding(adapter, account, projectId, projectRoot);
				} catch (error) {
					debug.warn('deployments', `Binding detection failed for ${account.provider}:`, error);
				}
			}

			// Only offered when there is nothing bound yet. Listing every project
			// in every team is several requests, and spending them to populate a
			// picker nobody opened is the kind of cost that shows up as a rate
			// limit during someone else's build.
			const suggested = binding
				? []
				: await suggestTargets(adapter, { projectId, account, credentials }, projectRoot).catch((error) => {
						debug.warn('deployments', 'Could not list deploy targets:', error);
						return [] as DeployTarget[];
					});

			sources.push({
				accountId: account.id,
				provider: account.provider,
				providerName: provider?.name ?? account.provider,
				label: account.label,
				// Resolved once per source: every view that wants to say whose
				// account this is would otherwise ask again.
				viewer: adapter.viewer
					? await adapter.viewer({ projectId, account, credentials }).catch(() => null)
					: null,
				capabilities: adapter.capabilities,
				binding: toDeployBindingInfo(binding),
				suggestedTargets: suggested,
				status: account.status,
				statusDetail: account.status_detail
			});
		}

		return sources;
	},

	/**
	 * Adapter + context for one account, or a clear error.
	 *
	 * "Not bound" is separated from "not connected" because they need different
	 * answers: one is a project picker, the other is a connect dialog.
	 */
	require(projectId: string, accountId: string): { adapter: DeployProviderAdapter; context: DeployContext } {
		const account = integrationAccountQueries.getById(accountId);
		if (!account) throw new Error('That integration account is no longer connected');
		if (account.is_enabled !== 1) {
			throw new Error(`${account.label} is switched off in Settings → Integrations`);
		}

		const adapter = getDeployAdapter(account.provider);
		if (!adapter) throw new Error(`No deployment provider is registered for ${account.provider}`);

		const binding = readDeployBinding(projectId, account.id);
		if (!binding) {
			throw new Error('This project is not pointed at a deployment project yet — pick one first.');
		}

		return {
			adapter,
			context: {
				projectId,
				account,
				credentials: integrationAccountQueries.credentialsOf(account),
				binding
			}
		};
	},

	/** Targets for the picker, listed on demand rather than with every source. */
	async listTargets(projectId: string, accountId: string, projectRoot: string): Promise<DeployTarget[]> {
		const account = integrationAccountQueries.getById(accountId);
		if (!account) throw new Error('That integration account is no longer connected');

		const adapter = getDeployAdapter(account.provider);
		if (!adapter) throw new Error(`No deployment provider is registered for ${account.provider}`);

		return suggestTargets(
			adapter,
			{ projectId, account, credentials: integrationAccountQueries.credentialsOf(account) },
			projectRoot
		);
	},

	list(projectId: string, accountId: string, query: DeploymentQuery): Promise<DeploymentPage> {
		const { adapter, context } = this.require(projectId, accountId);
		return adapter.list(context, query);
	},

	get(projectId: string, accountId: string, id: string): Promise<DeploymentDetail> {
		const { adapter, context } = this.require(projectId, accountId);
		return adapter.get(context, id);
	},

	currentProduction(projectId: string, accountId: string): Promise<Deployment | null> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.currentProduction) return Promise.resolve(null);
		return adapter.currentProduction(context);
	},

	fetchLogs(projectId: string, accountId: string, id: string): Promise<BuildLogBundle> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.capabilities.logs || !adapter.fetchLogs) {
			throw new Error(`${context.account.label} does not expose build logs`);
		}
		return adapter.fetchLogs(context, id);
	},

	/**
	 * Run one outward-facing action.
	 *
	 * The capability check lives here rather than in the route so every entry
	 * point inherits it, and the error names the provider rather than the
	 * method: "Coolify cannot promote a deployment" is actionable, while
	 * "adapter.promote is not a function" is a bug report.
	 */
	async runAction(
		projectId: string,
		accountId: string,
		action: DeployAction,
		id: string
	): Promise<DeployActionResult> {
		const { adapter, context } = this.require(projectId, accountId);
		const label = context.account.label;

		switch (action) {
			case 'redeploy': {
				if (!adapter.capabilities.redeploy || !adapter.redeploy) {
					throw new Error(`${label} cannot redeploy a build`);
				}
				const result = await adapter.redeploy(context, id);
				return { action, status: 'done', deploymentId: result.deploymentId, message: result.message };
			}
			case 'cancel': {
				if (!adapter.capabilities.cancel || !adapter.cancel) {
					throw new Error(`${label} cannot cancel a build`);
				}
				const result = await adapter.cancel(context, id);
				return { action, status: 'done', deploymentId: null, message: result.message };
			}
			case 'rollback': {
				if (!adapter.capabilities.rollback || !adapter.rollback) {
					throw new Error(`${label} cannot roll back a deployment`);
				}
				const result = await adapter.rollback(context, id);
				return { action, status: result.status, deploymentId: null, message: result.message };
			}
			case 'promote': {
				if (!adapter.capabilities.promote || !adapter.promote) {
					throw new Error(`${label} cannot promote a deployment`);
				}
				const result = await adapter.promote(context, id);
				return { action, status: result.status, deploymentId: null, message: result.message };
			}
			case 'delete': {
				if (!adapter.capabilities.deleteDeployment || !adapter.deleteDeployment) {
					throw new Error(`${label} cannot delete a deployment`);
				}
				const result = await adapter.deleteDeployment(context, id);
				return { action, status: 'done', deploymentId: null, message: result.message };
			}
		}
	},

	/** Project-level state, including a traffic move still in flight. */
	async projectStatus(projectId: string, accountId: string): Promise<DeployProjectStatus> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.projectStatus) return { paused: false, aliasRequest: null };
		return adapter.projectStatus(context);
	},

	/** What the deploy dialog needs before it opens. */
	deployInfo(projectId: string, accountId: string): Promise<AdapterDeployInfo> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.capabilities.createDeployment || !adapter.deployInfo) {
			return Promise.resolve({
				gitRepo: null,
				productionBranch: null,
				canDeploy: false,
				reason: `${context.account.label} cannot start a build from here.`
			});
		}
		return adapter.deployInfo(context);
	},

	/**
	 * Start a new build.
	 *
	 * Kept out of `runAction` because it does not act on an existing deployment
	 * — it takes a branch and an environment, and the one thing a project that
	 * has never been deployed does not have is a deployment to act on.
	 */
	async createDeployment(
		projectId: string,
		accountId: string,
		draft: DeploymentDraft
	): Promise<DeployActionResult> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.capabilities.createDeployment || !adapter.createDeployment) {
			throw new Error(`${context.account.label} cannot start a build`);
		}

		const ref = draft.ref.trim();
		if (!ref) throw new Error('Pick a branch to build from');

		const result = await adapter.createDeployment(context, { ref, production: draft.production });
		return {
			action: 'redeploy',
			status: 'done',
			deploymentId: result.deploymentId,
			message: result.message
		};
	},

	/**
	 * Create a remote project and point this one at it.
	 *
	 * Binding straight away is the point: a user who just created a project for
	 * this repository has already answered "which project is this", and making
	 * them answer it again in a picker is the setup step that makes an
	 * integration feel like homework.
	 */
	async createProject(
		projectId: string,
		accountId: string,
		draft: NewProjectDraft
	): Promise<DeployTarget> {
		const account = integrationAccountQueries.getById(accountId);
		if (!account) throw new Error('That integration account is no longer connected');

		const adapter = getDeployAdapter(account.provider);
		if (!adapter) throw new Error(`No deployment provider is registered for ${account.provider}`);
		if (!adapter.capabilities.createProject || !adapter.createProject) {
			throw new Error(`${account.label} cannot create a project`);
		}

		const name = draft.name.trim();
		if (!name) throw new Error('Give the project a name');

		const credentials = integrationAccountQueries.credentialsOf(account);
		const target = await adapter.createProject({ projectId, account, credentials }, { ...draft, name });

		deployBindingQueries.upsert({
			projectId,
			accountId,
			locator: target.id,
			displayName: target.name,
			teamId: target.teamId,
			detected: false,
			config: parseDeployConfig(deployBindingQueries.get(projectId, accountId)?.config_json ?? null)
		});

		return target;
	},

	/** Whether a repository could be attached, and what to do when it cannot. */
	async repositoryAccess(projectId: string, accountId: string, gitRepo: string): Promise<RepositoryAccess> {
		const account = integrationAccountQueries.getById(accountId);
		if (!account) throw new Error('That integration account is no longer connected');

		const adapter = getDeployAdapter(account.provider);
		// UNBOUND on purpose: this reads a property of the account, and the
		// new-project form needs the answer before any project exists to bind to.
		if (!adapter?.capabilities.connectRepository || !adapter.repositoryAccess) {
			return {
				state: 'blocked',
				reason: `${account.label} cannot attach a repository to a project.`,
				actionUrl: null
			};
		}

		return adapter.repositoryAccess(
			{ projectId, account, credentials: integrationAccountQueries.credentialsOf(account) },
			gitRepo
		);
	},

	/**
	 * Attach a git repository to the bound remote project.
	 *
	 * The way out of the one dead end this surface has: a remote project with no
	 * repository cannot be built from at all, and previously the only answer was
	 * "go to the provider's dashboard".
	 */
	async connectRepository(
		projectId: string,
		accountId: string,
		repo: { gitRepo: string; gitProvider: string }
	): Promise<void> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.capabilities.connectRepository || !adapter.connectRepository) {
			throw new Error(`${context.account.label} cannot attach a repository to an existing project`);
		}
		if (!repo.gitRepo.trim()) throw new Error('Name the repository to connect');

		await adapter.connectRepository(context, {
			gitRepo: repo.gitRepo.trim(),
			gitProvider: repo.gitProvider || 'github'
		});
	},

	/** Point this project at a different remote project. */
	async setBinding(
		projectId: string,
		accountId: string,
		locator: string,
		teamId: string | null
	): Promise<void> {
		const account = integrationAccountQueries.getById(accountId);
		if (!account) throw new Error('That integration account is no longer connected');

		const adapter = getDeployAdapter(account.provider);
		if (!adapter) throw new Error(`No deployment provider is registered for ${account.provider}`);

		const credentials = integrationAccountQueries.credentialsOf(account);
		const described = await adapter
			.describeTarget({ projectId, account, credentials }, locator, teamId)
			.catch(() => null);

		const existing = deployBindingQueries.get(projectId, accountId);
		deployBindingQueries.upsert({
			projectId,
			accountId,
			locator,
			displayName: described?.name ?? locator,
			teamId,
			// Chosen, not detected — the distinction is what lets the binding bar
			// say "from your linked project" only when that is actually true.
			detected: false,
			config: parseDeployConfig(existing?.config_json ?? null)
		});
	},

	setConfig(projectId: string, accountId: string, config: DeployBindingConfig): void {
		if (!deployBindingQueries.get(projectId, accountId)) {
			throw new Error('This project is not pointed at a deployment project yet');
		}
		deployBindingQueries.setConfig(projectId, accountId, config);
	},

	/**
	 * Health for the hub.
	 *
	 * Returns null when this account has nothing to say — a Vercel account with
	 * `deployments` switched off — so the hub falls back to the MCP probe rather
	 * than reporting a state this surface never measured.
	 */
	async probe(accountId: string, projectId: string | null) {
		const account = integrationAccountQueries.getById(accountId);
		if (!account) return null;
		if (!integrationAccountQueries.capabilitiesOf(account).includes('deployments')) return null;

		const adapter = getDeployAdapter(account.provider);
		if (!adapter) return null;

		const credentials = integrationAccountQueries.credentialsOf(account);
		const binding = projectId ? readDeployBinding(projectId, accountId) : null;

		return adapter.probe({ projectId: projectId ?? '', account, credentials }, binding);
	}
};
