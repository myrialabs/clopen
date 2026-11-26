/**
 * Git hosting, as the Git panel sees it: which service each remote lives on,
 * which connected account answers for it, the web links for it, and the CI
 * state of the commits on screen.
 *
 * Follows the WORKSPACE project. Hosting is a property of the repository the
 * panel is showing, so there is no project picker here and nothing to keep in
 * step with one.
 *
 * The context call is local (remotes matched against accounts, no network),
 * so it is re-asked whenever remotes or accounts change. CI statuses are the
 * only network-bound state, fetched for the commits actually shown.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import { projectState } from '$frontend/stores/core/projects.svelte';
import type {
	CommitCiStatus,
	GitHostKind,
	HostAccount,
	HostingContext,
	HostLinks,
	HostRemote
} from '$shared/types/git-hosting';
import type { CheckRun, WorkItem, WorkItemDetail } from '$shared/types/work';

/** What one referenced item may add to a prompt — enough to act on, not the whole thread. */
const REFERENCE_BUDGET = 12 * 1024;

/** How each service is named in copy, before any account says otherwise. */
export const HOST_NAMES: Record<GitHostKind, string> = {
	github: 'GitHub',
	gitlab: 'GitLab',
	gitea: 'Gitea',
	bitbucket: 'Bitbucket'
};

/** What a pull request is called on each service — GitLab's are merge requests. */
export const PR_NOUN: Record<GitHostKind, { short: string; long: string }> = {
	github: { short: 'PR', long: 'pull request' },
	gitlab: { short: 'MR', long: 'merge request' },
	gitea: { short: 'PR', long: 'pull request' },
	bitbucket: { short: 'PR', long: 'pull request' }
};

interface HostingState {
	projectId: string | null;
	context: HostingContext | null;
	isLoading: boolean;
	/** Bumped per load; a slower answer for an earlier project must not win. */
	generation: number;
	ci: Record<string, CommitCiStatus>;
	/** Open pull requests by head branch, for the branch badges. */
	branchPrs: Record<string, WorkItem>;
	branchPrsLoadedFor: string | null;
	/** CI for the branch the workspace is on. */
	currentChecks: { branch: string; runs: CheckRun[] } | null;
	/**
	 * Something outside the Git panel (the command palette) asked it to do
	 * something. A counter per intent, so asking twice reacts twice.
	 */
	intents: Record<HostingIntent, number>;
}

/** What the command palette can ask the Git panel to do. */
export type HostingIntent = 'publish' | 'open-pr' | 'show-host';

const state = $state<HostingState>({
	projectId: null,
	context: null,
	isLoading: false,
	generation: 0,
	ci: {},
	branchPrs: {},
	branchPrsLoadedFor: null,
	currentChecks: null,
	intents: { publish: 0, 'open-pr': 0, 'show-host': 0 }
});

/** CI lookups already in flight, so a scroll does not ask twice for one commit. */
const ciInFlight = new Set<string>();

function fill(template: string, values: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (_, key: string) => {
		const value = values[key];
		if (value === undefined) return '';
		// A path keeps its slashes; every other value is one URL segment.
		return key === 'path' ? value.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(value);
	});
}

export const hostingStore = {
	get context(): HostingContext | null {
		return state.context;
	},
	get isLoading(): boolean {
		return state.isLoading;
	},
	get accounts(): HostAccount[] {
		return state.context?.accounts ?? [];
	},
	get remotes(): HostRemote[] {
		return state.context?.remotes ?? [];
	},

	/** The remote issues, pull requests and CI are read from. */
	get primaryRemote(): HostRemote | null {
		const context = state.context;
		if (!context?.primaryRemote) return null;
		return context.remotes.find((remote) => remote.name === context.primaryRemote) ?? null;
	},

	/** The account that answers for the primary remote, when one is connected. */
	get primaryAccount(): HostAccount | null {
		const remote = this.primaryRemote;
		if (!remote?.accountId) return null;
		return this.accounts.find((account) => account.accountId === remote.accountId) ?? null;
	},

	/** The service the primary remote is on — known even with no account connected. */
	get primaryProvider(): GitHostKind | null {
		return this.primaryRemote?.provider ?? null;
	},

	/** "GitHub", "GitLab" — the label the Git panel's hosting view carries. */
	get providerName(): string | null {
		const provider = this.primaryProvider;
		return provider ? HOST_NAMES[provider] : null;
	},

	get prNoun(): { short: string; long: string } {
		const provider = this.primaryProvider;
		return provider ? PR_NOUN[provider] : PR_NOUN.github;
	},

	/** True when the hosting view has issues and pull requests to show. */
	get offersWork(): boolean {
		return this.primaryAccount?.offersWork === true;
	},

	get ci(): Record<string, CommitCiStatus> {
		return state.ci;
	},
	get branchPrs(): Record<string, WorkItem> {
		return state.branchPrs;
	},
	get currentChecks(): { branch: string; runs: CheckRun[] } | null {
		return state.currentChecks;
	},

	/** A web link for the primary remote, or for a named one. Null when there is none. */
	link(kind: keyof HostLinks, values: Record<string, string> = {}, remoteName?: string): string | null {
		const remote = remoteName ? this.remotes.find((entry) => entry.name === remoteName) : this.primaryRemote;
		const links = remote?.links;
		if (!links) return null;
		if (kind === 'file') {
			const base = fill(links.file, values);
			return values.line ? base + fill(links.fileLine, values) : base;
		}
		return fill(links[kind], values);
	},

	/** Accounts able to create repositories, for Publish and Add Remote. */
	get publishAccounts(): HostAccount[] {
		return this.accounts.filter((account) => account.status !== 'needs_auth');
	},

	async load(options: { force?: boolean } = {}): Promise<void> {
		const projectId = projectState.currentProject?.id ?? null;
		if (!projectId) {
			this.reset();
			return;
		}
		if (projectId !== state.projectId) {
			this.reset();
			state.projectId = projectId;
		} else if (state.context && !options.force) {
			return;
		}

		const generation = ++state.generation;
		state.isLoading = true;
		try {
			const context = await ws.http('hosting:context', { projectId });
			if (generation !== state.generation) return;
			state.context = context;
		} catch (error) {
			if (generation !== state.generation) return;
			debug.warn('git', 'Could not load hosting context:', error);
			state.context = null;
		} finally {
			if (generation === state.generation) state.isLoading = false;
		}
	},

	/**
	 * CI state for the commits on screen. Asked in one batch, and only for the
	 * ones not already known — a finished commit's CI never changes.
	 */
	async loadCi(shas: string[]): Promise<void> {
		const projectId = state.projectId;
		const remote = this.primaryRemote;
		if (!projectId || !remote?.accountId) return;
		const wanted = shas.filter((sha) => {
			const known = state.ci[sha];
			return !ciInFlight.has(sha) && (!known || known.state === 'pending');
		}).slice(0, 60);
		if (wanted.length === 0) return;

		for (const sha of wanted) ciInFlight.add(sha);
		try {
			const statuses = await ws.http('hosting:commit-statuses', { projectId, remote: remote.name, shas: wanted });
			if (projectId !== state.projectId) return;
			const next = { ...state.ci };
			for (const status of statuses) next[status.sha] = status;
			state.ci = next;
		} catch (error) {
			debug.warn('git', 'Could not load commit statuses:', error);
		} finally {
			for (const sha of wanted) ciInFlight.delete(sha);
		}
	},

	/**
	 * Open pull requests by head branch — one list call, so every branch row
	 * can say "#123" without a request each.
	 */
	async loadBranchPrs(options: { force?: boolean } = {}): Promise<void> {
		const projectId = state.projectId;
		const account = this.primaryAccount;
		if (!projectId || !account?.offersWork) {
			state.branchPrs = {};
			return;
		}
		const key = `${projectId}:${account.accountId}`;
		if (!options.force && state.branchPrsLoadedFor === key) return;
		try {
			const page = await ws.http('work:list', {
				projectId,
				accountId: account.accountId,
				kind: 'pull-request',
				state: 'open',
				mineOnly: false
			});
			if (projectId !== state.projectId) return;
			const map: Record<string, WorkItem> = {};
			for (const item of page.items) {
				if (item.headBranch && !map[item.headBranch]) map[item.headBranch] = item;
			}
			state.branchPrs = map;
			state.branchPrsLoadedFor = key;
		} catch (error) {
			// A project not bound to a repository yet, or a token without access:
			// the badges are a nicety, and their absence says nothing wrong.
			debug.warn('git', 'Could not load open pull requests:', error);
			state.branchPrs = {};
			state.branchPrsLoadedFor = key;
		}
	},

	/** CI runs for the branch the workspace is on, for the "this branch" card. */
	async loadCurrentChecks(branch: string | null | undefined): Promise<void> {
		const projectId = state.projectId;
		const account = this.primaryAccount;
		if (!projectId || !account?.offersWork || !branch) {
			state.currentChecks = null;
			return;
		}
		try {
			const result = await ws.http('work:checks', { projectId, accountId: account.accountId, branch });
			if (projectId !== state.projectId) return;
			state.currentChecks = { branch: result.branch, runs: result.runs };
		} catch {
			state.currentChecks = null;
		}
	},

	/**
	 * Issues and pull requests matching what was typed after `#`, for the chat
	 * composer. Both kinds, open first, numbers matched exactly before titles.
	 */
	async searchWorkItems(query: string): Promise<WorkItem[]> {
		const projectId = state.projectId;
		const account = this.primaryAccount;
		if (!projectId || !account?.offersWork) return [];
		const search = query.trim();
		const ask = (kind: 'issue' | 'pull-request') => ws.http('work:list', {
			projectId,
			accountId: account.accountId,
			kind,
			state: search ? 'all' : 'open',
			mineOnly: false,
			...(search && !/^\d+$/.test(search) && { search })
		}).then((page) => page.items).catch(() => [] as WorkItem[]);
		const [issues, pulls] = await Promise.all([ask('issue'), ask('pull-request')]);
		const all = [...pulls, ...issues];
		const exact = /^\d+$/.test(search) ? all.filter((item) => item.identifier.startsWith(search)) : all;
		return exact
			.sort((a, b) => (a.stateCategory === 'open' ? 0 : 1) - (b.stateCategory === 'open' ? 0 : 1) || b.updatedAt.localeCompare(a.updatedAt))
			.slice(0, 8);
	},

	/**
	 * One item as a markdown document an agent can read: what it is, where it
	 * lives, its description and the latest discussion, cut to a budget.
	 */
	async workItemMarkdown(item: WorkItem): Promise<{ fileName: string; text: string } | null> {
		const projectId = state.projectId;
		const account = this.primaryAccount;
		if (!projectId || !account?.offersWork) return null;
		const detail = (await ws.http('work:get', {
			projectId,
			accountId: account.accountId,
			kind: item.kind,
			id: item.id
		})) as WorkItemDetail;

		const noun = item.kind === 'pull-request' ? this.prNoun.long : 'issue';
		const lines = [
			`# ${noun[0]!.toUpperCase()}${noun.slice(1)} #${detail.identifier}: ${detail.title}`,
			'',
			`- URL: ${detail.url}`,
			`- State: ${detail.state}`,
			...(detail.author ? [`- Author: ${detail.author}`] : []),
			...(detail.headBranch ? [`- Branch: ${detail.headBranch} → ${detail.baseBranch ?? ''}`] : []),
			...(detail.labels.length ? [`- Labels: ${detail.labels.join(', ')}`] : []),
			...(detail.assignees.length ? [`- Assignees: ${detail.assignees.join(', ')}`] : []),
			'',
			'## Description',
			'',
			detail.body.trim() || '_No description._'
		];
		let text = lines.join('\n');
		// The newest comments matter most; earlier ones are dropped first.
		const comments = detail.comments.slice(-15);
		const rendered: string[] = [];
		for (const comment of [...comments].reverse()) {
			const block = `### ${comment.author} · ${comment.createdAt.slice(0, 10)}${comment.path ? ` · ${comment.path}` : ''}\n\n${comment.body.trim()}`;
			if (text.length + rendered.join('\n\n').length + block.length > REFERENCE_BUDGET) break;
			rendered.unshift(block);
		}
		if (rendered.length) text += `\n\n## Discussion${rendered.length < detail.comments.length ? ` (latest ${rendered.length} of ${detail.comments.length})` : ''}\n\n${rendered.join('\n\n')}`;
		if (text.length > REFERENCE_BUDGET) text = `${text.slice(0, REFERENCE_BUDGET)}\n\n… truncated`;
		const prefix = item.kind === 'pull-request' ? this.prNoun.short.toLowerCase() : 'issue';
		return { fileName: `${prefix}-${detail.identifier}.md`, text };
	},

	get intents(): Record<HostingIntent, number> {
		return state.intents;
	},

	/** Ask the Git panel to do something; it watches `intents`. */
	request(intent: HostingIntent): void {
		state.intents = { ...state.intents, [intent]: state.intents[intent] + 1 };
	},

	reset(): void {
		state.projectId = null;
		state.context = null;
		state.ci = {};
		state.branchPrs = {};
		state.branchPrsLoadedFor = null;
		state.currentChecks = null;
		state.generation += 1;
	}
};

let eventsBound = false;

/** Re-match remotes whenever an account changes anywhere. */
export function initHostingEvents(): void {
	if (eventsBound) return;
	eventsBound = true;
	ws.on('integrations:changed', () => {
		void hostingStore.load({ force: true }).then(() => hostingStore.loadBranchPrs({ force: true }));
	});
}
