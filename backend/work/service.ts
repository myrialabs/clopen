/**
 * The Issues & PRs surface, provider-agnostic.
 *
 * Every route in `backend/ws/issues/` goes through here, and nothing here
 * mentions GitHub. The service resolves which connected accounts can serve the
 * current project, assembles the adapter context (account + decoded credential
 * + binding), and hands the call on.
 *
 * The credential is decoded HERE and dies here. No function in this file
 * returns it, and the shapes the routes serialise (`WorkSource`, `WorkItem`)
 * have nowhere to put it.
 */

import {
	integrationAccountQueries,
	workBindingQueries,
	workLinkQueries,
	parseBindingConfig,
	type IntegrationAccountRow
} from '$backend/database/queries';
import { getProvider } from '$backend/integrations';
import type {
	CheckLogBundle,
	CheckRun,
	CommentSource,
	CommitDetail,
	CommitRef,
	FileContent,
	FileChange,
	WorkBindingConfig,
	WorkSource,
	MergeMethod,
	PullRequestDraft,
	WorkItem,
	WorkItemComment,
	WorkItemDetail,
	WorkItemKind,
	WorkItemPage,
	WorkItemQuery,
	WorkItemStateOption
} from '$shared/types/work';
import { getWorkAdapter } from './registry';
import { readBinding, resolveBinding, suggestLocators, toBindingInfo } from './bindings';
import type { WorkContext, WorkProviderAdapter } from './types';
import { debug } from '$shared/utils/logger';

/**
 * Accounts that can serve work items here.
 *
 * Three filters, in order of what they mean: the account offers `issues`, it is
 * switched on, and there is code registered that knows how to talk to it. The
 * third is why a provider declaring the capability before its adapter exists is
 * harmless — it simply does not appear.
 */
function accountsFor(projectId: string): { account: IntegrationAccountRow; adapter: WorkProviderAdapter }[] {
	return integrationAccountQueries
		.getAll()
		.filter((account) => account.is_enabled === 1)
		.filter((account) => integrationAccountQueries.capabilitiesOf(account).includes('work'))
		// A project-bound account belongs to that project alone; a null binding
		// means "available everywhere". Same rule the webhook gateway uses.
		.filter((account) => account.project_id === null || account.project_id === projectId)
		.flatMap((account) => {
			const adapter = getWorkAdapter(account.provider);
			return adapter ? [{ account, adapter }] : [];
		});
}

function contextOf(
	account: IntegrationAccountRow,
	projectId: string,
	binding: NonNullable<ReturnType<typeof readBinding>>
): WorkContext {
	return {
		projectId,
		account,
		credentials: integrationAccountQueries.credentialsOf(account),
		binding
	};
}

export const workService = {
	/**
	 * Every source the panel can show, with its binding already resolved.
	 *
	 * Detection runs here, which is why this is async: opening the panel on a
	 * project that has never been bound is the moment we have both the account
	 * and the repository in hand, and asking the user to bind manually at that
	 * point would be asking them to retype their git remote.
	 */
	async listSources(projectId: string, projectRoot: string): Promise<WorkSource[]> {
		const sources: WorkSource[] = [];

		for (const { account, adapter } of accountsFor(projectId)) {
			const provider = getProvider(account.provider);
			const credentials = integrationAccountQueries.credentialsOf(account);

			let binding = readBinding(projectId, account.id);
			if (!binding) {
				try {
					binding = await resolveBinding(adapter, account, projectId, projectRoot);
				} catch (error) {
					debug.warn('work', `Binding detection failed for ${account.provider}:`, error);
				}
			}

			sources.push({
				accountId: account.id,
				provider: account.provider,
				providerName: provider?.name ?? account.provider,
				label: account.label,
				// Resolved once per source. Every comment's edit and delete
				// controls depend on knowing who the credential belongs to, and
				// asking per comment would be one request per row.
				viewer: adapter.viewer
					? await adapter.viewer({ projectId, account, credentials }).catch(() => null)
					: null,
				capabilities: adapter.capabilities,
				binding: toBindingInfo(adapter, binding),
				suggestedLocators: await suggestLocators(adapter, credentials, projectRoot).catch(() => []),
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
	 * answers: one is a repository picker, the other is a connect dialog.
	 */
	require(projectId: string, accountId: string): { adapter: WorkProviderAdapter; context: WorkContext } {
		const account = integrationAccountQueries.getById(accountId);
		if (!account) throw new Error('That integration account is no longer connected');
		if (account.is_enabled !== 1) throw new Error(`${account.label} is switched off in Settings → Integrations`);

		const adapter = getWorkAdapter(account.provider);
		if (!adapter) throw new Error(`Clopen has no issues adapter for "${account.provider}"`);

		const binding = readBinding(projectId, account.id);
		if (!binding) throw new Error('This project is not pointed at a repository yet');

		return { adapter, context: contextOf(account, projectId, binding) };
	},

	/** How to print the bound remote project, for prompts and headings. */
	describeBinding(projectId: string, accountId: string): string | null {
		const account = integrationAccountQueries.getById(accountId);
		const adapter = account ? getWorkAdapter(account.provider) : null;
		const binding = readBinding(projectId, accountId);
		if (!adapter || !binding) return null;
		return adapter.describeLocator(binding.locator);
	},

	async list(projectId: string, accountId: string, query: WorkItemQuery): Promise<WorkItemPage> {
		const { adapter, context } = this.require(projectId, accountId);
		return adapter.list(context, query);
	},

	async get(projectId: string, accountId: string, kind: WorkItemKind, id: string): Promise<WorkItemDetail> {
		const { adapter, context } = this.require(projectId, accountId);
		return adapter.get(context, kind, id);
	},

	async listStates(projectId: string, accountId: string, kind: WorkItemKind): Promise<WorkItemStateOption[]> {
		const { adapter, context } = this.require(projectId, accountId);
		return adapter.listStates(context, kind);
	},

	async comment(
		projectId: string,
		accountId: string,
		kind: WorkItemKind,
		id: string,
		body: string
	): Promise<WorkItemComment> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.capabilities.comments) throw new Error('This provider does not accept comments');
		return adapter.comment(context, kind, id, body);
	},

	async transition(
		projectId: string,
		accountId: string,
		kind: WorkItemKind,
		id: string,
		state: string
	): Promise<void> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.capabilities.transitions) throw new Error('This provider does not support state changes');
		await adapter.transition(context, kind, id, state);
	},

	async listChecks(projectId: string, accountId: string, branch: string): Promise<CheckRun[]> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.listChecks) return [];
		return adapter.listChecks(context, branch);
	},

	async fetchCheckLogs(projectId: string, accountId: string, runId: string): Promise<CheckLogBundle> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.fetchCheckLogs) throw new Error('This provider does not expose CI logs');
		return adapter.fetchCheckLogs(context, runId);
	},

	async updateItem(
		projectId: string,
		accountId: string,
		kind: WorkItemKind,
		id: string,
		patch: { title?: string; body?: string }
	): Promise<void> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.updateItem) throw new Error('This provider cannot edit items');
		await adapter.updateItem(context, kind, id, patch);
	},

	async listLabels(projectId: string, accountId: string): Promise<string[]> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.listLabels) return [];
		return adapter.listLabels(context);
	},

	async updateComment(
		projectId: string,
		accountId: string,
		comment: { id: string; source: CommentSource },
		body: string
	): Promise<WorkItemComment> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.updateComment) throw new Error('This provider cannot edit comments');
		return adapter.updateComment(context, comment, body);
	},

	async deleteComment(
		projectId: string,
		accountId: string,
		comment: { id: string; source: CommentSource }
	): Promise<void> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.deleteComment) throw new Error('This provider cannot delete comments');
		await adapter.deleteComment(context, comment);
	},

	async mergePullRequest(
		projectId: string,
		accountId: string,
		id: string,
		options: { method: MergeMethod; title?: string; message?: string }
	): Promise<void> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.mergePullRequest) throw new Error('This provider cannot merge pull requests');
		await adapter.mergePullRequest(context, id, options);
	},

	async listCommits(projectId: string, accountId: string, id: string): Promise<CommitRef[]> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.listCommits) return [];
		return adapter.listCommits(context, id);
	},

	async listFiles(projectId: string, accountId: string, id: string): Promise<FileChange[]> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.listFiles) return [];
		return adapter.listFiles(context, id);
	},

	async commitDetail(projectId: string, accountId: string, sha: string): Promise<CommitDetail> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.commitDetail) throw new Error('This provider cannot open a commit');
		return adapter.commitDetail(context, sha);
	},

	async fetchFileContent(
		projectId: string,
		accountId: string,
		path: string,
		ref: string,
		blobSha?: string
	): Promise<FileContent> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.fetchFileContent) throw new Error('This provider cannot read file contents');
		return adapter.fetchFileContent(context, path, ref, blobSha);
	},

	async listAssignees(projectId: string, accountId: string): Promise<string[]> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.listAssignees) return [];
		return adapter.listAssignees(context);
	},

	async setAssignees(
		projectId: string,
		accountId: string,
		kind: WorkItemKind,
		id: string,
		logins: string[]
	): Promise<void> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.setAssignees) throw new Error('This provider cannot change assignees');
		await adapter.setAssignees(context, kind, id, logins);
	},

	async createIssue(
		projectId: string,
		accountId: string,
		draft: { title: string; body: string; assignees: string[]; labels: string[] }
	): Promise<WorkItem> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.createIssue) throw new Error('This provider cannot create issues');
		return adapter.createIssue(context, draft);
	},

	async createPullRequest(
		projectId: string,
		accountId: string,
		draft: PullRequestDraft
	): Promise<WorkItem> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.createPullRequest) throw new Error('This provider cannot open pull requests');

		const created = await adapter.createPullRequest(context, draft);

		// Record the PR against the branch, so re-opening the composer on this
		// branch finds it instead of offering to create a second one.
		workLinkQueries.upsert({
			projectId,
			accountId,
			itemKind: 'pull-request',
			itemIdentifier: created.identifier,
			itemTitle: created.title,
			itemUrl: created.url,
			branch: draft.head
		});

		return created;
	},

	async findPullRequestForBranch(
		projectId: string,
		accountId: string,
		branch: string
	): Promise<WorkItem | null> {
		const { adapter, context } = this.require(projectId, accountId);
		if (!adapter.findPullRequestForBranch) return null;
		return adapter.findPullRequestForBranch(context, branch);
	},

	/**
	 * The branch a pull request should target.
	 *
	 * Cached on the binding after the first lookup: the default branch of a
	 * repository changes about once in its lifetime, and paying an API call per
	 * PR composer open to re-learn it is the kind of cost that quietly eats a
	 * rate limit.
	 */
	async defaultBranch(projectId: string, accountId: string): Promise<string> {
		const { adapter, context } = this.require(projectId, accountId);
		if (context.binding.defaultBranch) return context.binding.defaultBranch;

		const branch = await adapter.defaultBranch(context);
		workBindingQueries.setDefaultBranch(projectId, accountId, branch);
		return branch;
	},

	/** Point this project at a different remote project. */
	setBinding(projectId: string, accountId: string, locator: string): void {
		const account = integrationAccountQueries.getById(accountId);
		if (!account) throw new Error('That integration account is no longer connected');

		const existing = workBindingQueries.get(projectId, accountId);
		workBindingQueries.upsert({
			projectId,
			accountId,
			locator: locator.trim(),
			detected: false,
			// The cached default branch belongs to the OLD repository. Keeping it
			// would target a pull request at a branch that may not exist here.
			defaultBranch: null,
			config: parseBindingConfig(existing?.config_json ?? null)
		});
		debug.log('work', `Project ${projectId} now points at ${account.provider}:${locator}`);
	},

	setBindingConfig(projectId: string, accountId: string, config: WorkBindingConfig): void {
		const existing = workBindingQueries.get(projectId, accountId);
		if (!existing) throw new Error('This project is not pointed at a repository yet');

		workBindingQueries.upsert({
			projectId,
			accountId,
			locator: existing.locator,
			detected: existing.detected === 1,
			defaultBranch: existing.default_branch,
			config
		});
	},

	/**
	 * Health for an account whose capability is `issues`.
	 *
	 * Registered with the integrations hub so the account's status strip means
	 * something for a provider that projects no MCP row — without this, GitHub
	 * would forever read "Nothing to probe yet".
	 */
	async probe(
		accountId: string,
		projectId: string | null
	): Promise<{ status: 'ok' | 'needs_auth' | 'needs_config' | 'error'; detail: string | null } | null> {
		const account = integrationAccountQueries.getById(accountId);
		if (!account) return null;

		// Null means "not mine to answer", and the hub falls back to the MCP
		// probe. An account whose `issues` capability is switched off is exactly
		// that case: its GitHub token may still be projecting agent tools.
		if (!integrationAccountQueries.capabilitiesOf(account).includes('work')) return null;

		const adapter = getWorkAdapter(account.provider);
		if (!adapter) return null;

		// An account bound to a project probes against that project's repository;
		// an unbound one can only prove the credential itself is good.
		const binding = projectId ? readBinding(projectId, accountId) : null;
		return adapter.probe(
			{
				projectId: projectId ?? '',
				account,
				credentials: integrationAccountQueries.credentialsOf(account)
			},
			binding
		);
	}
};
