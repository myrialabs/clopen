/**
 * Issue-provider adapter contract.
 *
 * This is the interface `Task 2` exists to build. GitHub is the first provider
 * behind it, and GitLab, Gitea, Forgejo, Linear, Jira and PostHog are meant to
 * land as another file in `providers/` and one line in the registry. If any of
 * them needs a change to the PANEL, this interface is what was wrong.
 *
 * Note what this is NOT: a projector. A projection derives a row on a surface
 * that already has its own table — `mcp_servers` for agent tools,
 * `db_client_connections` for a database. The Issues & PRs surface has no such table
 * to write into, because work items are never copied locally (see migration
 * 074). So an issue provider registers CODE here, and the account row itself is
 * what makes it appear in the panel.
 */

import type {
	CheckLogBundle,
	CheckRun,
	CommentSource,
	CommitDetail,
	CommitRef,
	FileContent,
	FileChange,
	WorkBindingConfig,
	WorkProviderCapabilities,
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
import type { IntegrationAccountRow } from '$backend/database/queries';

/** The remote project one account is pointed at, for one Clopen project. */
export interface ResolvedBinding {
	locator: string;
	detected: boolean;
	defaultBranch: string | null;
	config: WorkBindingConfig;
}

/**
 * Everything an adapter call needs.
 *
 * `credentials` is already decoded. It is assembled by the service from the
 * account row and never leaves the backend — no route serialises it, and the
 * adapter must not put it anywhere a `WorkItem` can carry it back out.
 */
export interface WorkContext {
	projectId: string;
	account: IntegrationAccountRow;
	credentials: Record<string, string>;
	binding: ResolvedBinding;
}

/** Same, before a binding exists — the only calls that can run unbound. */
export interface UnboundContext {
	projectId: string;
	account: IntegrationAccountRow;
	credentials: Record<string, string>;
}

export interface WorkProviderAdapter {
	/** Must match the `IntegrationProvider.id` this adapter serves. */
	provider: string;
	capabilities: WorkProviderCapabilities;

	/**
	 * Turn a git remote URL into a locator, or null when it belongs to someone
	 * else. This is what makes binding automatic: the panel asks every adapter
	 * about every remote and keeps the answers that are not null.
	 *
	 * A self-hosted provider decides using the account's configured base URL,
	 * which is why the credentials are passed in rather than just the URL.
	 */
	locatorFromRemote(url: string, credentials: Record<string, string>): string | null;

	/** Human form of a locator, for the binding bar. */
	describeLocator(locator: string): string;

	/**
	 * Is this credential good, and does it reach the bound project?
	 *
	 * Runs at connect time and from the hub's health button. A token that is
	 * valid but lacks a permission must fail HERE, with the missing permission
	 * named — not three clicks later as a 403 from an unrelated action.
	 */
	probe(context: UnboundContext, binding: ResolvedBinding | null): Promise<{
		status: 'ok' | 'needs_auth' | 'needs_config' | 'error';
		detail: string | null;
	}>;

	/** States an item of this kind can be moved to. */
	listStates(context: WorkContext, kind: WorkItemKind): Promise<WorkItemStateOption[]>;

	list(context: WorkContext, query: WorkItemQuery): Promise<WorkItemPage>;
	get(context: WorkContext, kind: WorkItemKind, id: string): Promise<WorkItemDetail>;
	comment(context: WorkContext, kind: WorkItemKind, id: string, body: string): Promise<WorkItemComment>;
	transition(context: WorkContext, kind: WorkItemKind, id: string, state: string): Promise<void>;

	/** The branch a PR should target by default. Cached on the binding. */
	defaultBranch(context: WorkContext): Promise<string>;

	/** CI runs for a branch. Absent when the provider has no CI to speak of. */
	listChecks?(context: WorkContext, branch: string): Promise<CheckRun[]>;
	/** Logs for one run, already trimmed to a size a prompt can carry. */
	fetchCheckLogs?(context: WorkContext, runId: string): Promise<CheckLogBundle>;

	createPullRequest?(context: WorkContext, draft: PullRequestDraft): Promise<WorkItem>;
	/** An open PR whose head is this branch, when there is one. */
	findPullRequestForBranch?(context: WorkContext, branch: string): Promise<WorkItem | null>;

	/** Who the stored credential belongs to. Decides what the user may edit. */
	viewer?(context: UnboundContext): Promise<string | null>;

	/** Change an item's title, body, or both. */
	updateItem?(
		context: WorkContext,
		kind: WorkItemKind,
		id: string,
		patch: { title?: string; body?: string }
	): Promise<void>;
	/** Labels this repository defines, for the filter panel. */
	listLabels?(context: WorkContext): Promise<string[]>;

	/**
	 * Editing and deleting a comment.
	 *
	 * `source` travels because a provider may keep review comments on a
	 * different endpoint from the discussion thread — GitHub does, and using the
	 * wrong one is a 404 rather than a permission error.
	 */
	updateComment?(
		context: WorkContext,
		comment: { id: string; source: CommentSource },
		body: string
	): Promise<WorkItemComment>;
	deleteComment?(
		context: WorkContext,
		comment: { id: string; source: CommentSource }
	): Promise<void>;

	/** Merge a pull request. Outward-facing: the caller confirms first. */
	mergePullRequest?(
		context: WorkContext,
		id: string,
		options: { method: MergeMethod; title?: string; message?: string }
	): Promise<void>;

	listCommits?(context: WorkContext, id: string): Promise<CommitRef[]>;
	/** One commit's message, stats and files — what a list row cannot carry. */
	commitDetail?(context: WorkContext, sha: string): Promise<CommitDetail>;
	/**
	 * One file's full text, for the in-app viewer.
	 *
	 * `blobSha` is the preferred address when the caller has one; `ref` is the
	 * fallback for providers or call sites that only know a branch.
	 */
	fetchFileContent?(
		context: WorkContext,
		path: string,
		ref: string,
		blobSha?: string
	): Promise<FileContent>;
	listFiles?(context: WorkContext, id: string): Promise<FileChange[]>;

	/** People this item can be assigned to. */
	listAssignees?(context: WorkContext): Promise<string[]>;
	setAssignees?(context: WorkContext, kind: WorkItemKind, id: string, logins: string[]): Promise<void>;

	createIssue?(
		context: WorkContext,
		draft: { title: string; body: string; assignees: string[]; labels: string[] }
	): Promise<WorkItem>;
}
