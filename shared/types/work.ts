/**
 * Issues & PRs surface — shared vocabulary.
 *
 * The panel talks about WORK ITEMS, not about GitHub. Every provider that can
 * offer the `issues` capability is normalised into these shapes by an adapter,
 * and the panel never learns which one answered. That is the whole test for
 * this surface: if a second provider needs a second panel, these types are
 * wrong and fixing them is the work — not adding a panel.
 *
 * Nothing here carries a credential. The adapter resolves the account's secret
 * on the server and it never crosses this line.
 */

/** An issue and a pull request are the same kind of thing to this surface. */
export type WorkItemKind = 'issue' | 'pull-request';

/**
 * The one state fact the UI is allowed to reason about.
 *
 * Providers name their states whatever they like — "closed", "Done",
 * "Won't Fix" — and those names are shown verbatim. The category is what
 * decides colour and grouping, so a Linear workflow with nine states still
 * renders without the panel knowing any of them.
 */
export type WorkItemStateCategory = 'open' | 'closed' | 'merged' | 'draft';

export interface WorkItem {
	/** Opaque provider id. Used for API calls, never shown. */
	id: string;
	/**
	 * The identifier a human uses: `123` on GitHub, `ENG-45` on Linear. This is
	 * what branch names and prompts are built from, so it must survive a round
	 * trip through a filesystem path.
	 */
	identifier: string;
	kind: WorkItemKind;
	title: string;
	url: string;
	/** The provider's own state name, shown as-is. */
	state: string;
	stateCategory: WorkItemStateCategory;
	labels: string[];
	assignees: string[];
	author: string | null;
	commentCount: number;
	createdAt: string;
	updatedAt: string;
	/** Pull requests only. */
	headBranch?: string;
	/**
	 * The commit the pull request currently points at.
	 *
	 * Carried because a BRANCH name is not a reliable way to read a pull
	 * request's files: a fork's branch does not exist in the base repository,
	 * and a merged pull request's branch is usually deleted. The sha does.
	 */
	headSha?: string;
	baseBranch?: string;
	isDraft?: boolean;
}

/**
 * Where a comment came from.
 *
 * `review-summary` is the body a reviewer wrote when submitting a review, and
 * it lives on a third endpoint with its own edit semantics. It is shown because
 * leaving it out makes Clopen's thread disagree with the provider's — a bot
 * that posts its findings as a review appeared to have vanished — but it is not
 * editable here, and saying so is better than an edit that 404s.
 */
export type CommentSource = 'conversation' | 'review' | 'review-summary';

export interface WorkItemComment {
	id: string;
	author: string;
	body: string;
	createdAt: string;
	url?: string;
	/**
	 * Which conversation this belongs to.
	 *
	 * GitHub keeps review comments on a different endpoint from the discussion
	 * thread, and editing one through the other's URL is a 404. The surface
	 * shows them together, so the origin has to travel with the comment.
	 */
	source: CommentSource;
	/** True when the signed-in user may edit or delete it. */
	canModify: boolean;
	/** File a review comment was left on, when it was left on one. */
	path?: string;
	line?: number | null;
}

/** How a pull request may be merged. */
export type MergeMethod = 'merge' | 'squash' | 'rebase';

export const MERGE_METHOD_LABELS: Record<MergeMethod, string> = {
	merge: 'Create a merge commit',
	squash: 'Squash and merge',
	rebase: 'Rebase and merge'
};

/**
 * Whether this pull request can be merged right now.
 *
 * `mergeable` is deliberately nullable: GitHub computes it asynchronously and
 * answers null while it is still thinking. Rendering null as "cannot merge"
 * would tell the user their branch is broken when it is merely young.
 */
export interface PullRequestMergeability {
	mergeable: boolean | null;
	/** The provider's own word — `clean`, `blocked`, `dirty`, `behind`. */
	state: string;
	/** Methods the repository allows. A repo can disable squash or rebase. */
	allowedMethods: MergeMethod[];
	merged: boolean;
}

export interface CommitRef {
	hash: string;
	subject: string;
	author: string | null;
	date: string;
	url: string;
}

/** One commit, opened: the rest of its message and everything it touched. */
export interface CommitDetail {
	commit: CommitRef;
	/** The message below the subject line. Empty for a one-line commit. */
	body: string;
	additions: number;
	deletions: number;
	files: FileChange[];
}

/** One file in a pull request's diff. */
export interface FileChange {
	path: string;
	status: string;
	additions: number;
	deletions: number;
	/** Unified diff. Absent for binary files and for anything over the cap. */
	patch?: string;
	url: string;
	/**
	 * The blob this file's content lives in, at this revision.
	 *
	 * This is what "view the whole file" reads, in preference to a path plus a
	 * ref: a blob id needs no branch to still exist, no repository to be the
	 * one the branch lives in, and no guess about which side of a rename the
	 * path is on. It is the difference between the viewer working on a fork's
	 * pull request and the viewer reporting that the repository is unreachable.
	 */
	sha?: string;
	/** Where the file moved from, when the provider says it was renamed. */
	previousPath?: string;
}

/**
 * A file's text, as much of it as is worth sending.
 *
 * `truncated` exists so a partial file can be SHOWN and labelled instead of
 * refused. "Open it on the web instead" is the viewer admitting it would rather
 * not, and a generated bundle or a big lockfile is exactly the sort of file a
 * reviewer needs a look at rather than a lecture about.
 */
export interface FileContent {
	content: string;
	truncated: boolean;
}

/**
 * Something that HAPPENED to an item, other than a comment.
 *
 * Labels, references, assignments and closures are what turn a thread into a
 * history: "aanfaisal mentioned this in #454" is often the answer to why an
 * issue looks the way it does, and reading only the comments hides it.
 *
 * `kind` is normalised; unknown provider events are dropped rather than
 * rendered as a shrug, because a timeline of "something happened" entries is
 * worse than a shorter honest one.
 */
export type TimelineEventKind =
	| 'labeled'
	| 'unlabeled'
	| 'assigned'
	| 'unassigned'
	| 'renamed'
	| 'referenced'
	| 'cross-referenced'
	| 'closed'
	| 'reopened'
	| 'merged'
	| 'review-requested';

export interface WorkItemEvent {
	id: string;
	kind: TimelineEventKind;
	actor: string | null;
	createdAt: string;
	/** Label name, assignee login, new title — whatever the event carries. */
	subject?: string;
	/** The thing referenced, for reference events. */
	referenceTitle?: string;
	referenceUrl?: string;
	referenceIdentifier?: string;
}

export interface WorkItemDetail extends WorkItem {
	body: string;
	comments: WorkItemComment[];
	/** Non-comment history, newest last, interleaved by the UI. */
	events: WorkItemEvent[];
	/** Pull requests only, and only when the provider can merge. */
	mergeability?: PullRequestMergeability;
}

/** One state an item can be moved to, as the provider names it. */
export interface WorkItemStateOption {
	value: string;
	label: string;
	category: WorkItemStateCategory;
}

export type CheckStatus =
	| 'queued'
	| 'running'
	| 'success'
	| 'failure'
	| 'cancelled'
	| 'skipped'
	| 'unknown';

/** One CI run against a branch. GitHub Actions is the first shape; others fit. */
export interface CheckRun {
	id: string;
	name: string;
	status: CheckStatus;
	url: string;
	headBranch: string | null;
	headSha: string;
	event: string;
	startedAt: string | null;
	finishedAt: string | null;
	/** False when the provider exposes no log endpoint for this run. */
	canFetchLogs: boolean;
}

/** A failing run's logs, already trimmed to something a prompt can carry. */
export interface CheckLogBundle {
	runId: string;
	runName: string;
	text: string;
	truncated: boolean;
}

/** What a provider is actually able to do, so the UI hides what it cannot. */
export interface WorkProviderCapabilities {
	pullRequests: boolean;
	checks: boolean;
	comments: boolean;
	/** Editing and deleting comments, which not every tracker permits. */
	editComments: boolean;
	transitions: boolean;
	/** Editing an item's title. */
	editTitle: boolean;
	createPullRequest: boolean;
	createIssue: boolean;
	merge: boolean;
	assign: boolean;
	/** Commits and per-file diffs for a pull request. */
	diff: boolean;
}

/**
 * How a work item's identifier becomes a branch name.
 *
 * `{kind}` → `issue` / `pr`, `{identifier}` → `123`, `{slug}` → the title
 * slugified. Kept as a template rather than a boolean so a team with a naming
 * convention does not have to fight the default.
 */
export const DEFAULT_BRANCH_TEMPLATE = '{kind}/{identifier}-{slug}';

/**
 * Per-binding behaviour. Every transition is null by default: moving someone
 * else's ticket is a visible, outward-facing act, and a tool that starts doing
 * it because it was installed is a tool people stop trusting.
 */
export interface WorkBindingConfig {
	/** State to move the item to when "Start work" runs. Null = do nothing. */
	transitionOnStartWork: string | null;
	/** State to move the item to when a PR is opened for it. Null = do nothing. */
	transitionOnPrOpen: string | null;
	branchTemplate: string;
}

export const DEFAULT_BINDING_CONFIG: WorkBindingConfig = {
	transitionOnStartWork: null,
	transitionOnPrOpen: null,
	branchTemplate: DEFAULT_BRANCH_TEMPLATE
};

/** Which remote project this Clopen project is looking at, through one account. */
export interface IssueBinding {
	/** Provider-specific locator. `owner/repo` for GitHub. */
	locator: string;
	/** How to print it. */
	displayName: string;
	/**
	 * True when nobody chose this — it was read off the git remote. A detected
	 * binding is still editable; the flag exists so the UI can say where it came
	 * from instead of presenting a guess as a decision.
	 */
	detected: boolean;
	defaultBranch: string | null;
	config: WorkBindingConfig;
}

/** One connected account that can serve work items for the current project. */
export interface WorkSource {
	accountId: string;
	provider: string;
	providerName: string;
	label: string;
	/** Who the credential belongs to, used to decide what the user may edit. */
	viewer: string | null;
	capabilities: WorkProviderCapabilities;
	binding: IssueBinding | null;
	/** Candidate locators read off the project's git remotes, for the picker. */
	suggestedLocators: string[];
	status: 'ok' | 'needs_auth' | 'needs_config' | 'error' | 'unknown';
	statusDetail: string | null;
}

/** Provider-side state filter. Separate from "mine", which is about people. */
export type WorkItemState = 'open' | 'closed' | 'all';

export interface WorkItemQuery {
	kind: WorkItemKind;
	state: WorkItemState;
	/** Only items assigned to — or, for pull requests, opened by — the viewer. */
	mineOnly: boolean;
	author?: string;
	labels?: string[];
	/** ISO dates, inclusive, applied to the item's last update. */
	since?: string;
	until?: string;
	search?: string;
	/** 1-based. The list appends rather than replaces for anything above 1. */
	page?: number;
}

/** Remaining API budget, shown in the panel footer rather than discovered by a 403. */
export interface WorkRateLimit {
	remaining: number;
	limit: number;
	resetAt: string | null;
}

export interface WorkItemPage {
	items: WorkItem[];
	rateLimit: WorkRateLimit | null;
	/** True when the provider reported another page after this one. */
	hasMore: boolean;
	/**
	 * Provider page to resume from.
	 *
	 * NOT `page + 1`: a filtered page can drain several provider pages, and
	 * guessing would re-request everything the last call already consumed.
	 */
	nextPage: number | null;
}

/** The link between a work item and the local work started for it. */
export interface WorkItemLink {
	itemKind: WorkItemKind;
	itemIdentifier: string;
	worktreeId: string | null;
	worktreeName: string | null;
	sessionId: string | null;
	branch: string | null;
	createdAt: string;
}

export interface StartWorkResult {
	worktreeId: string;
	worktreeName: string;
	sessionId: string;
	branch: string;
	/** The first message, already composed. The client sends it. */
	prompt: string;
	/** Null when no transition was configured, or when one was and it failed. */
	transitionedTo: string | null;
	transitionError: string | null;
	/** True when the clone could not carry ignored files, so deps need installing. */
	needsSetup: boolean;
}

export interface PullRequestDraft {
	title: string;
	body: string;
	base: string;
	head: string;
	isDraft: boolean;
}

/** Everything the PR composer needs to open, resolved server-side in one call. */
export interface PullRequestContext {
	/** Local branch the PR would come from. */
	head: string;
	base: string;
	baseCandidates: string[];
	/** Local branches the PR could come from instead. */
	headCandidates: string[];
	/** False when the branch has never been pushed — the composer offers to. */
	isPushed: boolean;
	/** Where an unpushed branch would go, so the offer can name it. */
	pushRemote: string;
	/** Commits on head that are not on base, newest first. */
	commits: { hash: string; subject: string }[];
	/** An open PR for this branch, when one already exists. */
	existing: WorkItem | null;
	/** The work item this branch was started from, when "Start work" made it. */
	linkedItem: WorkItemLink | null;
}
