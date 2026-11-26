/**
 * GitLab, behind the provider-agnostic work interface.
 *
 * What GitLab does differently, absorbed here so the panel never learns it:
 *
 *  - Pull requests are MERGE REQUESTS, numbered per project by `iid`, and an
 *    issue and a merge request each have their own number space.
 *  - The discussion is NOTES. System notes ("added ~bug label") are the
 *    timeline, so they become events rather than comments.
 *  - A note is addressed through the item it belongs to, while the interface
 *    hands an edit only the comment. So a comment id carries its item:
 *    `issue:12:3456` — opaque to the panel, enough for the adapter.
 *  - Assignees are set by USER ID, so logins are resolved first.
 *  - CI is PIPELINES, and a pipeline's logs are its failed jobs' traces.
 */

import type {
	CheckLogBundle,
	CheckRun,
	CheckStatus,
	CommitDetail,
	CommitRef,
	FileChange,
	FileContent,
	MergeMethod,
	PullRequestDraft,
	PullRequestMergeability,
	TimelineEventKind,
	WorkItem,
	WorkItemComment,
	WorkItemDetail,
	WorkItemEvent,
	WorkItemKind,
	WorkItemPage,
	WorkItemQuery,
	WorkItemStateOption,
	WorkProviderCapabilities,
	WorkRateLimit
} from '$shared/types/work';
import type { ResolvedBinding, UnboundContext, WorkContext, WorkProviderAdapter } from '../../types';
import { HostApiError } from '$backend/git-hosts/http';
import { gitlabHost } from '$backend/git-hosts/providers/gitlab';
import { gitlabPaged, gitlabRequest, gitlabWebBase, projectRef } from '$backend/git-hosts/providers/gitlab-client';
import { keepTail } from '../github/actions-logs';
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
	labels: true,
	reviewers: true,
	diff: true
};

const PAGE_SIZE = 50;
const MAX_PATCH_BYTES = 60 * 1024;
const MAX_RENDER_BYTES = 2 * 1024 * 1024;
const TOTAL_LOG_BUDGET = 24 * 1024;
const PER_JOB_BUDGET = 12 * 1024;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

interface GitLabUser { id: number; username: string }

interface GitLabItemWire {
	id: number;
	iid: number;
	title: string;
	description: string | null;
	web_url: string;
	state: 'opened' | 'closed' | 'merged' | 'locked';
	labels: string[];
	assignees?: GitLabUser[];
	reviewers?: GitLabUser[];
	author: GitLabUser | null;
	user_notes_count?: number;
	created_at: string;
	updated_at: string;
	// merge requests
	draft?: boolean;
	work_in_progress?: boolean;
	source_branch?: string;
	target_branch?: string;
	sha?: string;
	merge_status?: string;
	detailed_merge_status?: string;
	has_conflicts?: boolean;
	squash_on_merge?: boolean;
}

interface GitLabNoteWire {
	id: number;
	body: string;
	author: GitLabUser;
	created_at: string;
	system: boolean;
	type: string | null;
	position?: { new_path?: string; old_path?: string; new_line?: number | null; old_line?: number | null } | null;
}

interface GitLabPipelineWire {
	id: number;
	status: string;
	ref: string;
	sha: string;
	source?: string;
	web_url: string;
	created_at: string;
	updated_at: string;
	started_at?: string | null;
	finished_at?: string | null;
	name?: string | null;
}

interface GitLabDiffWire {
	old_path: string;
	new_path: string;
	diff: string;
	new_file: boolean;
	renamed_file: boolean;
	deleted_file: boolean;
}

interface GitLabCommitWire {
	id: string;
	short_id: string;
	title: string;
	message?: string;
	author_name: string | null;
	created_at: string;
	committed_date?: string;
	web_url: string;
	stats?: { additions: number; deletions: number };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function itemsPath(kind: WorkItemKind): string {
	return kind === 'pull-request' ? 'merge_requests' : 'issues';
}

function categorise(raw: GitLabItemWire, kind: WorkItemKind): WorkItem['stateCategory'] {
	if (raw.state === 'merged') return 'merged';
	if (raw.state === 'closed' || raw.state === 'locked') return 'closed';
	if (kind === 'pull-request' && (raw.draft || raw.work_in_progress)) return 'draft';
	return 'open';
}

function stateName(raw: GitLabItemWire, kind: WorkItemKind): string {
	if (raw.state === 'opened') return kind === 'pull-request' && (raw.draft || raw.work_in_progress) ? 'draft' : 'open';
	return raw.state;
}

function toWorkItem(raw: GitLabItemWire, kind: WorkItemKind): WorkItem {
	return {
		id: String(raw.iid),
		identifier: String(raw.iid),
		kind,
		title: raw.title,
		url: raw.web_url,
		state: stateName(raw, kind),
		stateCategory: categorise(raw, kind),
		labels: raw.labels ?? [],
		assignees: (raw.assignees ?? []).map((user) => user.username),
		author: raw.author?.username ?? null,
		commentCount: raw.user_notes_count ?? 0,
		createdAt: raw.created_at,
		updatedAt: raw.updated_at,
		...(kind === 'pull-request' && {
			headBranch: raw.source_branch,
			...(raw.sha && { headSha: raw.sha }),
			baseBranch: raw.target_branch,
			isDraft: raw.draft === true || raw.work_in_progress === true,
			...(raw.reviewers && { reviewers: raw.reviewers.map((user) => user.username) })
		})
	};
}

/** `kind:iid:noteId` — the item a note belongs to travels with it. */
function commentId(kind: WorkItemKind, iid: string, noteId: number): string {
	return `${kind === 'pull-request' ? 'mr' : 'issue'}:${iid}:${noteId}`;
}

function parseCommentId(id: string): { path: string; iid: string; noteId: string } {
	const [kind, iid, noteId] = id.split(':');
	if (!kind || !iid || !noteId) throw new Error('That comment cannot be addressed');
	return { path: kind === 'mr' ? 'merge_requests' : 'issues', iid, noteId };
}

function toComment(raw: GitLabNoteWire, kind: WorkItemKind, iid: string, viewer: string | null): WorkItemComment {
	const path = raw.position?.new_path ?? raw.position?.old_path;
	return {
		id: commentId(kind, iid, raw.id),
		author: raw.author?.username ?? 'unknown',
		body: raw.body ?? '',
		createdAt: raw.created_at,
		source: raw.type === 'DiffNote' ? 'review' : 'conversation',
		// GitLab lets the author edit their note; deleting someone else's needs
		// a role the API does not report per note, so only the author is offered.
		canModify: viewer !== null && raw.author?.username === viewer,
		...(path && { path, line: raw.position?.new_line ?? raw.position?.old_line ?? null })
	};
}

/**
 * System notes are GitLab's timeline, written as sentences. The ones worth
 * drawing are recognised by their wording; the rest are dropped rather than
 * rendered as a vague "something happened".
 */
const SYSTEM_PATTERNS: { pattern: RegExp; kind: TimelineEventKind }[] = [
	{ pattern: /^added ~"?([^"~]+?)"? label/i, kind: 'labeled' },
	{ pattern: /^removed ~"?([^"~]+?)"? label/i, kind: 'unlabeled' },
	{ pattern: /^assigned to @(\S+)/i, kind: 'assigned' },
	{ pattern: /^unassigned @(\S+)/i, kind: 'unassigned' },
	{ pattern: /^changed title from .* to \*\*(.+)\*\*/i, kind: 'renamed' },
	{ pattern: /^requested review from @(\S+)/i, kind: 'review-requested' },
	{ pattern: /^mentioned in (.+)$/i, kind: 'cross-referenced' },
	{ pattern: /^closed$/i, kind: 'closed' },
	{ pattern: /^reopened$/i, kind: 'reopened' },
	{ pattern: /^merged$/i, kind: 'merged' }
];

export function systemNoteToEvent(raw: Pick<GitLabNoteWire, 'id' | 'body' | 'author' | 'created_at'>): WorkItemEvent | null {
	const body = (raw.body ?? '').trim();
	for (const { pattern, kind } of SYSTEM_PATTERNS) {
		const match = pattern.exec(body);
		if (!match) continue;
		return {
			id: String(raw.id),
			kind,
			actor: raw.author?.username ?? null,
			createdAt: raw.created_at,
			...(match[1] && kind !== 'cross-referenced' && { subject: match[1].replace(/\*\*/g, '') }),
			...(kind === 'cross-referenced' && match[1] && { referenceTitle: match[1] })
		};
	}
	return null;
}

function toCheckStatus(status: string): CheckStatus {
	switch (status) {
		case 'success':
			return 'success';
		case 'failed':
			return 'failure';
		case 'canceled':
		case 'canceling':
			return 'cancelled';
		case 'skipped':
			return 'skipped';
		case 'created':
		case 'pending':
		case 'waiting_for_resource':
		case 'waiting_for_callback':
		case 'preparing':
		case 'scheduled':
		case 'manual':
			return 'queued';
		case 'running':
			return 'running';
		default:
			return 'unknown';
	}
}

function toCheckRun(raw: GitLabPipelineWire): CheckRun {
	const status = toCheckStatus(raw.status);
	const finished = ['success', 'failure', 'cancelled', 'skipped'].includes(status);
	return {
		id: String(raw.id),
		name: raw.name || `Pipeline #${raw.id}`,
		status,
		url: raw.web_url,
		headBranch: raw.ref,
		headSha: raw.sha,
		event: raw.source ?? 'push',
		startedAt: raw.started_at ?? raw.created_at,
		finishedAt: finished ? (raw.finished_at ?? raw.updated_at) : null,
		canFetchLogs: status === 'failure'
	};
}

/** Lines added and removed in a GitLab hunk body, which carries no counts of its own. */
function countDiff(diff: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split('\n')) {
		if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
		else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
	}
	return { additions, deletions };
}

function toFileChange(raw: GitLabDiffWire, url: string): FileChange {
	const counts = countDiff(raw.diff ?? '');
	const status = raw.new_file ? 'added' : raw.deleted_file ? 'removed' : raw.renamed_file ? 'renamed' : 'modified';
	return {
		path: raw.new_path,
		status,
		additions: counts.additions,
		deletions: counts.deletions,
		...(raw.diff && raw.diff.length <= MAX_PATCH_BYTES && { patch: raw.diff }),
		url,
		...(raw.renamed_file && raw.old_path !== raw.new_path && { previousPath: raw.old_path })
	};
}

function toCommit(raw: GitLabCommitWire): CommitRef {
	return {
		hash: raw.short_id || raw.id.slice(0, 8),
		subject: raw.title,
		author: raw.author_name,
		date: raw.committed_date ?? raw.created_at,
		url: raw.web_url
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function project(context: WorkContext): string {
	return `/projects/${projectRef(context.binding.locator)}`;
}

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

async function viewerLogin(credentials: Record<string, string>): Promise<string> {
	const response = await gitlabRequest<{ username: string }>(credentials, '/user');
	return response.data.username;
}

/** Logins → user ids, the form GitLab's assignee fields take. Unknown logins are dropped. */
async function userIds(credentials: Record<string, string>, logins: string[]): Promise<number[]> {
	const ids = await Promise.all(logins.map(async (login) => {
		const response = await gitlabRequest<GitLabUser[]>(credentials, `/users?username=${encodeURIComponent(login)}`);
		return response.data?.[0]?.id ?? null;
	}));
	return ids.filter((id): id is number => id !== null);
}

function toHostError(error: unknown): unknown {
	return error instanceof HostApiError && error.kind === 'config'
		? new HostApiError(`${error.message} Check that the token has the "api" scope and the project is visible to it.`, error.status, 'config')
		: error;
}

async function onProject<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		throw toHostError(error);
	}
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

async function listPage(
	context: WorkContext,
	kind: WorkItemKind,
	query: WorkItemQuery,
	extra: Record<string, string>
): Promise<{ items: WorkItem[]; rateLimit: WorkRateLimit | null; nextPage: number | null }> {
	const params = new URLSearchParams({
		per_page: String(PAGE_SIZE),
		page: String(query.page ?? 1),
		order_by: 'updated_at',
		sort: 'desc',
		...extra
	});
	// `closed` here means "not open", which for a merge request includes merged —
	// the same as GitHub, where a merged PR is closed.
	if (query.state === 'open') params.set('state', 'opened');
	if (query.author) params.set('author_username', query.author);
	if (query.labels?.length) params.set('labels', query.labels.join(','));
	if (query.since) params.set('updated_after', startOfDay(query.since));
	if (query.until) params.set('updated_before', endOfDay(query.until));
	if (query.search?.trim()) params.set('search', query.search.trim());

	const response = await gitlabRequest<GitLabItemWire[]>(
		context.credentials,
		`${project(context)}/${itemsPath(kind)}?${params.toString()}`
	);
	let rows = response.data ?? [];
	if (query.state === 'closed') rows = rows.filter((row) => row.state !== 'opened');
	return { items: rows.map((row) => toWorkItem(row, kind)), rateLimit: response.rateLimit, nextPage: response.nextPage };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const gitlabWorkAdapter: WorkProviderAdapter = {
	provider: 'gitlab',
	capabilities: CAPABILITIES,

	locatorFromRemote(url, credentials) {
		const locator = gitlabHost.locatorFromRemote(url, credentials);
		// A web URL deeper than the project (`…/-/tree/main`) names a page, not a
		// project; everything from GitLab's `-` separator on is not part of it.
		return locator ? locator.split('/-/')[0]!.replace(/\/-$/, '') || null : null;
	},

	describeLocator: (locator) => locator,

	async probe(context: UnboundContext, binding: ResolvedBinding | null) {
		if (!context.credentials.token) return { status: 'needs_config' as const, detail: 'No token stored' };
		try {
			const login = await viewerLogin(context.credentials);
			if (!binding) {
				return { status: 'needs_config' as const, detail: `Signed in as ${login}. No project selected yet.` };
			}
			await gitlabRequest(context.credentials, `/projects/${projectRef(binding.locator)}`);
			return { status: 'ok' as const, detail: `${login} → ${binding.locator}` };
		} catch (error) {
			if (error instanceof HostApiError) {
				const status = error.kind === 'auth' ? 'needs_auth' as const
					: error.kind === 'config' ? 'needs_config' as const
						: 'error' as const;
				return { status, detail: error.message };
			}
			return { status: 'error' as const, detail: error instanceof Error ? error.message : String(error) };
		}
	},

	async listStates(): Promise<WorkItemStateOption[]> {
		return [
			{ value: 'open', label: 'Open', category: 'open' },
			{ value: 'closed', label: 'Closed', category: 'closed' }
		];
	},

	async list(context: WorkContext, query: WorkItemQuery): Promise<WorkItemPage> {
		return onProject(async () => {
			if (!query.mineOnly) {
				const page = await listPage(context, query.kind, query, { scope: 'all' });
				return { items: page.items, rateLimit: page.rateLimit, hasMore: page.nextPage !== null, nextPage: page.nextPage };
			}

			// "Mine" is assigned-to-me for an issue; for a merge request it is
			// also the ones I opened, which GitLab answers as a separate scope.
			const scopes = query.kind === 'pull-request' ? ['assigned_to_me', 'created_by_me'] : ['assigned_to_me'];
			const pages = await Promise.all(scopes.map((scope) => listPage(context, query.kind, query, { scope })));
			const seen = new Set<string>();
			const items = pages
				.flatMap((page) => page.items)
				.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
			const nextPage = pages.some((page) => page.nextPage !== null) ? (query.page ?? 1) + 1 : null;
			return { items, rateLimit: pages[0]?.rateLimit ?? null, hasMore: nextPage !== null, nextPage };
		});
	},

	async get(context: WorkContext, kind: WorkItemKind, id: string): Promise<WorkItemDetail> {
		return onProject(async () => {
			const base = `${project(context)}/${itemsPath(kind)}/${id}`;
			const [item, notes, viewer] = await Promise.all([
				gitlabRequest<GitLabItemWire>(context.credentials, base),
				gitlabPaged<GitLabNoteWire>(context.credentials, `${base}/notes?sort=asc&order_by=created_at`, 5),
				viewerLogin(context.credentials).catch(() => null)
			]);

			const comments: WorkItemComment[] = [];
			const events: WorkItemEvent[] = [];
			for (const note of notes) {
				if (note.system) {
					const event = systemNoteToEvent(note);
					if (event) events.push(event);
				} else {
					comments.push(toComment(note, kind, id, viewer));
				}
			}

			let mergeability: PullRequestMergeability | undefined;
			if (kind === 'pull-request') {
				const settings = await gitlabRequest<{ squash_option?: string; merge_method?: string }>(
					context.credentials,
					project(context)
				).catch(() => null);
				const allowed: MergeMethod[] = ['merge'];
				if (settings?.data.squash_option !== 'never') allowed.push('squash');
				const status = item.data.merge_status;
				mergeability = {
					mergeable: status === 'can_be_merged' ? true : status === 'cannot_be_merged' ? false : null,
					state: item.data.detailed_merge_status ?? status ?? 'unknown',
					allowedMethods: allowed,
					merged: item.data.state === 'merged'
				};
			}

			return {
				...toWorkItem(item.data, kind),
				body: item.data.description ?? '',
				comments,
				events,
				...(mergeability && { mergeability })
			};
		});
	},

	async comment(context, kind, id, body) {
		const response = await onProject(() => gitlabRequest<GitLabNoteWire>(
			context.credentials,
			`${project(context)}/${itemsPath(kind)}/${id}/notes`,
			{ method: 'POST', body: { body } }
		));
		return toComment(response.data, kind, id, response.data.author?.username ?? null);
	},

	async transition(context, kind, id, state) {
		await onProject(() => gitlabRequest(context.credentials, `${project(context)}/${itemsPath(kind)}/${id}`, {
			method: 'PUT',
			body: { state_event: state === 'open' ? 'reopen' : 'close' }
		}));
	},

	async defaultBranch(context) {
		const response = await onProject(() => gitlabRequest<{ default_branch?: string }>(context.credentials, project(context)));
		return response.data.default_branch || 'main';
	},

	async listChecks(context, branch) {
		const params = new URLSearchParams({ ref: branch, per_page: '20', order_by: 'id', sort: 'desc' });
		const response = await onProject(() => gitlabRequest<GitLabPipelineWire[]>(
			context.credentials,
			`${project(context)}/pipelines?${params.toString()}`
		));
		return (response.data ?? []).map(toCheckRun);
	},

	async fetchCheckLogs(context, runId): Promise<CheckLogBundle> {
		const runName = `Pipeline #${runId}`;
		const jobs = await onProject(() => gitlabRequest<{ id: number; name: string; stage: string; status: string }[]>(
			context.credentials,
			`${project(context)}/pipelines/${runId}/jobs?scope[]=failed&per_page=100`
		));
		const failed = jobs.data ?? [];
		if (failed.length === 0) {
			return {
				runId,
				runName,
				text: 'The pipeline reported a failure but no job failed — this is usually a cancelled or infrastructure-level failure.',
				truncated: false
			};
		}

		const sections: string[] = [];
		let used = 0;
		let truncated = false;
		for (const job of failed) {
			const header = `### Job "${job.name}" (stage ${job.stage}) — failed`;
			if (used >= TOTAL_LOG_BUDGET) {
				sections.push(`${header}\n(log omitted — the earlier jobs used the available context)`);
				truncated = true;
				continue;
			}
			let body: string;
			try {
				const trace = await gitlabRequest<string>(context.credentials, `${project(context)}/jobs/${job.id}/trace`, { text: true });
				// GitLab traces carry ANSI colour and section markers; both are
				// noise to a model and a large share of the bytes.
				const clean = trace.data
					.replace(/\u001b\[[0-9;]*m/g, '')
					.replace(/section_(start|end):\d+:[\w.-]+\r?/g, '')
					.trimEnd();
				const clipped = keepTail(clean, Math.min(PER_JOB_BUDGET, TOTAL_LOG_BUDGET - used));
				if (clipped.truncated) truncated = true;
				body = clipped.text;
				used += clipped.text.length;
			} catch (error) {
				debug.warn('work', `Could not read the trace for GitLab job ${job.id}:`, error);
				body = `(log unavailable: ${error instanceof Error ? error.message : String(error)})`;
			}
			sections.push(`${header}\n\n\`\`\`\n${body}\n\`\`\``);
		}
		return { runId, runName, text: sections.join('\n\n'), truncated };
	},

	async createPullRequest(context, draft: PullRequestDraft) {
		const title = draft.isDraft && !/^draft:/i.test(draft.title) ? `Draft: ${draft.title}` : draft.title;
		const response = await onProject(() => gitlabRequest<GitLabItemWire>(context.credentials, `${project(context)}/merge_requests`, {
			method: 'POST',
			body: {
				source_branch: draft.head,
				target_branch: draft.base,
				title,
				description: draft.body,
				remove_source_branch: false
			}
		}));
		return toWorkItem(response.data, 'pull-request');
	},

	async findPullRequestForBranch(context, branch) {
		const params = new URLSearchParams({ source_branch: branch, state: 'opened', per_page: '5' });
		const response = await gitlabRequest<GitLabItemWire[]>(
			context.credentials,
			`${project(context)}/merge_requests?${params.toString()}`
		);
		const found = (response.data ?? [])[0];
		return found ? toWorkItem(found, 'pull-request') : null;
	},

	async viewer(context) {
		try {
			return await viewerLogin(context.credentials);
		} catch {
			return null;
		}
	},

	async updateItem(context, kind, id, patch) {
		await onProject(() => gitlabRequest(context.credentials, `${project(context)}/${itemsPath(kind)}/${id}`, {
			method: 'PUT',
			body: {
				...(patch.title !== undefined && { title: patch.title }),
				...(patch.body !== undefined && { description: patch.body })
			}
		}));
	},

	async listLabels(context) {
		const labels = await onProject(() => gitlabPaged<{ name: string }>(context.credentials, `${project(context)}/labels`, 2));
		return labels.map((label) => label.name);
	},

	async updateComment(context, comment, body) {
		const { path, iid, noteId } = parseCommentId(comment.id);
		const response = await onProject(() => gitlabRequest<GitLabNoteWire>(
			context.credentials,
			`${project(context)}/${path}/${iid}/notes/${noteId}`,
			{ method: 'PUT', body: { body } }
		));
		return toComment(response.data, path === 'merge_requests' ? 'pull-request' : 'issue', iid, response.data.author?.username ?? null);
	},

	async deleteComment(context, comment) {
		const { path, iid, noteId } = parseCommentId(comment.id);
		await onProject(() => gitlabRequest(context.credentials, `${project(context)}/${path}/${iid}/notes/${noteId}`, { method: 'DELETE' }));
	},

	async mergePullRequest(context, id, options) {
		await onProject(() => gitlabRequest(context.credentials, `${project(context)}/merge_requests/${id}/merge`, {
			method: 'PUT',
			body: {
				squash: options.method === 'squash',
				...(options.title && options.method === 'squash' && { squash_commit_message: options.title }),
				...(options.title && options.method !== 'squash' && { merge_commit_message: options.title })
			}
		}));
	},

	async listCommits(context, id) {
		const commits = await onProject(() => gitlabPaged<GitLabCommitWire>(
			context.credentials,
			`${project(context)}/merge_requests/${id}/commits`,
			2
		));
		return commits.map(toCommit);
	},

	async commitDetail(context, sha): Promise<CommitDetail> {
		const base = `${project(context)}/repository/commits/${encodeURIComponent(sha)}`;
		const [commit, diffs] = await onProject(() => Promise.all([
			gitlabRequest<GitLabCommitWire>(context.credentials, base),
			gitlabPaged<GitLabDiffWire>(context.credentials, `${base}/diff`, 3)
		]));
		const message = commit.data.message ?? commit.data.title;
		return {
			commit: toCommit(commit.data),
			body: message.split('\n').slice(1).join('\n').trim(),
			additions: commit.data.stats?.additions ?? 0,
			deletions: commit.data.stats?.deletions ?? 0,
			files: diffs.map((diff) => toFileChange(diff, commit.data.web_url))
		};
	},

	async fetchFileContent(context, path, ref): Promise<FileContent> {
		const response = await onProject(() => gitlabRequest<string>(
			context.credentials,
			`${project(context)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
			{ text: true }
		));
		const text = response.data;
		if (text.length <= MAX_RENDER_BYTES) return { content: text, truncated: false };
		const head = text.slice(0, MAX_RENDER_BYTES);
		return { content: head.slice(0, head.lastIndexOf('\n') + 1 || head.length), truncated: true };
	},

	async listFiles(context, id) {
		const url = `${gitlabWebBase(context.credentials)}/${context.binding.locator}/-/merge_requests/${id}/diffs`;
		const diffs = await onProject(() => gitlabPaged<GitLabDiffWire>(
			context.credentials,
			`${project(context)}/merge_requests/${id}/diffs`,
			3
		));
		return diffs.map((diff) => toFileChange(diff, url));
	},

	async listAssignees(context) {
		const members = await onProject(() => gitlabPaged<{ username: string; state?: string }>(
			context.credentials,
			`${project(context)}/members/all`,
			2
		));
		return [...new Set(members.filter((member) => member.state !== 'blocked').map((member) => member.username))];
	},

	async setAssignees(context, kind, id, logins) {
		const ids = await userIds(context.credentials, logins);
		await onProject(() => gitlabRequest(context.credentials, `${project(context)}/${itemsPath(kind)}/${id}`, {
			method: 'PUT',
			// An empty list must be sent as [0] to clear, per GitLab's API.
			body: { assignee_ids: ids.length > 0 ? ids : [0] }
		}));
	},

	async setLabels(context, kind, id, labels) {
		await onProject(() => gitlabRequest(context.credentials, `${project(context)}/${itemsPath(kind)}/${id}`, {
			method: 'PUT',
			body: { labels: labels.join(',') }
		}));
	},

	async setReviewers(context, id, logins) {
		const ids = await userIds(context.credentials, logins);
		await onProject(() => gitlabRequest(context.credentials, `${project(context)}/merge_requests/${id}`, {
			method: 'PUT',
			body: { reviewer_ids: ids.length > 0 ? ids : [0] }
		}));
	},

	async createIssue(context, draft) {
		const ids = draft.assignees.length > 0 ? await userIds(context.credentials, draft.assignees) : [];
		const response = await onProject(() => gitlabRequest<GitLabItemWire>(context.credentials, `${project(context)}/issues`, {
			method: 'POST',
			body: {
				title: draft.title,
				description: draft.body,
				...(draft.labels.length > 0 && { labels: draft.labels.join(',') }),
				...(ids.length > 0 && { assignee_ids: ids })
			}
		}));
		return toWorkItem(response.data, 'issue');
	}
};
