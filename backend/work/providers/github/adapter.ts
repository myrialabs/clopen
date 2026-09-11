/**
 * GitHub, behind the provider-agnostic issue interface.
 *
 * This file is the proof that the interface is the right shape: everything
 * GitHub-specific — that issues and pull requests share a number space, that
 * `/issues` also returns pull requests, that a fine-grained token 404s on a
 * repo it cannot see — is absorbed here, and none of it reaches the panel.
 */

import type {
	CheckLogBundle,
	CheckRun,
	CheckStatus,
	CommentSource,
	WorkRateLimit,
	TimelineEventKind,
	WorkItemEvent,
	CommitDetail,
	CommitRef,
	FileContent,
	FileChange,
	WorkProviderCapabilities,
	MergeMethod,
	PullRequestDraft,
	PullRequestMergeability,
	WorkItem,
	WorkItemComment,
	WorkItemDetail,
	WorkItemKind,
	WorkItemPage,
	WorkItemQuery,
	WorkItemStateOption
} from '$shared/types/work';
import type { WorkContext, WorkProviderAdapter, ResolvedBinding, UnboundContext } from '../../types';
import {
	GITHUB_WEB_BASE,
	GitHubError,
	githubPaged,
	githubRequest,
	invalidateGitHubCache,
	tokenKindOf,
	webBaseOf,
	type GitHubCredentials
} from './client';
import { buildRunLogBundle } from './actions-logs';
import { debug } from '$shared/utils/logger';

const CAPABILITIES: WorkProviderCapabilities = {
	pullRequests: true,
	checks: true,
	comments: true,
	editComments: true,
	transitions: true,
	editTitle: true,
	createPullRequest: true,
	createIssue: true,
	merge: true,
	assign: true,
	diff: true
};

/**
 * Per-file patch cap.
 *
 * The files endpoint inlines the diff, and a single generated file can carry
 * megabytes of it. The list is for reading a change, not for reconstructing it,
 * so anything past this is dropped with the counts left intact.
 */
const MAX_PATCH_BYTES = 60 * 1024;

/**
 * What the whole-file viewer will RENDER. Past this, the text is cut and the
 * viewer says so — a partial file answers "what does this look like" far better
 * than a refusal does.
 */
const MAX_RENDER_BYTES = 2 * 1024 * 1024;

/**
 * What it will DOWNLOAD. The blobs endpoint returns base64 in JSON, so a file
 * this size is already a ~27 MB response; past it the honest answer really is
 * the web view.
 */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function credentialsOf(context: UnboundContext | WorkContext): GitHubCredentials {
	return {
		token: context.credentials.token ?? '',
		baseUrl: context.credentials.baseUrl
	};
}

// ---------------------------------------------------------------------------
// Wire shapes. Only the fields the surface reads.
// ---------------------------------------------------------------------------

interface GitHubUser { login: string }

interface GitHubIssue {
	id: number;
	number: number;
	title: string;
	body: string | null;
	html_url: string;
	state: string;
	state_reason?: string | null;
	draft?: boolean;
	labels: (string | { name?: string })[];
	assignees: GitHubUser[] | null;
	user: GitHubUser | null;
	comments?: number;
	created_at: string;
	updated_at: string;
	merged_at?: string | null;
	/** Present only when this "issue" is really a pull request. */
	pull_request?: unknown;
	head?: { ref: string; sha?: string };
	base?: { ref: string };
	merged?: boolean;
	mergeable?: boolean | null;
	mergeable_state?: string;
}

interface GitHubComment {
	id: number;
	body: string | null;
	user: GitHubUser | null;
	created_at: string;
	html_url: string;
	/** Review comments carry the file they were left on. */
	path?: string;
	line?: number | null;
}

interface GitHubReview {
	id: number;
	body: string | null;
	state: string;
	user: GitHubUser | null;
	submitted_at: string | null;
	html_url: string;
}

interface GitHubTimelineEntry {
	id?: number;
	node_id?: string;
	event: string;
	created_at?: string;
	actor?: GitHubUser | null;
	label?: { name: string };
	assignee?: GitHubUser;
	requested_reviewer?: GitHubUser;
	rename?: { from: string; to: string };
	source?: { issue?: { number: number; title: string; html_url: string } };
}

interface GitHubRepo {
	default_branch?: string;
	permissions?: { admin?: boolean; push?: boolean; maintain?: boolean };
	allow_merge_commit?: boolean;
	allow_squash_merge?: boolean;
	allow_rebase_merge?: boolean;
}

interface GitHubCommit {
	sha: string;
	html_url: string;
	commit: { message: string; author: { name?: string; date?: string } | null };
	author: GitHubUser | null;
	stats?: { additions?: number; deletions?: number };
	files?: GitHubFile[];
}

interface GitHubFile {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	patch?: string;
	blob_url?: string;
	/** Blob id of the file at this revision — what the content viewer reads. */
	sha?: string;
	previous_filename?: string;
}

interface GitHubRun {
	id: number;
	name: string | null;
	display_title?: string | null;
	status: string;
	conclusion: string | null;
	html_url: string;
	head_branch: string | null;
	head_sha: string;
	event: string;
	run_started_at: string | null;
	updated_at: string | null;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function labelNames(labels: GitHubIssue['labels']): string[] {
	return (labels ?? [])
		.map((label) => (typeof label === 'string' ? label : label?.name ?? ''))
		.filter(Boolean);
}

/**
 * GitHub has exactly two states, so the interesting information is in the
 * neighbouring fields: a merged PR is `closed` with `merged_at` set, and a draft
 * PR is `open` with `draft`. Flattening those into one category is what lets the
 * panel colour a merged PR differently from an abandoned one without knowing
 * anything about GitHub.
 */
function categorise(raw: GitHubIssue, kind: WorkItemKind) {
	if (kind === 'pull-request') {
		if (raw.merged_at) return 'merged' as const;
		if (raw.state === 'open' && raw.draft) return 'draft' as const;
	}
	return raw.state === 'closed' ? ('closed' as const) : ('open' as const);
}

/** The state name shown to the user — GitHub's own word, plus the reason. */
function stateName(raw: GitHubIssue, kind: WorkItemKind): string {
	if (kind === 'pull-request' && raw.merged_at) return 'merged';
	if (kind === 'pull-request' && raw.state === 'open' && raw.draft) return 'draft';
	if (raw.state === 'closed' && raw.state_reason === 'not_planned') return 'closed (not planned)';
	return raw.state;
}

function toWorkItem(raw: GitHubIssue, kind: WorkItemKind): WorkItem {
	return {
		id: String(raw.number),
		identifier: String(raw.number),
		kind,
		title: raw.title,
		url: raw.html_url,
		state: stateName(raw, kind),
		stateCategory: categorise(raw, kind),
		labels: labelNames(raw.labels),
		assignees: (raw.assignees ?? []).map((user) => user.login),
		author: raw.user?.login ?? null,
		commentCount: raw.comments ?? 0,
		createdAt: raw.created_at,
		updatedAt: raw.updated_at,
		...(kind === 'pull-request' && {
			headBranch: raw.head?.ref,
			...(raw.head?.sha && { headSha: raw.head.sha }),
			baseBranch: raw.base?.ref,
			isDraft: raw.draft === true
		})
	};
}

/**
 * `viewer` and `canWrite` decide what the user is offered.
 *
 * GitHub does not report per-comment permissions, so this reconstructs the two
 * rules it actually applies: an author may always edit and delete their own
 * comment, and anyone with write access to the repository may delete anyone's.
 * Offering an action that will 403 is worse than not offering it.
 */
function toComment(
	raw: GitHubComment,
	source: CommentSource,
	viewer: string | null,
	canWrite: boolean
): WorkItemComment {
	const isAuthor = viewer !== null && raw.user?.login === viewer;
	// A review's summary body is edited through the reviews endpoint with
	// different rules, so it is read-only here rather than offering an edit that
	// would 404.
	const editable = source !== 'review-summary' && (isAuthor || canWrite);
	return {
		id: String(raw.id),
		author: raw.user?.login ?? 'unknown',
		// The location is NOT folded into the body any more: it has its own
		// fields now, and burying it in the text made editing a review comment
		// send the heading back to GitHub as part of the comment.
		body: raw.body ?? '',
		createdAt: raw.created_at,
		url: raw.html_url,
		source,
		canModify: editable,
		...(raw.path && { path: raw.path, line: raw.line ?? null })
	};
}

function toCommit(raw: GitHubCommit): CommitRef {
	const message = raw.commit?.message ?? '';
	return {
		hash: raw.sha.slice(0, 7),
		subject: message.split('\n')[0] ?? '',
		author: raw.author?.login ?? raw.commit?.author?.name ?? null,
		date: raw.commit?.author?.date ?? '',
		url: raw.html_url
	};
}

function toFileChange(raw: GitHubFile): FileChange {
	const patch = raw.patch;
	return {
		path: raw.filename,
		status: raw.status,
		additions: raw.additions,
		deletions: raw.deletions,
		...(patch && patch.length <= MAX_PATCH_BYTES && { patch }),
		url: raw.blob_url ?? '',
		...(raw.sha && { sha: raw.sha }),
		...(raw.previous_filename && { previousPath: raw.previous_filename })
	};
}

function toMergeability(raw: GitHubIssue, repo: GitHubRepo | null): PullRequestMergeability {
	const allowed: MergeMethod[] = [];
	// A repository can switch any of the three off, and offering a disabled one
	// produces a 405 the moment the user commits to it.
	if (repo?.allow_merge_commit !== false) allowed.push('merge');
	if (repo?.allow_squash_merge !== false) allowed.push('squash');
	if (repo?.allow_rebase_merge !== false) allowed.push('rebase');

	return {
		mergeable: raw.mergeable ?? null,
		state: raw.mergeable_state ?? 'unknown',
		allowedMethods: allowed,
		merged: raw.merged === true || Boolean(raw.merged_at)
	};
}

function toCheckStatus(run: GitHubRun): CheckStatus {
	if (run.status === 'queued' || run.status === 'waiting' || run.status === 'pending') return 'queued';
	if (run.status !== 'completed') return 'running';
	switch (run.conclusion) {
		case 'success': return 'success';
		case 'failure': return 'failure';
		case 'timed_out': return 'failure';
		case 'startup_failure': return 'failure';
		case 'cancelled': return 'cancelled';
		case 'skipped': return 'skipped';
		case 'neutral': return 'success';
		default: return 'unknown';
	}
}

function toCheckRun(run: GitHubRun): CheckRun {
	const status = toCheckStatus(run);
	return {
		id: String(run.id),
		name: run.name || run.display_title || `Run ${run.id}`,
		status,
		url: run.html_url,
		headBranch: run.head_branch,
		headSha: run.head_sha,
		event: run.event,
		startedAt: run.run_started_at,
		finishedAt: run.status === 'completed' ? run.updated_at : null,
		// Only a finished run has logs worth pulling, and only a failed one has
		// logs worth reading.
		canFetchLogs: status === 'failure'
	};
}

/**
 * The timeline events worth drawing.
 *
 * Anything not listed is dropped. GitHub emits dozens of event types, many of
 * them internal bookkeeping ("subscribed", "mentioned", "head_ref_deleted"),
 * and rendering all of them buries the comments the thread is actually about.
 */
const TIMELINE_KINDS: Record<string, TimelineEventKind> = {
	labeled: 'labeled',
	unlabeled: 'unlabeled',
	assigned: 'assigned',
	unassigned: 'unassigned',
	renamed: 'renamed',
	referenced: 'referenced',
	cross_referenced: 'cross-referenced',
	closed: 'closed',
	reopened: 'reopened',
	merged: 'merged',
	review_requested: 'review-requested'
};

function toEvent(raw: GitHubTimelineEntry, index: number): WorkItemEvent | null {
	const kind = TIMELINE_KINDS[raw.event];
	if (!kind) return null;

	const reference = raw.source?.issue;
	return {
		// `id` is absent on some entries (cross-references carry only a node id),
		// so the index is the tiebreaker that keeps keys unique.
		id: String(raw.id ?? raw.node_id ?? `${raw.event}-${index}`),
		kind,
		actor: raw.actor?.login ?? null,
		createdAt: raw.created_at ?? '',
		...(raw.label && { subject: raw.label.name }),
		...(raw.assignee && { subject: raw.assignee.login }),
		...(raw.requested_reviewer && { subject: raw.requested_reviewer.login }),
		...(raw.rename && { subject: raw.rename.to }),
		...(reference && {
			referenceTitle: reference.title,
			referenceUrl: reference.html_url,
			referenceIdentifier: String(reference.number)
		})
	};
}

// ---------------------------------------------------------------------------
// Remote-URL parsing
// ---------------------------------------------------------------------------

/**
 * Host of the instance these credentials talk to.
 *
 * Enterprise Server is why this is derived rather than hardcoded: the same
 * adapter serves `github.com` and `ghe.internal`, and the only thing that
 * distinguishes "this remote is mine" is the host the account points at.
 */
function hostOf(credentials: GitHubCredentials): string {
	const base = webBaseOf(credentials);
	try {
		return new URL(base).host.toLowerCase();
	} catch {
		return new URL(GITHUB_WEB_BASE).host;
	}
}

function locatorFromRemote(url: string, credentials: Record<string, string>): string | null {
	const trimmed = (url ?? '').trim();
	if (!trimmed) return null;
	const host = hostOf({ token: '', baseUrl: credentials.baseUrl });

	// scp-style: git@host:owner/repo.git
	const scp = trimmed.match(/^[\w.-]+@([^:]+):(.+?)(?:\.git)?\/?$/);
	if (scp) {
		return scp[1].toLowerCase() === host ? normaliseLocator(scp[2]) : null;
	}

	try {
		const parsed = new URL(trimmed);
		if (parsed.host.toLowerCase() !== host) return null;
		return normaliseLocator(parsed.pathname.replace(/^\/+/, '').replace(/\.git$/, ''));
	} catch {
		return null;
	}
}

/** `owner/repo` and nothing else — a deeper path is a URL to a file, not a repo. */
function normaliseLocator(path: string): string | null {
	const parts = path.replace(/\.git$/, '').split('/').filter(Boolean);
	if (parts.length < 2) return null;
	return `${parts[0]}/${parts[1]}`;
}

// ---------------------------------------------------------------------------
// Diagnosing repository access
// ---------------------------------------------------------------------------

/**
 * Turn "Not Found" into something the user can act on.
 *
 * GitHub answers 404 for a repository that does not exist AND for one the token
 * is not permitted to see — it will not confirm a private repository exists. So
 * the bare message ("the repository does not exist, or the token cannot see
 * it") is true and useless, and it is the message a collaborator on someone
 * else's repository hits every single time.
 *
 * The reason is almost never that the repository is missing. It is that a
 * FINE-GRAINED token is scoped to one resource owner:
 *
 *   - repositories owned by another PERSON are unreachable, full stop — being a
 *     collaborator does not help, because the token was never granted by that
 *     owner;
 *   - repositories owned by an ORGANISATION are unreachable until an owner
 *     approves the token, and organisations that have not opted into
 *     fine-grained tokens at all can never approve one.
 *
 * A classic token with `repo` has neither limit, which is why it is the
 * recommendation here rather than a footnote.
 */
function explainRepoFailure(
	error: unknown,
	credentials: GitHubCredentials,
	locator: string
): unknown {
	if (!(error instanceof GitHubError) || error.kind !== 'config') return error;

	const owner = locator.split('/')[0] ?? 'the owner';
	const kind = tokenKindOf(credentials.token);

	if (kind === 'fine-grained') {
		return new GitHubError(
			`${locator} is not reachable with this fine-grained token. Fine-grained tokens only see repositories their resource owner granted: if ${owner} is an organisation, an owner must approve this token under its Settings → Personal access tokens; if ${owner} is another person, fine-grained tokens cannot reach their repositories at all, even as a collaborator. Replace it with a CLASSIC token carrying the "repo" scope — that is what Clopen recommends, and it reaches everything you can reach.`,
			error.status,
			'config'
		);
	}

	if (kind === 'classic') {
		return new GitHubError(
			`${locator} is not reachable with this token. A classic token needs the "repo" scope to see private repositories, and if ${owner} enforces SAML single sign-on the token has to be authorised for that organisation on your token settings page.`,
			error.status,
			'config'
		);
	}

	return new GitHubError(
		`${locator} is not reachable with this token. Check that it grants access to ${owner} and carries repository read permission.`,
		error.status,
		'config'
	);
}

/** Run a repository-scoped call, replacing an access failure with a reason. */
async function onRepo<T>(context: WorkContext, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		throw explainRepoFailure(error, credentialsOf(context), context.binding.locator);
	}
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Who the token belongs to.
 *
 * Needed for the "assigned to me" filter, and free in practice: the response is
 * ETag-cached, so every call after the first is a 304 that GitHub does not
 * charge against the rate limit.
 */
async function viewerLogin(credentials: GitHubCredentials): Promise<string> {
	const response = await githubRequest<GitHubUser>(credentials, '/user');
	return response.data?.login ?? '';
}

/** The repository record. ETag-cached, so repeated reads cost nothing. */
async function repoInfo(credentials: GitHubCredentials, locator: string): Promise<GitHubRepo | null> {
	try {
		const response = await githubRequest<GitHubRepo>(credentials, `/repos/${locator}`);
		return response.data ?? null;
	} catch {
		// A failure here only costs a capability, never the page: the caller
		// falls back to "no write access, all merge methods offered".
		return null;
	}
}

function canWriteTo(repo: GitHubRepo | null): boolean {
	return repo?.permissions?.push === true || repo?.permissions?.admin === true;
}

/** One page. Load-more asks for the next; the list appends rather than replaces. */
const PAGE_SIZE = 50;

/**
 * Keep pulling provider pages until the FILTERED page is full.
 *
 * Both endpoints hand back rows that this surface then discards — `/issues`
 * returns pull requests (they are issues in GitHub's data model, and showing
 * them here would duplicate the pull-request tab), and `/pulls` has no
 * people or label parameters so those are applied locally. Taking one provider
 * page and filtering it means the user sees however many happened to survive.
 *
 * That is not a hypothetical: on a busy repository with `state=all`, the fifty
 * most recently updated items are almost all closed pull requests, so the
 * issues list rendered a single row and looked broken.
 *
 * Bounded at `MAX_FETCH_PAGES` so a repository where nothing matches cannot
 * spend the whole rate limit looking.
 */
const MAX_FETCH_PAGES = 5;

/**
 * The budget when a date range is set.
 *
 * Both listings are sorted newest-first and neither takes an end date, so
 * everything updated after the range has to be paged PAST before the range is
 * reached. Five pages is 250 items — on an active repository that is a few
 * days of activity, and any range older than that came back empty no matter
 * how many items matched. Twenty pages is the reach; `pastEnd` below is what
 * keeps a range that has already been passed from spending it.
 */
const MAX_RANGE_PAGES = 20;

/**
 * A date the user picked, as the instant their day starts and ends.
 *
 * The picker hands over `2026-09-11`, which parses as midnight UTC — not
 * midnight where the user is. Reading it literally shifted the window by the
 * timezone offset at both ends, so items from the first hours of the range
 * were outside it and items from the last hours were inside the next day.
 */
function startOfDay(date: string): string {
	const value = new Date(date);
	value.setHours(0, 0, 0, 0);
	return value.toISOString();
}

function endOfDay(date: string): string {
	const value = new Date(date);
	value.setHours(23, 59, 59, 999);
	return value.toISOString();
}

async function fillPage(
	credentials: GitHubCredentials,
	buildUrl: (page: number) => string,
	keep: (raw: GitHubIssue) => boolean,
	kind: WorkItemKind,
	startPage: number,
	/**
	 * True once a row proves no later page can match.
	 *
	 * Every listing here is sorted by update time, newest first, so a row older
	 * than the range's start means the rest of the history is older still.
	 * Without it, a range that ended weeks ago would spend its whole budget
	 * walking backwards through history it has already left behind.
	 */
	pastEnd?: (raw: GitHubIssue) => boolean,
	maxPages = MAX_FETCH_PAGES
): Promise<WorkItemPage> {
	const items: WorkItem[] = [];
	let rateLimit: WorkRateLimit | null = null;
	let page = startPage;
	let hasMore = false;

	for (let fetched = 0; fetched < maxPages; fetched += 1) {
		const response = await githubRequest<GitHubIssue[]>(credentials, buildUrl(page));
		rateLimit = response.rateLimit ?? rateLimit;

		const rows = response.data ?? [];
		items.push(...rows.filter(keep).map((raw) => toWorkItem(raw, kind)));

		hasMore = response.nextUrl !== null;
		if (pastEnd && rows.some(pastEnd)) {
			hasMore = false;
			break;
		}
		if (!hasMore || items.length >= PAGE_SIZE) break;
		page += 1;
	}

	// The NEXT call must resume after the last page actually consumed, or
	// load-more would re-request pages this one already drained.
	return { items, rateLimit, hasMore, nextPage: hasMore ? page + 1 : null };
}

async function listIssues(
	credentials: GitHubCredentials,
	locator: string,
	query: WorkItemQuery
): Promise<WorkItemPage> {
	const base = new URLSearchParams({
		state: query.state,
		per_page: String(PAGE_SIZE),
		sort: 'updated',
		direction: 'desc'
	});

	// Pushed to the provider where it supports them, because filtering server
	// side is the difference between "the first 50 items, then filtered" and
	// "the first 50 matching items".
	if (query.mineOnly) base.set('assignee', await viewerLogin(credentials));
	if (query.author) base.set('creator', query.author);
	if (query.labels?.length) base.set('labels', query.labels.join(','));
	const since = query.since ? startOfDay(query.since) : null;
	if (since) base.set('since', since);

	// `until` has no provider-side equivalent, so it is applied HERE rather than
	// to the finished page. Applied afterwards it read as "of the fifty most
	// recently updated items, show the ones older than this date" — which for
	// any range not ending today is none of them, and the list came back empty
	// with matching items sitting on page two.
	const until = query.until ? endOfDay(query.until) : null;

	return fillPage(
		credentials,
		(page) => `/repos/${locator}/issues?${base.toString()}&page=${page}`,
		(raw) => !raw.pull_request && (!until || raw.updated_at <= until),
		'issue',
		query.page ?? 1,
		since ? (raw) => raw.updated_at < since : undefined,
		until ? MAX_RANGE_PAGES : MAX_FETCH_PAGES
	);
}

async function listPulls(
	credentials: GitHubCredentials,
	locator: string,
	query: WorkItemQuery
): Promise<WorkItemPage> {
	const params = new URLSearchParams({
		state: query.state,
		per_page: String(PAGE_SIZE),
		sort: 'updated',
		direction: 'desc'
	});

	// The pulls endpoint takes none of the people, label or date parameters, so
	// all of those are applied here — which is why this goes through the same
	// fill loop, and why the loop keeps fetching until it has a full page of
	// MATCHES rather than a page it then filters down to nothing.
	const login = query.mineOnly ? await viewerLogin(credentials) : '';
	const since = query.since ? startOfDay(query.since) : null;
	const until = query.until ? endOfDay(query.until) : null;

	return fillPage(
		credentials,
		(page) => `/repos/${locator}/pulls?${params.toString()}&page=${page}`,
		(raw) => {
			if (query.mineOnly) {
				const mine = (raw.assignees ?? []).some((user) => user.login === login)
					|| raw.user?.login === login;
				if (!mine) return false;
			}
			if (query.author && raw.user?.login !== query.author) return false;
			if (query.labels?.length) {
				const names = labelNames(raw.labels);
				if (!query.labels.every((label) => names.includes(label))) return false;
			}
			if (since && raw.updated_at < since) return false;
			if (until && raw.updated_at > until) return false;
			return true;
		},
		'pull-request',
		query.page ?? 1,
		since ? (raw) => raw.updated_at < since : undefined,
		until ? MAX_RANGE_PAGES : MAX_FETCH_PAGES
	);
}

function matchesSearch(item: WorkItem, needle: string): boolean {
	if (!needle) return true;
	const haystack = [item.identifier, item.title, ...item.labels, ...item.assignees, item.author ?? '']
		.join(' ')
		.toLowerCase();
	return haystack.includes(needle);
}

export const githubWorkAdapter: WorkProviderAdapter = {
	provider: 'github',
	capabilities: CAPABILITIES,
	locatorFromRemote,

	describeLocator(locator: string): string {
		return locator;
	},

	async probe(context: UnboundContext, binding: ResolvedBinding | null) {
		const credentials = credentialsOf(context);
		if (!credentials.token) {
			return { status: 'needs_config' as const, detail: 'No token stored' };
		}

		try {
			const login = await viewerLogin(credentials);
			if (!binding) {
				// A valid token with nowhere to point is a real, reportable state:
				// the account works, the project has not been bound to a repo yet.
				return { status: 'needs_config' as const, detail: `Signed in as ${login}. No repository selected yet.` };
			}

			try {
				await githubRequest(credentials, `/repos/${binding.locator}`);
			} catch (error) {
				throw explainRepoFailure(error, credentials, binding.locator);
			}
			return { status: 'ok' as const, detail: `${login} → ${binding.locator}` };
		} catch (error) {
			if (error instanceof GitHubError) {
				const status = error.kind === 'auth' ? 'needs_auth' as const
					: error.kind === 'config' ? 'needs_config' as const
					: 'error' as const;
				return { status, detail: error.message };
			}
			return { status: 'error' as const, detail: error instanceof Error ? error.message : String(error) };
		}
	},

	async listStates(_context: WorkContext, kind: WorkItemKind): Promise<WorkItemStateOption[]> {
		// Static, because GitHub's states are. A tracker with a real workflow
		// fetches them; this one would be lying if it pretended to.
		if (kind === 'pull-request') {
			return [
				{ value: 'open', label: 'Open', category: 'open' },
				{ value: 'closed', label: 'Closed', category: 'closed' }
			];
		}
		return [
			{ value: 'open', label: 'Open', category: 'open' },
			{ value: 'closed', label: 'Closed as completed', category: 'closed' },
			{ value: 'not_planned', label: 'Closed as not planned', category: 'closed' }
		];
	},

	async list(context: WorkContext, query: WorkItemQuery): Promise<WorkItemPage> {
		const credentials = credentialsOf(context);
		const locator = context.binding.locator;
		const page = await onRepo(context, () => query.kind === 'pull-request'
			? listPulls(credentials, locator, query)
			: listIssues(credentials, locator, query));

		// Search is applied locally against the page we already hold. Going to
		// GitHub's search API instead would cost a separate, much smaller rate
		// limit (30/min) and return a different, less complete object shape.
		const needle = (query.search ?? '').trim().toLowerCase();
		return {
			items: page.items.filter((item) => matchesSearch(item, needle)),
			rateLimit: page.rateLimit,
			hasMore: page.hasMore,
			nextPage: page.nextPage
		};
	},

	async get(context: WorkContext, kind: WorkItemKind, id: string): Promise<WorkItemDetail> {
		const credentials = credentialsOf(context);
		const locator = context.binding.locator;

		// The issues endpoint serves both kinds, but only the pulls endpoint
		// carries head/base/draft/merged — so a PR is fetched from both.
		const issue = await onRepo(context, () =>
			githubRequest<GitHubIssue>(credentials, `/repos/${locator}/issues/${id}`));
		let raw = issue.data;

		if (kind === 'pull-request') {
			const pull = await githubRequest<GitHubIssue>(credentials, `/repos/${locator}/pulls/${id}`);
			raw = { ...raw, ...pull.data, comments: raw.comments };
		}

		// Who we are and what we may do here, resolved once so every comment can
		// be told whether its edit and delete controls should exist.
		const [viewer, repo] = await Promise.all([
			viewerLogin(credentials).catch(() => ''),
			repoInfo(credentials, locator)
		]);
		const canWrite = canWriteTo(repo);

		const conversation = await githubPaged<GitHubComment>(
			credentials,
			`/repos/${locator}/issues/${id}/comments?per_page=100`,
			3
		);

		const comments = conversation.items.map((entry) =>
			toComment(entry, 'conversation', viewer || null, canWrite));

		if (kind === 'pull-request') {
			// A pull request's discussion is spread over THREE endpoints, and
			// missing any of them makes Clopen's thread disagree with the
			// provider's own. `/issues/{n}/comments` is the conversation,
			// `/pulls/{n}/comments` is line-level review feedback, and
			// `/pulls/{n}/reviews` is the summary a reviewer submits — which is
			// where review bots put their findings. Reading only the first two is
			// what made a bot's review look like it had been deleted.
			const [review, reviews] = await Promise.all([
				githubPaged<GitHubComment>(
					credentials,
					`/repos/${locator}/pulls/${id}/comments?per_page=100`,
					3
				),
				githubPaged<GitHubReview>(
					credentials,
					`/repos/${locator}/pulls/${id}/reviews?per_page=100`,
					2
				)
			]);

			comments.push(...review.items.map((entry) =>
				toComment(entry, 'review', viewer || null, canWrite)));

			comments.push(
				...reviews.items
					// A review with no body is just the act of approving; its
					// line comments already arrived above.
					.filter((entry) => (entry.body ?? '').trim().length > 0)
					.map((entry) => toComment(
						{
							id: entry.id,
							body: entry.body,
							user: entry.user,
							created_at: entry.submitted_at ?? '',
							html_url: entry.html_url
						},
						'review-summary',
						viewer || null,
						canWrite
					))
			);
		}

		comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

		// Best effort: the timeline is a preview-era media type on some
		// installs and a missing history is a poorer page, not a broken one.
		const timeline = await githubPaged<GitHubTimelineEntry>(
			credentials,
			`/repos/${locator}/issues/${id}/timeline?per_page=100`,
			2
		).catch(() => ({ items: [] as GitHubTimelineEntry[], rateLimit: null }));

		const events = timeline.items
			.map((entry, index) => toEvent(entry, index))
			.filter((entry): entry is WorkItemEvent => entry !== null)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

		return {
			...toWorkItem(raw, kind),
			body: raw.body ?? '',
			comments,
			events,
			...(kind === 'pull-request' && { mergeability: toMergeability(raw, repo) })
		};
	},

	async comment(context: WorkContext, _kind: WorkItemKind, id: string, body: string): Promise<WorkItemComment> {
		const credentials = credentialsOf(context);
		const response = await onRepo(context, () => githubRequest<GitHubComment>(
			credentials,
			`/repos/${context.binding.locator}/issues/${id}/comments`,
			{ method: 'POST', body: { body } }
		));
		// The list we just changed is cached by ETag; without this the panel
		// would refresh into a 304 and appear to have dropped the comment.
		invalidateGitHubCache(credentials.token);
		// The comment we just wrote is ours, so it is editable by definition.
		return toComment(response.data, 'conversation', response.data?.user?.login ?? null, true);
	},

	async transition(context: WorkContext, _kind: WorkItemKind, id: string, state: string): Promise<void> {
		const credentials = credentialsOf(context);
		// `not_planned` is not a state, it is a reason attached to `closed`.
		// Flattening the two into one selectable value is what keeps the panel
		// from needing a GitHub-shaped second dropdown.
		const body = state === 'not_planned'
			? { state: 'closed', state_reason: 'not_planned' }
			: state === 'closed'
				? { state: 'closed', state_reason: 'completed' }
				: { state: 'open' };

		await onRepo(context, () =>
			githubRequest(credentials, `/repos/${context.binding.locator}/issues/${id}`, {
				method: 'PATCH',
				body
			}));
		invalidateGitHubCache(credentials.token);
	},

	async defaultBranch(context: WorkContext): Promise<string> {
		const response = await onRepo(context, () => githubRequest<{ default_branch?: string }>(
			credentialsOf(context),
			`/repos/${context.binding.locator}`
		));
		return response.data?.default_branch || 'main';
	},

	async listChecks(context: WorkContext, branch: string): Promise<CheckRun[]> {
		const params = new URLSearchParams({ branch, per_page: '20' });
		const response = await onRepo(context, () => githubRequest<{ workflow_runs: GitHubRun[] }>(
			credentialsOf(context),
			`/repos/${context.binding.locator}/actions/runs?${params.toString()}`
		));
		return (response.data?.workflow_runs ?? []).map(toCheckRun);
	},

	async fetchCheckLogs(context: WorkContext, runId: string): Promise<CheckLogBundle> {
		const credentials = credentialsOf(context);
		const run = await githubRequest<GitHubRun>(
			credentials,
			`/repos/${context.binding.locator}/actions/runs/${runId}`
		);
		const name = run.data?.name || run.data?.display_title || `Run ${runId}`;
		return buildRunLogBundle(credentials, context.binding.locator, runId, name);
	},

	async createPullRequest(context: WorkContext, draft: PullRequestDraft): Promise<WorkItem> {
		const credentials = credentialsOf(context);
		const response = await onRepo(context, () => githubRequest<GitHubIssue>(
			credentials,
			`/repos/${context.binding.locator}/pulls`,
			{
				method: 'POST',
				body: {
					title: draft.title,
					body: draft.body,
					base: draft.base,
					head: draft.head,
					draft: draft.isDraft
				}
			}
		));
		invalidateGitHubCache(credentials.token);
		return toWorkItem(response.data, 'pull-request');
	},

	async updateItem(
		context: WorkContext,
		_kind: WorkItemKind,
		id: string,
		patch: { title?: string; body?: string }
	): Promise<void> {
		const credentials = credentialsOf(context);
		await onRepo(context, () => githubRequest(
			credentials,
			`/repos/${context.binding.locator}/issues/${id}`,
			{ method: 'PATCH', body: patch }
		));
		invalidateGitHubCache(credentials.token);
	},

	async listLabels(context: WorkContext): Promise<string[]> {
		const result = await onRepo(context, () => githubPaged<{ name: string }>(
			credentialsOf(context),
			`/repos/${context.binding.locator}/labels?per_page=100`,
			2
		));
		return result.items.map((label) => label.name);
	},

	async viewer(context: UnboundContext): Promise<string | null> {
		try {
			return (await viewerLogin(credentialsOf(context))) || null;
		} catch {
			return null;
		}
	},

	async updateComment(
		context: WorkContext,
		comment: { id: string; source: 'conversation' | 'review' },
		body: string
	): Promise<WorkItemComment> {
		const credentials = credentialsOf(context);
		// The two comment kinds live on different paths, and PATCHing a review
		// comment through the issues path is a 404 rather than a clear refusal.
		const path = comment.source === 'review'
			? `/repos/${context.binding.locator}/pulls/comments/${comment.id}`
			: `/repos/${context.binding.locator}/issues/comments/${comment.id}`;

		const response = await onRepo(context, () =>
			githubRequest<GitHubComment>(credentials, path, { method: 'PATCH', body: { body } }));
		invalidateGitHubCache(credentials.token);
		return toComment(response.data, comment.source, response.data?.user?.login ?? null, true);
	},

	async deleteComment(
		context: WorkContext,
		comment: { id: string; source: 'conversation' | 'review' }
	): Promise<void> {
		const credentials = credentialsOf(context);
		const path = comment.source === 'review'
			? `/repos/${context.binding.locator}/pulls/comments/${comment.id}`
			: `/repos/${context.binding.locator}/issues/comments/${comment.id}`;

		await onRepo(context, () => githubRequest(credentials, path, { method: 'DELETE' }));
		invalidateGitHubCache(credentials.token);
	},

	async mergePullRequest(
		context: WorkContext,
		id: string,
		options: { method: MergeMethod; title?: string; message?: string }
	): Promise<void> {
		const credentials = credentialsOf(context);
		await onRepo(context, () => githubRequest(
			credentials,
			`/repos/${context.binding.locator}/pulls/${id}/merge`,
			{
				method: 'PUT',
				body: {
					merge_method: options.method,
					...(options.title && { commit_title: options.title }),
					...(options.message && { commit_message: options.message })
				}
			}
		));
		invalidateGitHubCache(credentials.token);
	},

	async listCommits(context: WorkContext, id: string): Promise<CommitRef[]> {
		const result = await onRepo(context, () => githubPaged<GitHubCommit>(
			credentialsOf(context),
			`/repos/${context.binding.locator}/pulls/${id}/commits?per_page=100`,
			2
		));
		// Newest first, matching how the list and the log everywhere else read.
		return result.items.map(toCommit).reverse();
	},

	async listFiles(context: WorkContext, id: string): Promise<FileChange[]> {
		const result = await onRepo(context, () => githubPaged<GitHubFile>(
			credentialsOf(context),
			`/repos/${context.binding.locator}/pulls/${id}/files?per_page=100`,
			3
		));
		return result.items.map(toFileChange);
	},

	/**
	 * One file's full text.
	 *
	 * A diff shows what changed and hides what it changed WITHIN, which is
	 * usually the question a reviewer has next.
	 *
	 * Read by BLOB ID when the caller has one, and only fall back to path + ref
	 * when it does not. The contents endpoint resolves a path inside a named
	 * ref of THIS repository, and three ordinary situations have no such ref:
	 * a pull request from a fork (the branch lives in the fork), a merged pull
	 * request (the branch is usually deleted), and a file the pull request
	 * deleted (the path is gone from the head). All three answered 404, which
	 * the panel reported as the repository being unreachable — a message about
	 * token scopes for something that was never a permission problem. A blob id
	 * is reachable from the base repository in every one of those cases,
	 * because a pull request's objects are fetched into it.
	 *
	 * Capped either way: the endpoint will happily return a 5 MB minified
	 * bundle.
	 */
	async fetchFileContent(
		context: WorkContext,
		path: string,
		ref: string,
		blobSha?: string
	): Promise<FileContent> {
		const credentials = credentialsOf(context);
		const locator = context.binding.locator;

		const read = async (endpoint: string): Promise<FileContent> => {
			const response = await githubRequest<{ content?: string; encoding?: string; size?: number }>(
				credentials,
				endpoint
			);
			const data = response.data;
			if ((data?.size ?? 0) > MAX_FILE_BYTES) {
				throw new Error('That file is too large to download. Open it on the web instead.');
			}
			if (!data?.content || data.encoding !== 'base64') {
				throw new Error('That file has no readable text — it may be binary or too large.');
			}

			const bytes = Buffer.from(data.content, 'base64');
			if (bytes.byteLength <= MAX_RENDER_BYTES) {
				return { content: bytes.toString('utf8'), truncated: false };
			}
			// Cut on a byte boundary and drop the last line, which the cut may
			// have left as half a multi-byte character or half a statement.
			const head = bytes.subarray(0, MAX_RENDER_BYTES).toString('utf8');
			return { content: head.slice(0, head.lastIndexOf('\n') + 1 || head.length), truncated: true };
		};

		if (blobSha) {
			try {
				return await read(`/repos/${locator}/git/blobs/${encodeURIComponent(blobSha)}`);
			} catch (error) {
				// A blob id the base repository has never heard of is the one case
				// worth a second attempt; anything else (too large, binary) would
				// fail the same way twice.
				debug.warn('work', `Blob ${blobSha.slice(0, 7)} unreadable, falling back to ${ref}:`, error);
			}
		}

		return onRepo(context, () => read(
			`/repos/${locator}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`
		));
	},

	/**
	 * One commit, with the rest of its message and everything it touched.
	 *
	 * The list endpoint carries neither, so a commit list without this is a row
	 * of subjects and a large empty pane — which is what it was.
	 */
	async commitDetail(context: WorkContext, sha: string): Promise<CommitDetail> {
		const response = await onRepo(context, () => githubRequest<GitHubCommit>(
			credentialsOf(context),
			`/repos/${context.binding.locator}/commits/${encodeURIComponent(sha)}`
		));

		const raw = response.data;
		const message = raw.commit?.message ?? '';
		return {
			commit: toCommit(raw),
			body: message.split('\n').slice(1).join('\n').trim(),
			additions: raw.stats?.additions ?? 0,
			deletions: raw.stats?.deletions ?? 0,
			files: (raw.files ?? []).map(toFileChange)
		};
	},

	async listAssignees(context: WorkContext): Promise<string[]> {
		const result = await onRepo(context, () => githubPaged<GitHubUser>(
			credentialsOf(context),
			`/repos/${context.binding.locator}/assignees?per_page=100`,
			2
		));
		return result.items.map((user) => user.login);
	},

	async setAssignees(
		context: WorkContext,
		_kind: WorkItemKind,
		id: string,
		logins: string[]
	): Promise<void> {
		const credentials = credentialsOf(context);
		// PATCH replaces the whole set, which is what the picker means: the two
		// add/remove endpoints would need a diff and would race a concurrent edit.
		await onRepo(context, () => githubRequest(
			credentials,
			`/repos/${context.binding.locator}/issues/${id}`,
			{ method: 'PATCH', body: { assignees: logins } }
		));
		invalidateGitHubCache(credentials.token);
	},

	async createIssue(
		context: WorkContext,
		draft: { title: string; body: string; assignees: string[]; labels: string[] }
	): Promise<WorkItem> {
		const credentials = credentialsOf(context);
		const response = await onRepo(context, () => githubRequest<GitHubIssue>(
			credentials,
			`/repos/${context.binding.locator}/issues`,
			{
				method: 'POST',
				body: {
					title: draft.title,
					body: draft.body,
					...(draft.assignees.length > 0 && { assignees: draft.assignees }),
					...(draft.labels.length > 0 && { labels: draft.labels })
				}
			}
		));
		invalidateGitHubCache(credentials.token);
		return toWorkItem(response.data, 'issue');
	},

	async findPullRequestForBranch(context: WorkContext, branch: string): Promise<WorkItem | null> {
		const credentials = credentialsOf(context);
		const owner = context.binding.locator.split('/')[0];
		// `head` is qualified with the owner because a fork's branch can share a
		// name with one in the base repo, and an unqualified match returns both.
		const params = new URLSearchParams({ head: `${owner}:${branch}`, state: 'open', per_page: '5' });
		const response = await githubRequest<GitHubIssue[]>(
			credentials,
			`/repos/${context.binding.locator}/pulls?${params.toString()}`,
			{ noCache: true }
		);
		const found = (response.data ?? [])[0];
		return found ? toWorkItem(found, 'pull-request') : null;
	}
};
