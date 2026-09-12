/**
 * Deployments surface store.
 *
 * Holds what is being LOOKED AT — which project, which source, which filter,
 * which deployment is open — and nothing the server owns. Deployments are not
 * cached across opens: state, logs and URLs all go stale within seconds, and a
 * list that is three minutes old is worse than a spinner for a panel whose
 * whole point is "what is live right now".
 *
 * The project is part of that state and NOT read from the workspace. This
 * surface lives in More Tools, which is global: watching another project's
 * build must not require abandoning the session you are in. Every request
 * carries the project explicitly, and the workspace only moves when an action
 * genuinely relocates you — opening a build in the preview browser.
 *
 * The panel is provider-agnostic, and so is this file. Anything that reads
 * `provider === 'vercel'` here would be a bug in the interface, not a feature.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import { projectState, setCurrentProject } from '$frontend/stores/core/projects.svelte';
import { chatService } from '$frontend/services/chat/chat.service';
import { showPanel } from '$frontend/stores/ui/workspace.svelte';
import { showError, showInfo, showSuccess } from '$frontend/stores/ui/notification.svelte';
import { closeDeploymentsDialog } from '$frontend/stores/ui/quick-panels.svelte';
import { whenWorkspaceSettled } from '$frontend/stores/ui/project-workspace.svelte';
import type {
	BuildLogBundle,
	DeployAction,
	DeployBindingConfig,
	Deployment,
	DeploymentDetail,
	DeploymentEnvironmentFilter,
	DeployInfo,
	DeployProjectStatus,
	DeployRateLimit,
	DeploySource,
	DeployTarget,
	NewProjectDefaults
} from '$shared/types/deployments';

/**
 * How long the list waits between refreshes while a build is running.
 *
 * Ten seconds, not one. The Ports panel polls every second because it reads
 * this machine; this is a metered remote API, and a build that takes four
 * minutes would cost 240 requests at that rate. Polling stops entirely when
 * nothing is live, so an idle panel costs nothing at all.
 */
const POLL_INTERVAL_MS = 10_000;

/**
 * Budget for calls that make the provider do real work.
 *
 * The default 30 seconds expired while Vercel was still linking a repository,
 * and the server carried on — so the user saw "Request timeout" for an
 * operation that then succeeded, which is the one outcome worse than a plain
 * failure. Same lesson `issues:start-work` learned when it timed out mid-clone.
 *
 * Deliberately a long budget rather than none. An unbounded call cannot
 * distinguish "still working" from "this socket will never answer", and leaves
 * a dialog spinning with no way back except a reload.
 */
const SLOW_CALL_TIMEOUT_MS = 3 * 60 * 1000;

interface DeploymentsState {
	/**
	 * Mirrors the modal's visibility, set by the modal itself.
	 *
	 * `quickPanelsState.deploymentsOpen` is the source of truth for whether the
	 * surface is on screen — it is what the navigators bind to. This flag exists
	 * only so the poller knows whether anyone is looking, and it must never be
	 * the thing that closes the modal.
	 */
	isActive: boolean;
	/** Project being VIEWED here, which need not be the workspace's. */
	projectId: string | null;
	sources: DeploySource[];
	activeAccountId: string | null;

	items: Deployment[];
	hasMore: boolean;
	nextCursor: string | null;
	isLoadingMore: boolean;
	/**
	 * Generation of the newest list request.
	 *
	 * Switching a filter and switching back fires two requests, and the first
	 * can answer after the second — leaving the restored filter showing the
	 * other one's rows. Every response checks this before writing, so a stale
	 * answer is discarded instead of winning.
	 */
	listGeneration: number;

	environment: DeploymentEnvironmentFilter;
	branch: string;
	rateLimit: DeployRateLimit | null;

	isLoadingSources: boolean;
	isLoadingItems: boolean;
	error: string | null;

	selectedId: string | null;
	detail: DeploymentDetail | null;
	isLoadingDetail: boolean;

	/** Finished build's log, fetched on demand. */
	logs: BuildLogBundle | null;
	isLoadingLogs: boolean;
	/** Live follow of a running build. */
	streamId: string | null;
	streamText: string;
	isStreaming: boolean;
	/** Stage the provider last reported for the followed build. */
	streamPhase: string | null;

	/** Targets for the binding picker, listed on demand. */
	targets: DeployTarget[];
	isLoadingTargets: boolean;

	/** Action currently in flight, so its row can show progress. */
	busyAction: DeployAction | null;

	/**
	 * Whether this remote project has EVER been deployed.
	 *
	 * Distinct from "the current filter matched nothing", and the distinction is
	 * the whole difference between an empty state that reads as a bug and one
	 * that offers the button the user came for. Null until a list has landed.
	 */
	hasAnyDeployment: boolean | null;

	deployInfo: DeployInfo | null;
	/** Which (project, account) the cached deploy info belongs to. */
	deployInfoKey: string | null;
	isLoadingDeployInfo: boolean;
	isDeploying: boolean;
	/** Assembling a failed build's log for the chat. */
	isSendingLogs: boolean;
	/** Paused, and whether a traffic move is still being carried out. Read-only. */
	projectStatus: DeployProjectStatus | null;
}

const state = $state<DeploymentsState>({
	isActive: false,
	projectId: null,
	sources: [],
	activeAccountId: null,
	items: [],
	hasMore: false,
	nextCursor: null,
	isLoadingMore: false,
	listGeneration: 0,
	environment: 'all',
	branch: '',
	rateLimit: null,
	isLoadingSources: false,
	isLoadingItems: false,
	error: null,
	selectedId: null,
	detail: null,
	isLoadingDetail: false,
	logs: null,
	isLoadingLogs: false,
	streamId: null,
	streamText: '',
	isStreaming: false,
	streamPhase: null,
	targets: [],
	isLoadingTargets: false,
	busyAction: null,
	hasAnyDeployment: null,
	deployInfo: null,
	deployInfoKey: null,
	isLoadingDeployInfo: false,
	isDeploying: false,
	isSendingLogs: false,
	projectStatus: null
});

let pollTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeChunks: (() => void) | null = null;
let unsubscribeChanged: (() => void) | null = null;

/** True while the provider may still change a visible deployment on its own. */
function hasLiveBuild(items: Deployment[]): boolean {
	return items.some((item) => item.state === 'queued' || item.state === 'building');
}

/**
 * Move the workspace onto the project this surface is looking at.
 *
 * Both loops that leave this surface — chat and the preview browser — land in
 * the workspace, which follows ONE project. Skipping the move would send a
 * failed build's log into whatever session happened to be open, which is the
 * one outcome worse than not sending it.
 *
 * The settle wait is the non-obvious half. Docks hydrate AFTER the reveal and
 * the switch does not await them, so `setCurrentProject` hands control back
 * while the chat and preview docks are still rebuilding — and whatever we do
 * next gets cleared out from under us.
 */
async function relocateIfNeeded(projectId: string): Promise<void> {
	if (projectId === projectState.currentProject?.id) return;
	const target = projectState.projects.find((entry) => entry.id === projectId);
	if (!target) return;

	await setCurrentProject(target);
	await whenWorkspaceSettled();
}

/**
 * Decide which kind of empty a list is.
 *
 * "Nothing matches this filter" and "this project has never been deployed" look
 * identical in the data and need opposite answers from the UI — one offers a
 * cleared filter, the other offers the Deploy button. An unfiltered list answers
 * it for free; a filtered empty one costs one narrow probe, which only happens
 * on the rare open where a filter hid everything.
 */
async function noteListResult(
	source: DeploySource,
	projectId: string,
	items: unknown[],
	filtered: boolean
): Promise<void> {
	if (items.length > 0 || !filtered) {
		state.hasAnyDeployment = items.length > 0;
		return;
	}

	try {
		const probe = await ws.http('deployments:list', {
			projectId,
			accountId: source.accountId,
			environment: 'all'
		});
		state.hasAnyDeployment = probe.items.length > 0;
	} catch {
		// Leave it unknown rather than claiming the project is empty — the empty
		// state falls back to the neutral wording.
		state.hasAnyDeployment = null;
	}
}

function currentSource(): DeploySource | null {
	if (!state.activeAccountId) return state.sources[0] ?? null;
	return state.sources.find((source) => source.accountId === state.activeAccountId) ?? null;
}

/**
 * Start or stop the poller to match what is on screen.
 *
 * Called after every list write rather than on a timer of its own, because the
 * condition it depends on — is anything still building — only changes when a
 * list lands. A poller that outlives its reason is the thing that turns a
 * metered API into a bill.
 */
function syncPolling(): void {
	const source = currentSource();
	const wanted =
		state.isActive &&
		source?.binding?.config.autoRefresh === true &&
		hasLiveBuild(state.items);

	if (wanted && !pollTimer) {
		pollTimer = setInterval(() => void deploymentsStore.refresh({ quiet: true }), POLL_INTERVAL_MS);
	} else if (!wanted && pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

export const deploymentsStore = {
	get isActive() {
		return state.isActive;
	},
	get projectId() {
		return state.projectId;
	},
	get project() {
		return projectState.projects.find((entry) => entry.id === state.projectId) ?? null;
	},
	get sources() {
		return state.sources;
	},
	get source() {
		return currentSource();
	},
	get items() {
		return state.items;
	},
	get hasMore() {
		return state.hasMore;
	},
	get isLoadingMore() {
		return state.isLoadingMore;
	},
	get environment() {
		return state.environment;
	},
	get branch() {
		return state.branch;
	},
	get rateLimit() {
		return state.rateLimit;
	},
	get isLoadingSources() {
		return state.isLoadingSources;
	},
	get isLoadingItems() {
		return state.isLoadingItems;
	},
	get error() {
		return state.error;
	},
	get selectedId() {
		return state.selectedId;
	},
	get detail() {
		return state.detail;
	},
	get isLoadingDetail() {
		return state.isLoadingDetail;
	},
	get logs() {
		return state.logs;
	},
	get isLoadingLogs() {
		return state.isLoadingLogs;
	},
	get streamText() {
		return state.streamText;
	},
	get isStreaming() {
		return state.isStreaming;
	},
	get streamPhase() {
		return state.streamPhase;
	},
	get targets() {
		return state.targets;
	},
	get isLoadingTargets() {
		return state.isLoadingTargets;
	},
	get busyAction() {
		return state.busyAction;
	},
	get hasAnyDeployment() {
		return state.hasAnyDeployment;
	},
	get deployInfo() {
		return state.deployInfo;
	},
	get isLoadingDeployInfo() {
		return state.isLoadingDeployInfo;
	},
	get isDeploying() {
		return state.isDeploying;
	},
	get isSendingLogs() {
		return state.isSendingLogs;
	},
	get projectStatus() {
		return state.projectStatus;
	},
	/** A rollback or promotion the provider has accepted but not finished. */
	get pendingAliasRequest() {
		const request = state.projectStatus?.aliasRequest;
		if (!request) return null;
		return request.status === 'pending' || request.status === 'in-progress' ? request : null;
	},
	/** True when the list is empty only because a filter is narrowing it. */
	get isFilteredEmpty() {
		return (
			state.items.length === 0 &&
			state.hasAnyDeployment === true &&
			(state.environment !== 'all' || state.branch.trim() !== '')
		);
	},
	/** True when this remote project has genuinely never produced a build. */
	get isNeverDeployed() {
		return state.items.length === 0 && state.hasAnyDeployment === false;
	},

	/** True when there are sources but none of them knows what to show. */
	get needsBinding() {
		const source = currentSource();
		return state.sources.length > 0 && source !== null && source.binding === null;
	},

	activate(): void {
		state.isActive = true;
		state.projectId ??= projectState.currentProject?.id ?? null;

		unsubscribeChunks ??= ws.on('deployments:log-chunk', (chunk) => {
			if (chunk.streamId !== state.streamId) return;
			if (chunk.data) state.streamText += chunk.data;
			if (chunk.phase) state.streamPhase = chunk.phase;
			if (chunk.done) {
				state.isStreaming = false;
				state.streamId = null;
				if (chunk.error) showError('Build log', chunk.error);
				// The build ended while we were watching it, so what the list says
				// about it is now wrong.
				void deploymentsStore.refresh({ quiet: true });
			}
		});

		unsubscribeChanged ??= ws.on('deployments:changed', (event) => {
			if (event.projectId === state.projectId) void deploymentsStore.loadSources();
		});

		void this.loadSources();
	},

	deactivate(): void {
		state.isActive = false;
		void this.stopFollowing();
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		unsubscribeChunks?.();
		unsubscribeChunks = null;
		unsubscribeChanged?.();
		unsubscribeChanged = null;
	},

	selectProject(projectId: string): void {
		if (projectId === state.projectId) return;
		state.projectId = projectId;
		state.sources = [];
		state.activeAccountId = null;
		state.items = [];
		state.selectedId = null;
		state.detail = null;
		void this.loadSources();
	},

	selectSource(accountId: string): void {
		if (accountId === state.activeAccountId) return;
		state.activeAccountId = accountId;
		state.selectedId = null;
		state.detail = null;
		void this.loadList();
	},

	async loadSources(): Promise<void> {
		if (!state.projectId) return;
		state.isLoadingSources = true;
		state.error = null;

		try {
			const sources = await ws.http('deployments:sources', { projectId: state.projectId });
			state.sources = sources;

			// Keep the chosen source when it survived the reload, so a binding
			// change does not silently move the user to another account.
			const stillThere = sources.some((source) => source.accountId === state.activeAccountId);
			if (!stillThere) state.activeAccountId = sources[0]?.accountId ?? null;

			const source = currentSource();
			if (source?.binding) {
				state.environment = source.binding.config.environment;
				void this.loadProjectStatus();
				await this.loadList();
			} else {
				state.items = [];
				syncPolling();
			}
		} catch (error) {
			state.error = error instanceof Error ? error.message : String(error);
			debug.error('deployments', 'Could not load sources:', error);
		} finally {
			state.isLoadingSources = false;
		}
	},

	async loadList(): Promise<void> {
		const source = currentSource();
		if (!state.projectId || !source?.binding) return;

		const generation = ++state.listGeneration;
		state.isLoadingItems = true;
		state.error = null;

		try {
			const page = await ws.http('deployments:list', {
				projectId: state.projectId,
				accountId: source.accountId,
				environment: state.environment,
				...(state.branch.trim() && { branch: state.branch.trim() })
			});
			if (generation !== state.listGeneration) return;

			state.items = page.items;
			state.hasMore = page.hasMore;
			state.nextCursor = page.nextCursor;
			state.rateLimit = page.rateLimit;

			// Open the newest build rather than an empty pane. It is what someone
			// came to look at nine times out of ten, and the detail is the whole
			// substance of this surface — an empty right-hand column reads as the
			// panel not having loaded.
			if (!state.selectedId && page.items.length > 0) {
				void this.select(page.items[0].id);
			}

			await noteListResult(
				source,
				state.projectId,
				page.items,
				state.environment !== 'all' || state.branch.trim() !== ''
			);
		} catch (error) {
			if (generation !== state.listGeneration) return;
			state.error = error instanceof Error ? error.message : String(error);
			debug.error('deployments', 'Could not list deployments:', error);
		} finally {
			if (generation === state.listGeneration) state.isLoadingItems = false;
			syncPolling();
		}
	},

	/**
	 * Reload the visible page without clearing it.
	 *
	 * `quiet` is what the poller uses: replacing the rows in place keeps the
	 * scroll position and avoids a spinner flashing every ten seconds over a
	 * list that mostly did not change.
	 */
	async refresh(options: { quiet?: boolean } = {}): Promise<void> {
		const source = currentSource();
		if (!state.projectId || !source?.binding) return;

		const generation = ++state.listGeneration;
		if (!options.quiet) state.isLoadingItems = true;

		try {
			const page = await ws.http('deployments:list', {
				projectId: state.projectId,
				accountId: source.accountId,
				environment: state.environment,
				...(state.branch.trim() && { branch: state.branch.trim() })
			});
			if (generation !== state.listGeneration) return;

			state.items = page.items;
			state.hasMore = page.hasMore;
			state.nextCursor = page.nextCursor;
			state.rateLimit = page.rateLimit;
			if (page.items.length > 0) state.hasAnyDeployment = true;

			// The open deployment moves too — its state is the thing most likely
			// to have changed while someone watched it.
			if (state.selectedId) await this.loadDetail(state.selectedId, { quiet: true });
		} catch (error) {
			if (generation !== state.listGeneration) return;
			// A quiet refresh that fails must not replace the list with an error:
			// the rows on screen are still the best answer anyone has.
			if (!options.quiet) state.error = error instanceof Error ? error.message : String(error);
			debug.warn('deployments', 'Refresh failed:', error);
		} finally {
			if (generation === state.listGeneration) state.isLoadingItems = false;
			syncPolling();
		}
	},

	async loadMore(): Promise<void> {
		const source = currentSource();
		if (!state.projectId || !source?.binding) return;
		if (!state.hasMore || state.isLoadingMore || !state.nextCursor) return;

		state.isLoadingMore = true;
		try {
			const page = await ws.http('deployments:list', {
				projectId: state.projectId,
				accountId: source.accountId,
				environment: state.environment,
				cursor: state.nextCursor,
				...(state.branch.trim() && { branch: state.branch.trim() })
			});

			// Deduplicated because a build landing between pages shifts the window
			// and can hand back a row the first page already showed.
			const seen = new Set(state.items.map((item) => item.id));
			state.items = [...state.items, ...page.items.filter((item) => !seen.has(item.id))];
			state.hasMore = page.hasMore;
			state.nextCursor = page.nextCursor;
			state.rateLimit = page.rateLimit;
		} catch (error) {
			showError('Deployments', error instanceof Error ? error.message : String(error));
		} finally {
			state.isLoadingMore = false;
		}
	},

	setEnvironment(environment: DeploymentEnvironmentFilter): void {
		if (environment === state.environment) return;
		state.environment = environment;
		void this.loadList();
	},

	setBranch(branch: string): void {
		state.branch = branch;
		void this.loadList();
	},

	async select(deploymentId: string | null): Promise<void> {
		if (state.selectedId === deploymentId) return;

		await this.stopFollowing();
		state.selectedId = deploymentId;
		state.detail = null;
		state.logs = null;
		state.streamText = '';
		state.streamPhase = null;

		if (deploymentId) await this.loadDetail(deploymentId);
	},

	async loadDetail(deploymentId: string, options: { quiet?: boolean } = {}): Promise<void> {
		const source = currentSource();
		if (!state.projectId || !source) return;

		if (!options.quiet) state.isLoadingDetail = true;
		try {
			const detail = await ws.http('deployments:get', {
				projectId: state.projectId,
				accountId: source.accountId,
				deploymentId
			});
			// Discard when the user moved on while this was in flight.
			if (state.selectedId === deploymentId) state.detail = detail;
		} catch (error) {
			if (!options.quiet) {
				showError('Deployments', error instanceof Error ? error.message : String(error));
			}
		} finally {
			state.isLoadingDetail = false;
		}
	},

	async loadLogs(): Promise<void> {
		const source = currentSource();
		if (!state.projectId || !source || !state.selectedId) return;
		if (!source.capabilities.logs) return;

		state.isLoadingLogs = true;
		try {
			state.logs = await ws.http('deployments:logs', {
				projectId: state.projectId,
				accountId: source.accountId,
				deploymentId: state.selectedId
			});
		} catch (error) {
			showError('Build log', error instanceof Error ? error.message : String(error));
		} finally {
			state.isLoadingLogs = false;
		}
	},

	/** Follow a running build. Falls back to nothing when the provider cannot. */
	async startFollowing(): Promise<void> {
		const source = currentSource();
		if (!state.projectId || !source || !state.selectedId) return;
		if (!source.capabilities.streamLogs || state.isStreaming) return;

		try {
			const started = await ws.http('deployments:follow-start', {
				projectId: state.projectId,
				accountId: source.accountId,
				deploymentId: state.selectedId
			});
			state.streamId = started.streamId;
			state.streamText = started.backlog;
			state.isStreaming = true;
			state.streamPhase = null;
		} catch (error) {
			showError('Build log', error instanceof Error ? error.message : String(error));
		}
	},

	async stopFollowing(): Promise<void> {
		if (!state.streamId) return;
		const streamId = state.streamId;
		state.streamId = null;
		state.isStreaming = false;
		try {
			await ws.http('deployments:follow-stop', { streamId });
		} catch (error) {
			debug.warn('deployments', 'Could not stop the log stream:', error);
		}
	},

	/**
	 * Run an outward-facing action.
	 *
	 * The caller has already confirmed with the user — this function does not
	 * ask, and must not be wired to anything that has not. The result is
	 * reported verbatim, including `pending`, because a rollback that Vercel has
	 * merely accepted is not a rollback that has happened.
	 */
	async runAction(action: DeployAction, deploymentId: string): Promise<void> {
		const source = currentSource();
		if (!state.projectId || !source) return;

		state.busyAction = action;
		try {
			const result = await ws.http('deployments:action', {
				projectId: state.projectId,
				accountId: source.accountId,
				deploymentId,
				action
			});

			if (result.status === 'pending') {
				showInfo('Deployments', result.message);
				// Not awaited: the dialog should close now, and the outcome arrives
				// when the provider gets there.
				void this.followAliasRequest();
			} else {
				showSuccess('Deployments', result.message);
			}

			// A deleted deployment cannot be shown, and a redeploy produces a new
			// build worth watching — either way the selection has to move.
			if (action === 'delete' && state.selectedId === deploymentId) {
				await this.select(null);
			}
			await this.refresh({ quiet: true });
			if (result.deploymentId) await this.select(result.deploymentId);
		} catch (error) {
			showError('Deployments', error instanceof Error ? error.message : String(error));
		} finally {
			state.busyAction = null;
		}
	},

	/**
	 * Send a failed build's log into the chat.
	 *
	 * The server assembles the text and hands it BACK; the browser sends it.
	 * The chat pipeline is browser-owned, and a second injection path on the
	 * server would race the one that already exists.
	 */
	async sendLogsToChat(deploymentId: string): Promise<void> {
		const source = currentSource();
		if (!state.projectId || !source) return;

		state.isSendingLogs = true;
		try {
			const { prompt } = await ws.http('deployments:send-logs', {
				projectId: state.projectId,
				accountId: source.accountId,
				deploymentId
			});

			// The chat lives in the workspace, so this is a relocation when the
			// surface is looking somewhere else.
			await relocateIfNeeded(state.projectId);

			closeDeploymentsDialog();
			showPanel('chat');
			await chatService.sendMessage(prompt);
		} catch (error) {
			showError('Deployments', error instanceof Error ? error.message : String(error));
		} finally {
			state.isSendingLogs = false;
		}
	},

	/** What the deploy dialog needs, fetched when it opens. */
	async loadDeployInfo(options: { force?: boolean } = {}): Promise<void> {
		const source = currentSource();
		if (!state.projectId || !source) return;

		// Reopening the dialog on the same account shows what it showed last
		// time, immediately, and refreshes underneath. The first version spun a
		// bare spinner on every open while three provider requests went out.
		const key = `${state.projectId}:${source.accountId}`;
		if (!options.force && state.deployInfoKey === key && state.deployInfo) {
			void this.refreshDeployInfo(key, source.accountId);
			return;
		}

		state.deployInfo = null;
		state.isLoadingDeployInfo = true;
		await this.refreshDeployInfo(key, source.accountId);
	},

	/** The fetch itself, shared by the cached and uncached paths. */
	async refreshDeployInfo(key: string, accountId: string): Promise<void> {
		if (!state.projectId) return;
		try {
			const info = await ws.http(
				'deployments:deploy-info',
				{ projectId: state.projectId, accountId },
				SLOW_CALL_TIMEOUT_MS
			);
			state.deployInfo = info;
			state.deployInfoKey = key;
		} catch (error) {
			showError('Deployments', error instanceof Error ? error.message : String(error));
		} finally {
			state.isLoadingDeployInfo = false;
		}
	},

	/**
	 * Start a new build.
	 *
	 * The dialog that calls this IS the confirmation — it names the branch and
	 * the environment and makes production the deliberate choice — so this does
	 * not ask again. Failures are not caught here: the dialog renders them
	 * inline so the branch can be corrected without retyping it.
	 */
	async deploy(ref: string, production: boolean): Promise<void> {
		const source = currentSource();
		if (!state.projectId || !source) return;

		state.isDeploying = true;
		try {
			const result = await ws.http(
				'deployments:deploy',
				{ projectId: state.projectId, accountId: source.accountId, ref, production },
				SLOW_CALL_TIMEOUT_MS
			);
			showSuccess('Deployments', result.message);

			await this.refresh({ quiet: true });
			if (result.deploymentId) await this.select(result.deploymentId);
		} finally {
			state.isDeploying = false;
		}
	},

	/**
	 * Attach a git repository to the bound remote project.
	 *
	 * Deliberately NOT caught here. The dialog renders the failure inline,
	 * because the message carries a URL the user has to click and a toast takes
	 * it away before they can.
	 */
	async connectRepository(gitRepo: string, gitProvider: string | null): Promise<void> {
		const source = currentSource();
		if (!state.projectId || !source) return;

		await ws.http(
			'deployments:connect-repo',
			{ projectId: state.projectId, accountId: source.accountId, gitRepo, gitProvider },
			SLOW_CALL_TIMEOUT_MS
		);
		showSuccess('Deployments', `${gitRepo} connected. Pushes to it will deploy from now on.`);
		await this.loadDeployInfo({ force: true });
	},

	/** Whether a repository could be attached, asked before anything offers it. */
	repoAccess(gitRepo: string): Promise<{ state: string; reason: string | null; actionUrl: string | null }> {
		const source = currentSource();
		if (!state.projectId || !source) {
			return Promise.resolve({ state: 'unknown', reason: null, actionUrl: null });
		}
		return ws.http(
			'deployments:repo-access',
			{ projectId: state.projectId, accountId: source.accountId, gitRepo },
			SLOW_CALL_TIMEOUT_MS
		);
	},

	/** Defaults for the new-project form, read from the local project. */
	newProjectDefaults(): Promise<NewProjectDefaults> {
		return ws.http('deployments:new-project-defaults', {
			...(state.projectId && { projectId: state.projectId })
		});
	},

	/**
	 * Create a remote project and point this one at it.
	 *
	 * The binding happens server-side, so this only has to reload — which is
	 * what turns "no deploy target is connected" into a working panel in one
	 * step rather than two.
	 */
	async createProject(draft: {
		name: string;
		gitRepo: string | null;
		gitProvider: string | null;
		framework: string | null;
	}): Promise<void> {
		const source = currentSource();
		if (!state.projectId || !source) return;

		const target = await ws.http(
			'deployments:create-project',
			{
				projectId: state.projectId,
				accountId: source.accountId,
				name: draft.name,
				gitRepo: draft.gitRepo,
				gitProvider: draft.gitProvider,
				framework: draft.framework
			},
			SLOW_CALL_TIMEOUT_MS
		);
		showSuccess('Deployments', `${target.name} created and linked to this project.`);
		state.targets = [];
		state.deployInfoKey = null;
		await this.loadSources();
	},

	/** Drop every narrowing, for the empty state's way out. */
	clearFilters(): void {
		state.environment = 'all';
		state.branch = '';
		void this.loadList();
	},

	/** Project-level state: paused, and any traffic move still in flight. */
	async loadProjectStatus(): Promise<void> {
		const source = currentSource();
		if (!state.projectId || !source?.binding) return;

		try {
			state.projectStatus = await ws.http('deployments:project-status', {
				projectId: state.projectId,
				accountId: source.accountId
			});
		} catch (error) {
			debug.warn('deployments', 'Could not read project status:', error);
		}
	},

	/**
	 * Watch a rollback or promotion through to its outcome.
	 *
	 * Those actions return as soon as the provider ACCEPTS them — traffic moves
	 * seconds later — so reporting `pending` and stopping there left the user
	 * with no way to learn whether it worked. Bounded, because a request that
	 * never settles must not poll forever.
	 */
	async followAliasRequest(): Promise<void> {
		for (let attempt = 0; attempt < 10; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 3000));
			if (!state.isActive) return;

			await this.loadProjectStatus();
			const request = state.projectStatus?.aliasRequest;
			if (!request || request.status === 'pending' || request.status === 'in-progress') continue;

			if (request.status === 'succeeded') {
				showSuccess(
					'Deployments',
					request.type === 'rollback' ? 'Rollback complete — production has moved.' : 'Promotion complete.'
				);
			} else {
				showError('Deployments', `The ${request.type} did not complete (${request.status}).`);
			}
			await this.refresh({ quiet: true });
			return;
		}
	},

	async loadTargets(): Promise<void> {
		const source = currentSource();
		if (!state.projectId || !source) return;

		state.isLoadingTargets = true;
		try {
			// Lists every project in every team, so several provider requests deep.
			state.targets = await ws.http(
				'deployments:targets',
				{ projectId: state.projectId, accountId: source.accountId },
				SLOW_CALL_TIMEOUT_MS
			);
		} catch (error) {
			showError('Deployments', error instanceof Error ? error.message : String(error));
		} finally {
			state.isLoadingTargets = false;
		}
	},

	async setBinding(target: DeployTarget): Promise<void> {
		const source = currentSource();
		if (!state.projectId || !source) return;

		try {
			await ws.http('deployments:set-binding', {
				projectId: state.projectId,
				accountId: source.accountId,
				locator: target.id,
				teamId: target.teamId
			});
			await this.loadSources();
		} catch (error) {
			showError('Deployments', error instanceof Error ? error.message : String(error));
		}
	},

	async setConfig(config: DeployBindingConfig): Promise<void> {
		const source = currentSource();
		if (!state.projectId || !source) return;

		try {
			await ws.http('deployments:set-config', {
				projectId: state.projectId,
				accountId: source.accountId,
				config
			});
			await this.loadSources();
		} catch (error) {
			showError('Deployments', error instanceof Error ? error.message : String(error));
		}
	}
};
