/**
 * Issues & PRs surface store.
 *
 * Holds what is being LOOKED AT — which project, which source, which tab, which
 * item is open — and nothing that the server owns. Work items are not cached
 * across opens: the provider is the truthful answer and a list that is three
 * hours stale is worse than a spinner, especially for a panel whose whole point
 * is "what should I work on now".
 *
 * The project is part of that state and NOT read from the workspace. This
 * surface lives in More Tools, which is global: looking at another project's
 * issues must not require abandoning the session you are in. Every request
 * carries the project explicitly, and the workspace only moves when an action
 * genuinely relocates you — starting work.
 *
 * The panel is provider-agnostic, and so is this file. Anything that reads
 * `provider === 'github'` here would be a bug in the interface, not a feature.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import { projectState, setCurrentProject } from '$frontend/stores/core/projects.svelte';
import { settings } from '$frontend/stores/features/settings.svelte';
import { chatService } from '$frontend/services/chat/chat.service';
import { showPanel } from '$frontend/stores/ui/workspace.svelte';
import { showError, showInfo, showSuccess } from '$frontend/stores/ui/notification.svelte';
import { closeWorkDialog } from '$frontend/stores/ui/quick-panels.svelte';
import { loadWorktrees, switchToSession } from '$frontend/stores/features/worktrees.svelte';
import { resolveGenerationModel } from '$frontend/utils/model-override';
import type { ChatSession } from '$shared/types/database/schema';
import type {
	CheckRun,
	CommitDetail,
	CommitRef,
	FileChange,
	FileContent,
	WorkBindingConfig,
	WorkRateLimit,
	WorkSource,
	MergeMethod,
	PullRequestContext,
	WorkItem,
	WorkItemComment,
	WorkItemDetail,
	WorkItemKind,
	WorkItemState,
	WorkItemStateOption
} from '$shared/types/work';

/** Everything the list can be narrowed by. Empty strings mean "not set". */
export interface ListFilters {
	state: WorkItemState;
	mineOnly: boolean;
	author: string;
	labels: string[];
	since: string;
	until: string;
}

export const EMPTY_FILTERS: ListFilters = {
	state: 'open',
	mineOnly: false,
	author: '',
	labels: [],
	since: '',
	until: ''
};

/**
 * Which list you are looking at.
 *
 * Checks used to be a third entry here, listing runs for whatever branch the
 * workspace happened to be on. It is now only a tab of a pull request, where
 * the runs belong to the thing being read rather than to the window behind it.
 */
export type WorkTab = 'issue' | 'pull-request';

/** Sub-views of one pull request, mirroring what the provider's own UI offers. */
export type DetailTab = 'conversation' | 'commits' | 'checks' | 'files';

/**
 * Starting work clones a project into a new worktree, which on a filesystem
 * without reflink support is a real byte copy of everything the project needs
 * to run. The default 30-second request timeout expired mid-clone, and the
 * server carried on: the worktree appeared, the client never learned its
 * session id, and the user was left with a tree nobody was working in.
 */
const START_WORK_TIMEOUT_MS = 10 * 60 * 1000;

interface IssuesState {
	/**
	 * Mirrors the modal's visibility, set by the modal itself.
	 *
	 * `quickPanelsState.workOpen` is the source of truth for whether the
	 * surface is on screen — it is what the navigators bind to. This flag exists
	 * only so a server-pushed change knows whether anyone is looking, and it
	 * must never be the thing that closes the modal.
	 */
	isActive: boolean;
	/** Project being VIEWED here, which need not be the workspace's. */
	projectId: string | null;
	sources: WorkSource[];
	activeAccountId: string | null;
	tab: WorkTab;
	detailTab: DetailTab;
	filters: ListFilters;
	search: string;

	items: WorkItem[];
	/** Provider says another page exists. Drives load-on-scroll. */
	hasMore: boolean;
	/** Provider page the next load-more should ask for. */
	nextPage: number;
	isLoadingMore: boolean;
	/**
	 * Generation of the newest list request.
	 *
	 * Typing a filter and clearing it fires two requests, and the first can
	 * answer after the second — leaving the cleared list showing the filtered
	 * result. Every response checks this before writing, so a stale answer is
	 * discarded instead of winning.
	 */
	listGeneration: number;
	labels: string[];
	rateLimit: WorkRateLimit | null;
	isLoadingSources: boolean;
	isLoadingItems: boolean;
	error: string | null;

	selectedId: string | null;
	detail: WorkItemDetail | null;
	isLoadingDetail: boolean;
	states: WorkItemStateOption[];

	commits: CommitRef[];
	files: FileChange[];
	isLoadingDetailTab: boolean;
	/** Commit the Commits tab is showing, and what it contains. */
	selectedCommit: string | null;
	commitDetail: CommitDetail | null;
	isLoadingCommit: boolean;

	assignees: string[];

	checks: CheckRun[];
	checksBranch: string;
	isLoadingChecks: boolean;

	/** Item id currently being started, so its row can show progress. */
	startingId: string | null;
	/** Run id currently being sent to chat. */
	sendingRunId: string | null;
	isCommenting: boolean;
	isMerging: boolean;
}

const state = $state<IssuesState>({
	isActive: false,
	projectId: null,
	sources: [],
	activeAccountId: null,
	tab: 'issue',
	detailTab: 'conversation',
	filters: { ...EMPTY_FILTERS },
	search: '',

	items: [],
	hasMore: false,
	nextPage: 1,
	isLoadingMore: false,
	listGeneration: 0,
	labels: [],
	rateLimit: null,
	isLoadingSources: false,
	isLoadingItems: false,
	error: null,

	selectedId: null,
	detail: null,
	isLoadingDetail: false,
	states: [],

	commits: [],
	files: [],
	isLoadingDetailTab: false,
	selectedCommit: null,
	commitDetail: null,
	isLoadingCommit: false,

	assignees: [],

	checks: [],
	checksBranch: '',
	isLoadingChecks: false,

	startingId: null,
	sendingRunId: null,
	isCommenting: false,
	isMerging: false
});

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function kindOf(tab: WorkTab): WorkItemKind {
	return tab === 'issue' ? 'issue' : 'pull-request';
}

/** Every request carries the project explicitly — see the file header. */
function scope(): { projectId: string } | Record<string, never> {
	return state.projectId ? { projectId: state.projectId } : {};
}

export const workStore = {
	get isActive(): boolean {
		return state.isActive;
	},
	get projectId(): string | null {
		return state.projectId;
	},
	get project() {
		return projectState.projects.find((entry) => entry.id === state.projectId) ?? null;
	},
	get sources(): WorkSource[] {
		return state.sources;
	},
	get source(): WorkSource | null {
		return state.sources.find((entry) => entry.accountId === state.activeAccountId) ?? null;
	},
	get tab(): WorkTab {
		return state.tab;
	},
	get detailTab(): DetailTab {
		return state.detailTab;
	},
	get filters(): ListFilters {
		return state.filters;
	},
	get hasMore(): boolean {
		return state.hasMore;
	},
	get isLoadingMore(): boolean {
		return state.isLoadingMore;
	},
	get labels(): string[] {
		return state.labels;
	},
	/** How many filters are narrowing the list, for the toolbar's badge. */
	get activeFilterCount(): number {
		const f = state.filters;
		// `state` is deliberately absent: Open / Closed / All is which slice you
		// are looking at, and it has its own visible control. Counting it made
		// the badge read "1 filter" for a list nobody had narrowed.
		return [
			f.mineOnly,
			f.author !== '',
			f.labels.length > 0,
			f.since !== '',
			f.until !== ''
		].filter(Boolean).length;
	},
	get search(): string {
		return state.search;
	},
	set search(value: string) {
		state.search = value;
	},
	get items(): WorkItem[] {
		return state.items;
	},
	get rateLimit(): WorkRateLimit | null {
		return state.rateLimit;
	},
	get isLoadingSources(): boolean {
		return state.isLoadingSources;
	},
	get isLoadingItems(): boolean {
		return state.isLoadingItems;
	},
	get error(): string | null {
		return state.error;
	},
	get selectedId(): string | null {
		return state.selectedId;
	},
	get detail(): WorkItemDetail | null {
		return state.detail;
	},
	get isLoadingDetail(): boolean {
		return state.isLoadingDetail;
	},
	get isLoadingDetailTab(): boolean {
		return state.isLoadingDetailTab;
	},
	get states(): WorkItemStateOption[] {
		return state.states;
	},
	get commits(): CommitRef[] {
		return state.commits;
	},
	get files(): FileChange[] {
		return state.files;
	},
	get selectedCommit(): string | null {
		return state.selectedCommit;
	},
	get commitDetail(): CommitDetail | null {
		return state.commitDetail;
	},
	get isLoadingCommit(): boolean {
		return state.isLoadingCommit;
	},
	get assignees(): string[] {
		return state.assignees;
	},
	get checks(): CheckRun[] {
		return state.checks;
	},
	get checksBranch(): string {
		return state.checksBranch;
	},
	get isLoadingChecks(): boolean {
		return state.isLoadingChecks;
	},
	get startingId(): string | null {
		return state.startingId;
	},
	get sendingRunId(): string | null {
		return state.sendingRunId;
	},
	get isCommenting(): boolean {
		return state.isCommenting;
	},
	get isMerging(): boolean {
		return state.isMerging;
	},

	/** True when a source exists but has not been pointed at a repository. */
	get needsBinding(): boolean {
		return this.source !== null && this.source.binding === null;
	},

	/** Called by the modal when it opens. */
	activate(): void {
		state.isActive = true;
		// Defaults to the workspace's project the FIRST time only; after that the
		// user's choice here survives, because this surface is not tied to what
		// the workspace happens to be showing.
		state.projectId ??= projectState.currentProject?.id ?? null;
		void this.loadSources();
	},

	/** Called by the modal when it closes. */
	deactivate(): void {
		state.isActive = false;
		// Detail state is dropped, list state is not: closing and reopening should
		// land back on the tab and filter the user chose, but never on a stale
		// issue body from before someone else edited it.
		state.selectedId = null;
		state.detail = null;
	},

	/** Look at another project without leaving the session you are in. */
	async selectProject(projectId: string): Promise<void> {
		if (state.projectId === projectId) return;
		state.projectId = projectId;
		state.activeAccountId = null;
		state.selectedId = null;
		state.detail = null;
		state.items = [];
		state.checks = [];
		await this.loadSources();
	},

	/**
	 * Which accounts can serve this project, and what they are bound to.
	 *
	 * Also where the repository is auto-detected from the git remote, which is
	 * why the first open on a fresh project takes a moment longer.
	 */
	async loadSources(): Promise<void> {
		if (!state.projectId) return;

		state.isLoadingSources = true;
		state.error = null;
		try {
			const sources = (await ws.http('work:sources', { ...scope() })) as WorkSource[];
			state.sources = sources;

			const stillThere = sources.some((entry) => entry.accountId === state.activeAccountId);
			if (!stillThere) state.activeAccountId = sources[0]?.accountId ?? null;

			if (state.activeAccountId) await this.loadItems();
		} catch (error) {
			debug.error('work', 'Failed to load issue sources:', error);
			state.error = messageOf(error);
			state.sources = [];
		} finally {
			state.isLoadingSources = false;
		}
	},

	async selectSource(accountId: string): Promise<void> {
		if (state.activeAccountId === accountId) return;
		state.activeAccountId = accountId;
		state.selectedId = null;
		state.detail = null;
		await this.loadItems();
	},

	async setTab(tab: WorkTab): Promise<void> {
		if (state.tab === tab) return;
		state.tab = tab;
		state.selectedId = null;
		state.detail = null;
		await this.loadItems();
	},

	async setFilters(next: Partial<ListFilters>): Promise<void> {
		state.filters = { ...state.filters, ...next };
		await this.loadItems();
	},

	async clearFilters(): Promise<void> {
		state.filters = { ...EMPTY_FILTERS };
		state.search = '';
		await this.loadItems();
	},

	/** Labels this repository defines, fetched once per binding. */
	async loadLabels(): Promise<void> {
		const accountId = state.activeAccountId;
		if (!accountId || state.labels.length > 0) return;
		try {
			state.labels = (await ws.http('work:labels', { ...scope(), accountId })) as string[];
		} catch (error) {
			debug.warn('work', 'Could not load labels:', error);
		}
	},

	async loadItems(): Promise<void> {
		await this.fetchPage(1);
	},

	/** Append the next page. Called when the list is scrolled near its end. */
	async loadMore(): Promise<void> {
		if (!state.hasMore || state.isLoadingMore || state.isLoadingItems) return;
		await this.fetchPage(state.nextPage);
	},

	/**
	 * One page of the list.
	 *
	 * Page 1 replaces, anything above appends. Both paths are guarded by a
	 * generation counter: without it a slow first request could land after a
	 * faster second one and overwrite the newer results, which is exactly what
	 * made typing a filter and clearing it leave a partial list on screen.
	 */
	async fetchPage(page: number): Promise<void> {
		const accountId = state.activeAccountId;
		if (!accountId) return;
		// An unbound source has no repository to list from; the panel shows the
		// binding prompt instead, and asking anyway would only produce an error.
		if (!this.source?.binding) {
			state.items = [];
			return;
		}

		const generation = ++state.listGeneration;
		if (page === 1) state.isLoadingItems = true;
		else state.isLoadingMore = true;
		state.error = null;

		try {
			const f = state.filters;
			const result = (await ws.http('work:list', {
				...scope(),
				accountId,
				kind: kindOf(state.tab),
				state: f.state,
				mineOnly: f.mineOnly,
				...(f.author.trim() && { author: f.author.trim() }),
				...(f.labels.length > 0 && { labels: f.labels }),
				...(f.since && { since: f.since }),
				...(f.until && { until: f.until }),
				...(state.search.trim() && { search: state.search.trim() }),
				...(page > 1 && { page })
			})) as {
				items: WorkItem[];
				rateLimit: WorkRateLimit | null;
				hasMore: boolean;
				nextPage: number | null;
			};

			if (generation !== state.listGeneration) return;

			state.items = page === 1 ? result.items : [...state.items, ...result.items];
			state.rateLimit = result.rateLimit;
			state.hasMore = result.hasMore;
			// The server says where to resume: one filtered page can drain several
			// provider pages, so page + 1 would re-read what we just consumed.
			state.nextPage = result.nextPage ?? page + 1;
		} catch (error) {
			if (generation !== state.listGeneration) return;
			debug.error('work', 'Failed to list work items:', error);
			state.error = messageOf(error);
			if (page === 1) state.items = [];
		} finally {
			if (generation === state.listGeneration) {
				state.isLoadingItems = false;
				state.isLoadingMore = false;
			}
		}
	},

	/**
	 * CI runs for a branch.
	 *
	 * `branch` is explicit for the pull-request Checks tab, which must show the
	 * runs for the PR's HEAD branch — not for whatever branch the workspace
	 * happens to be sitting on, which is what leaving it to the server's default
	 * would do and is almost never the same thing.
	 */
	async loadChecks(branch?: string): Promise<void> {
		const accountId = state.activeAccountId;
		if (!accountId || !this.source?.binding) return;

		state.isLoadingChecks = true;
		state.error = null;
		try {
			const result = (await ws.http('work:checks', {
				...scope(),
				accountId,
				...(branch && { branch })
			})) as {
				branch: string;
				runs: CheckRun[];
			};
			state.checks = result.runs;
			state.checksBranch = result.branch;
		} catch (error) {
			debug.error('work', 'Failed to load CI runs:', error);
			state.error = messageOf(error);
			state.checks = [];
		} finally {
			state.isLoadingChecks = false;
		}
	},

	async select(item: WorkItem | null): Promise<void> {
		if (!item) {
			state.selectedId = null;
			state.detail = null;
			return;
		}

		const accountId = state.activeAccountId;
		if (!accountId) return;

		state.selectedId = item.id;
		state.detail = null;
		state.detailTab = 'conversation';
		state.commits = [];
		state.files = [];
		state.selectedCommit = null;
		state.commitDetail = null;
		state.isLoadingDetail = true;
		try {
			state.detail = (await ws.http('work:get', {
				...scope(),
				accountId,
				kind: item.kind,
				id: item.id
			})) as WorkItemDetail;

			state.states = await this.fetchStates(item.kind);
		} catch (error) {
			debug.error('work', 'Failed to load work item:', error);
			showError('Could not open item', messageOf(error));
			state.selectedId = null;
		} finally {
			state.isLoadingDetail = false;
		}
	},

	/** Reload the open item without clearing the pane first. */
	async refreshDetail(): Promise<void> {
		const detail = state.detail;
		const accountId = state.activeAccountId;
		if (!detail || !accountId) return;

		try {
			state.detail = (await ws.http('work:get', {
				...scope(),
				accountId,
				kind: detail.kind,
				id: detail.id
			})) as WorkItemDetail;
		} catch (error) {
			debug.warn('work', 'Could not refresh the open item:', error);
		}
	},

	/**
	 * Sub-views of a pull request, loaded on demand.
	 *
	 * Commits and the file list are each an extra request against a rate limit
	 * shared with everything else here, so they are fetched when their tab is
	 * opened rather than alongside the conversation nobody may scroll past.
	 */
	async setDetailTab(tab: DetailTab): Promise<void> {
		state.detailTab = tab;
		const detail = state.detail;
		const accountId = state.activeAccountId;
		if (!detail || !accountId || detail.kind !== 'pull-request') return;

		if (tab === 'checks') {
			await this.loadChecks(detail.headBranch);
			return;
		}
		if (tab === 'commits' && state.commits.length > 0) return;
		if (tab === 'files' && state.files.length > 0) return;
		if (tab !== 'commits' && tab !== 'files') return;

		state.isLoadingDetailTab = true;
		try {
			if (tab === 'commits') {
				state.commits = (await ws.http('work:pr-commits', {
					...scope(),
					accountId,
					id: detail.id
				})) as CommitRef[];
				// Open the newest one straight away: a list of subjects beside an
				// empty pane makes the reader click before it says anything.
				const newest = state.commits[0];
				if (newest) void this.openCommit(newest.hash);
			} else {
				state.files = (await ws.http('work:pr-files', {
					...scope(),
					accountId,
					id: detail.id
				})) as FileChange[];
			}
		} catch (error) {
			showError('Could not load that tab', messageOf(error));
		} finally {
			state.isLoadingDetailTab = false;
		}
	},

	/** One commit's message, stats and files. */
	async openCommit(hash: string): Promise<void> {
		const accountId = state.activeAccountId;
		if (!accountId || state.selectedCommit === hash) return;

		state.selectedCommit = hash;
		state.commitDetail = null;
		state.isLoadingCommit = true;
		try {
			const result = (await ws.http('work:commit-detail', {
				...scope(),
				accountId,
				sha: hash
			})) as CommitDetail;
			// A slower answer for a commit the user has since moved off must not
			// overwrite the one they are looking at.
			if (state.selectedCommit !== hash) return;
			state.commitDetail = result;
		} catch (error) {
			if (state.selectedCommit === hash) showError('Could not open that commit', messageOf(error));
		} finally {
			if (state.selectedCommit === hash) state.isLoadingCommit = false;
		}
	},

	// -----------------------------------------------------------------------
	// Comments
	// -----------------------------------------------------------------------

	async comment(body: string): Promise<boolean> {
		const accountId = state.activeAccountId;
		const detail = state.detail;
		if (!accountId || !detail || !body.trim()) return false;

		state.isCommenting = true;
		try {
			await ws.http('work:comment', {
				...scope(),
				accountId,
				kind: detail.kind,
				id: detail.id,
				body: body.trim()
			});
			// Refetch rather than appending locally: the provider decides the id,
			// the timestamp and any rendering it applies to the body.
			await this.refreshDetail();
			return true;
		} catch (error) {
			showError('Comment failed', messageOf(error));
			return false;
		} finally {
			state.isCommenting = false;
		}
	},

	async updateComment(comment: WorkItemComment, body: string): Promise<boolean> {
		const accountId = state.activeAccountId;
		if (!accountId || !body.trim()) return false;

		try {
			await ws.http('work:comment-update', {
				...scope(),
				accountId,
				commentId: comment.id,
				source: comment.source,
				body: body.trim()
			});
			await this.refreshDetail();
			return true;
		} catch (error) {
			showError('Could not save the comment', messageOf(error));
			return false;
		}
	},

	async deleteComment(comment: WorkItemComment): Promise<void> {
		const accountId = state.activeAccountId;
		if (!accountId) return;

		try {
			await ws.http('work:comment-delete', {
				...scope(),
				accountId,
				commentId: comment.id,
				source: comment.source
			});
			await this.refreshDetail();
		} catch (error) {
			showError('Could not delete the comment', messageOf(error));
		}
	},

	// -----------------------------------------------------------------------
	// State, assignees, creation
	// -----------------------------------------------------------------------

	/**
	 * The states a provider offers for one kind.
	 *
	 * Returns rather than stores, because two screens want them for different
	 * kinds at the same time: the detail pane wants them for the item that is
	 * open, and the behaviour form wants the ISSUE states regardless of what is
	 * open. Writing both into one field made the second show the first's.
	 */
	async fetchStates(kind: WorkItemKind): Promise<WorkItemStateOption[]> {
		const accountId = state.activeAccountId;
		if (!accountId || !this.source?.binding) return [];
		try {
			return (await ws.http('work:states', { ...scope(), accountId, kind })) as WorkItemStateOption[];
		} catch (error) {
			debug.warn('work', 'Could not load states:', error);
			return [];
		}
	},

	/** Edit the item's title, its body, or both. */
	async updateItem(patch: { title?: string; body?: string }): Promise<boolean> {
		const accountId = state.activeAccountId;
		const detail = state.detail;
		if (!accountId || !detail) return false;

		try {
			await ws.http('work:update-item', {
				...scope(),
				accountId,
				kind: detail.kind,
				id: detail.id,
				...(patch.title !== undefined && { title: patch.title.trim() }),
				...(patch.body !== undefined && { body: patch.body })
			});
			await this.refreshDetail();
			// The title shows in the list too, so a rename has to reach both.
			if (patch.title !== undefined) await this.loadItems();
			return true;
		} catch (error) {
			showError('Could not save', messageOf(error));
			return false;
		}
	},

	async transition(stateValue: string): Promise<void> {
		const accountId = state.activeAccountId;
		const detail = state.detail;
		if (!accountId || !detail) return;

		try {
			await ws.http('work:transition', {
				...scope(),
				accountId,
				kind: detail.kind,
				id: detail.id,
				state: stateValue
			});
			await this.refreshDetail();
			await this.loadItems();
		} catch (error) {
			showError('Could not change state', messageOf(error));
		}
	},

	/**
	 * One file's full text.
	 *
	 * The blob id travels with the file change and is what the server prefers:
	 * a branch name only resolves while the branch exists in THIS repository,
	 * which is not true of a fork's pull request, a merged one whose branch was
	 * deleted, or a file the pull request removed. The ref is a fallback for
	 * anything that reaches here without a blob.
	 */
	async fetchFileContent(file: { path: string; sha?: string }): Promise<FileContent | null> {
		const accountId = state.activeAccountId;
		const detail = state.detail;
		const ref = detail?.headSha || detail?.headBranch;
		if (!accountId || (!ref && !file.sha)) return null;

		try {
			return (await ws.http('work:file-content', {
				...scope(),
				accountId,
				path: file.path,
				ref: ref ?? 'HEAD',
				...(file.sha && { blobSha: file.sha })
			})) as FileContent;
		} catch (error) {
			throw new Error(messageOf(error));
		}
	},

	/** Candidate assignees for the bound repository. Cached for the session. */
	async loadAssignees(): Promise<void> {
		const accountId = state.activeAccountId;
		if (!accountId || state.assignees.length > 0) return;
		try {
			state.assignees = (await ws.http('work:assignees', { ...scope(), accountId })) as string[];
		} catch (error) {
			debug.warn('work', 'Could not load assignees:', error);
		}
	},

	async setAssignees(logins: string[]): Promise<void> {
		const accountId = state.activeAccountId;
		const detail = state.detail;
		if (!accountId || !detail) return;

		try {
			await ws.http('work:set-assignees', {
				...scope(),
				accountId,
				kind: detail.kind,
				id: detail.id,
				logins
			});
			await this.refreshDetail();
			await this.loadItems();
		} catch (error) {
			showError('Could not change assignees', messageOf(error));
		}
	},

	async createIssue(draft: { title: string; body: string; assignees: string[]; labels: string[] }): Promise<WorkItem | null> {
		const accountId = state.activeAccountId;
		if (!accountId) return null;

		try {
			const item = (await ws.http('work:create-issue', {
				...scope(),
				accountId,
				title: draft.title.trim(),
				body: draft.body,
				assignees: draft.assignees,
				labels: draft.labels
			})) as WorkItem;

			showSuccess('Issue created', `#${item.identifier} ${item.title}`);
			await this.loadItems();
			await this.select(item);
			return item;
		} catch (error) {
			showError('Could not create the issue', messageOf(error));
			return null;
		}
	},

	// -----------------------------------------------------------------------
	// Binding
	// -----------------------------------------------------------------------

	async setBinding(locator: string): Promise<void> {
		const accountId = state.activeAccountId;
		if (!accountId || !locator.trim()) return;

		try {
			await ws.http('work:set-binding', { ...scope(), accountId, locator: locator.trim() });
			state.assignees = [];
			state.labels = [];
			await this.loadSources();
		} catch (error) {
			showError('Could not set the repository', messageOf(error));
		}
	},

	async setConfig(config: WorkBindingConfig): Promise<void> {
		const accountId = state.activeAccountId;
		if (!accountId) return;

		try {
			await ws.http('work:set-config', { ...scope(), accountId, config });
			await this.loadSources();
		} catch (error) {
			showError('Could not save settings', messageOf(error));
		}
	},

	// -----------------------------------------------------------------------
	// The two closed loops
	// -----------------------------------------------------------------------

	/**
	 * Start work: worktree, branch, session, and the first message sent.
	 *
	 * The server does the creating and hands back the prompt; the client moves
	 * the workspace into the new session and sends it. Sending from here rather
	 * than from the backend is what keeps one chat pipeline: the optimistic
	 * message, the streaming state and the active session are all owned by the
	 * browser.
	 *
	 * This is the one action that DOES relocate the workspace, so when the
	 * surface is pointed at another project it switches to that project first —
	 * starting work means going there.
	 */
	async startWork(item: WorkItem): Promise<void> {
		const accountId = state.activeAccountId;
		if (!accountId || state.startingId) return;

		state.startingId = item.id;
		try {
			const result = (await ws.http('work:start-work', {
				...scope(),
				accountId,
				kind: item.kind,
				id: item.id,
				engine: settings.selectedEngine
			}, START_WORK_TIMEOUT_MS)) as {
				worktreeId: string;
				worktreeName: string;
				sessionId: string;
				branch: string;
				prompt: string;
				transitionedTo: string | null;
				transitionError: string | null;
				needsSetup: boolean;
			};

			closeWorkDialog();

			// Move the workspace to the project the work was started in, when it
			// is not the one already open. The session lives there, and switching
			// afterwards would leave the chat pointed at another project's tree.
			if (state.projectId && state.projectId !== projectState.currentProject?.id) {
				const target = projectState.projects.find((entry) => entry.id === state.projectId);
				if (target) await setCurrentProject(target);
			}

			// The worktree list must hold the new tree before the workspace is
			// pointed at it, or the switch resolves to a tree the client cannot
			// name and the panels fall back to the main project root.
			await loadWorktrees();

			const { session } = (await ws.http('sessions:get', { id: result.sessionId })) as {
				session: ChatSession;
			};

			showPanel('chat');
			await switchToSession(session);
			await chatService.sendMessage(result.prompt);

			showSuccess(
				`Working on #${item.identifier}`,
				`Worktree "${result.worktreeName}" on branch ${result.branch}`
			);

			if (result.needsSetup) {
				showInfo(
					'Dependencies were not copied',
					'This worktree was cloned without ignored files — run your install command before building.'
				);
			}
			if (result.transitionError) {
				showInfo('State not changed', result.transitionError);
			}
		} catch (error) {
			debug.error('work', 'Start work failed:', error);
			showError('Could not start work', messageOf(error));
		} finally {
			state.startingId = null;
		}
	},

	/**
	 * A failing run's logs, for reading in Clopen.
	 *
	 * Separate from `sendCheckToChat` because they are different intents:
	 * looking at why CI failed, and handing the failure to an agent. The first
	 * should not spend a chat turn.
	 */
	async fetchCheckLogs(run: CheckRun): Promise<{ runName: string; text: string; truncated: boolean } | null> {
		const accountId = state.activeAccountId;
		if (!accountId) return null;

		try {
			return (await ws.http('work:check-logs', {
				...scope(),
				accountId,
				runId: run.id,
				branch: run.headBranch ?? state.checksBranch,
				runUrl: run.url
			})) as { runName: string; text: string; truncated: boolean };
		} catch (error) {
			showError('Could not read the logs', messageOf(error));
			return null;
		}
	},

	/** Push a failing run's logs into the chat as context. */
	async sendCheckToChat(run: CheckRun): Promise<void> {
		const accountId = state.activeAccountId;
		if (!accountId || state.sendingRunId) return;

		state.sendingRunId = run.id;
		try {
			const result = (await ws.http('work:check-logs', {
				...scope(),
				accountId,
				runId: run.id,
				branch: run.headBranch ?? state.checksBranch,
				runUrl: run.url
			})) as { runName: string; prompt: string; truncated: boolean };

			closeWorkDialog();
			showPanel('chat');
			await chatService.sendMessage(result.prompt);
		} catch (error) {
			debug.error('work', 'Could not send CI logs to chat:', error);
			showError('Could not read the logs', messageOf(error));
		} finally {
			state.sendingRunId = null;
		}
	},

	// -----------------------------------------------------------------------
	// Pull requests
	// -----------------------------------------------------------------------

	async pullRequestContext(accountId: string, head?: string): Promise<PullRequestContext> {
		return (await ws.http('work:pr-context', {
			...scope(),
			accountId,
			...(head && { head })
		})) as PullRequestContext;
	},

	/** Push the head branch, and get the context back as it now stands. */
	async pushPullRequestHead(accountId: string, head: string): Promise<PullRequestContext> {
		return (await ws.http('work:pr-push', { ...scope(), accountId, head })) as PullRequestContext;
	},

	/** Draft a title and body. Uses the Git generator model override. */
	async draftPullRequest(accountId: string, base: string, head: string): Promise<{ title: string; body: string }> {
		const { engine, providerSlug, modelId } = resolveGenerationModel(settings.commitGenerator);
		if (!modelId) throw new Error('No model configured. Pick one in Settings → Models.');

		return (await ws.http('work:pr-draft', {
			...scope(),
			accountId,
			base,
			head,
			engine,
			providerSlug,
			modelId
		})) as { title: string; body: string };
	},

	async createPullRequest(input: {
		accountId: string;
		title: string;
		body: string;
		base: string;
		head: string;
		isDraft: boolean;
	}): Promise<WorkItem> {
		const result = (await ws.http('work:pr-create', { ...scope(), ...input })) as {
			item: WorkItem;
			transitionedTo: string | null;
			transitionError: string | null;
		};

		if (result.transitionError) showInfo('Issue state not changed', result.transitionError);
		await this.loadSources();
		return result.item;
	},

	/** Merge the open pull request. The caller confirms first. */
	async mergePullRequest(method: MergeMethod, title?: string): Promise<boolean> {
		const accountId = state.activeAccountId;
		const detail = state.detail;
		if (!accountId || !detail || state.isMerging) return false;

		state.isMerging = true;
		try {
			await ws.http('work:pr-merge', {
				...scope(),
				accountId,
				id: detail.id,
				method,
				...(title?.trim() && { title: title.trim() })
			});
			showSuccess('Merged', `#${detail.identifier} ${detail.title}`);
			await this.refreshDetail();
			await this.loadItems();
			return true;
		} catch (error) {
			showError('Could not merge', messageOf(error));
			return false;
		} finally {
			state.isMerging = false;
		}
	},

	/** Called by the `work:changed` event, and after a project switch. */
	invalidate(): void {
		if (!state.isActive) return;
		void this.loadSources();
	},

	reset(): void {
		state.projectId = null;
		state.sources = [];
		state.activeAccountId = null;
		state.items = [];
		state.checks = [];
		state.commits = [];
		state.files = [];
		state.selectedCommit = null;
		state.commitDetail = null;
		state.assignees = [];
		state.labels = [];
		state.selectedId = null;
		state.detail = null;
		state.error = null;
	}
};

let eventsBound = false;

/**
 * Subscribe to server-side changes.
 *
 * Guarded like the worktree events it sits next to: this runs on every project
 * switch, and a second subscription would refetch the source list twice for
 * every change.
 */
export function initIssuesEvents(): void {
	if (eventsBound) return;
	eventsBound = true;

	ws.on('work:changed', (payload) => {
		// Keyed on the project this surface is VIEWING, not the workspace's:
		// they are allowed to differ, and using the workspace here would ignore
		// changes to the project actually on screen.
		if (payload.projectId !== workStore.projectId) return;
		workStore.invalidate();
	});
}
