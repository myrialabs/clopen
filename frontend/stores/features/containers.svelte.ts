/**
 * Container manager store — what is running, on whichever host is selected.
 *
 * The server owns the list and pushes it; this owns which host is being looked
 * at, which of the three lists is on screen, what is selected, and the sidebar
 * count. Watching is explicit on both ends: opening a host asks the server to
 * watch it, and leaving stops it, so no host is polled for a view nobody has
 * open.
 *
 * One store serves both places containers are shown — the Containers panel for
 * this machine and the SSH Client's Containers tab for a saved host. `local` is
 * not a special case here; it is just the host whose id happens to be `local`.
 */

import { debug } from '$shared/utils/logger';
import ws, { onWsReconnect } from '$frontend/utils/ws';
import { showError, showSuccess } from '$frontend/stores/ui/notification.svelte';
import { SvelteSet } from 'svelte/reactivity';
import type {
	ContainerAction,
	ContainerDetail,
	ContainerDiskUsage,
	ContainerEntry,
	ContainerImageEntry,
	ContainerLogChunk,
	ContainerNetworkEntry,
	RemovableResourceKind,
	ContainerScanResult,
	ContainerState,
	ContainerStats,
	ContainerVolumeEntry,
	PruneKind,
	PruneJob
} from '$shared/types/containers';
import {
	CONTAINER_LOG_BUFFER_LINES,
	CONTAINER_TIMEOUTS,
	LOCAL_CONTAINER_HOST,
	TRANSPORT_GRACE_MS
} from '$shared/types/containers';

/** The four lists a host offers. Containers is the point; the rest is context. */
export type ContainerTab = 'containers' | 'images' | 'volumes' | 'networks';

/** What fills the pane: the lists, or one container's logs or shell. */
export type ContainerView = 'list' | 'logs' | 'shell';

/**
 * Rows are grouped by whether they are doing anything. It is the split every
 * other question follows from — what is up, and what could be brought up.
 */
export const STATE_GROUPS: Array<{
	id: 'running' | 'stopped';
	title: string;
	blurb: string;
	states: ContainerState[];
}> = [
	{
		id: 'running',
		title: 'Running',
		blurb: 'Containers doing something right now',
		states: ['running', 'paused', 'restarting']
	},
	{
		id: 'stopped',
		title: 'Not running',
		blurb: 'Stopped, created, or gone wrong',
		states: ['created', 'exited', 'dead', 'removing', 'unknown']
	}
];

interface LogState {
	streamId: string | null;
	hostId: string;
	containerId: string;
	containerName: string;
	lines: string[];
	/** Set when the stream ended on its own — the container stopped, or an error. */
	ended: string | null;
	starting: boolean;
	error: string | null;
	/** Paused only stops the view from following; the stream keeps buffering. */
	paused: boolean;
}

interface ContainersState {
	/** The host being watched: `local`, or an SSH connection id. */
	activeHostId: string;
	/** Latest listing per host, so switching back is instant. */
	results: Record<string, ContainerScanResult>;
	/** Hosts this client has asked the server to watch. */
	watching: SvelteSet<string>;
	search: string;
	tab: ContainerTab;
	view: ContainerView;
	/** Groups the user has collapsed, remembered while the panel is open. */
	collapsed: SvelteSet<string>;
	selectedId: string | null;
	/** Detail from `inspect`, per container, fetched when a pane opens. */
	details: Record<string, ContainerDetail>;
	detailLoading: boolean;
	/** True when the server withheld environment values from this member. */
	envRedacted: boolean;
	badge: number;
	isLoading: boolean;
	error: string | null;
	/** Container or resource currently being acted on, so its row can show it. */
	actingId: string | null;
	/** One live sample per container, read on demand rather than polled. */
	stats: Record<string, ContainerStats>;
	statsLoading: string | null;
	/** The last reading the server had for the active host, however old. */
	diskUsage: ContainerDiskUsage | null;
	/** Set while the server is walking the disk for a fresh reading. */
	diskUsageMeasuring: boolean;
	/**
	 * The host's clean-up sweep, as the server reports it. Server-owned so that
	 * closing the dialog, refreshing, or opening the panel on a second device
	 * cannot lose track of a sweep that is still deleting.
	 */
	pruneJob: PruneJob | null;
	logs: LogState | null;
	/** The container whose shell is open, kept so the tab can be returned to. */
	shellId: string | null;
}

const state = $state<ContainersState>({
	activeHostId: LOCAL_CONTAINER_HOST,
	results: {},
	watching: new SvelteSet(),
	search: '',
	tab: 'containers',
	view: 'list',
	collapsed: new SvelteSet(),
	selectedId: null,
	details: {},
	detailLoading: false,
	envRedacted: false,
	badge: 0,
	isLoading: false,
	error: null,
	actingId: null,
	stats: {},
	statsLoading: null,
	diskUsage: null,
	diskUsageMeasuring: false,
	pruneJob: null,
	logs: null,
	shellId: null
});

/**
 * How long to wait on a request, given what the command behind it may take.
 *
 * The command's own budget plus a margin, so the command is always the thing
 * that gives up first. A transport that times out earlier does not cancel
 * anything — the daemon keeps stopping the container, keeps deleting the
 * volumes — it just guarantees nobody is told how it went. That is how a prune
 * that worked comes back as six failures.
 */
function requestBudget(kind: keyof typeof CONTAINER_TIMEOUTS): number {
	return CONTAINER_TIMEOUTS[kind] + TRANSPORT_GRACE_MS;
}

function matchesContainer(entry: ContainerEntry, needle: string): boolean {
	if (!needle) return true;
	return [
		entry.name,
		entry.image,
		entry.shortId,
		entry.state,
		entry.statusText,
		entry.composeProject ?? '',
		entry.composeService ?? '',
		entry.command ?? '',
		...entry.ports.map((port) => `${port.hostPort ?? ''}:${port.containerPort}`)
	]
		.join(' ')
		.toLowerCase()
		.includes(needle);
}

/** A name that is 64 hex characters is one the runtime invented, not a user. */
export function isAnonymousVolume(volume: ContainerVolumeEntry): boolean {
	return /^[a-f0-9]{64}$/i.test(volume.name);
}

export const containersStore = {
	get activeHostId(): string {
		return state.activeHostId;
	},
	get result(): ContainerScanResult | null {
		return state.results[state.activeHostId] ?? null;
	},
	get search(): string {
		return state.search;
	},
	set search(value: string) {
		state.search = value;
	},
	get tab(): ContainerTab {
		return state.tab;
	},
	set tab(value: ContainerTab) {
		state.tab = value;
	},
	get view(): ContainerView {
		return state.view;
	},
	get isLoading(): boolean {
		return state.isLoading;
	},
	get error(): string | null {
		return state.error;
	},
	get actingId(): string | null {
		return state.actingId;
	},
	get selectedId(): string | null {
		return state.selectedId;
	},
	get detailLoading(): boolean {
		return state.detailLoading;
	},
	get envRedacted(): boolean {
		return state.envRedacted;
	},
	get logs(): LogState | null {
		return state.logs;
	},
	get shellId(): string | null {
		return state.shellId;
	},

	/** The sidebar count: containers running on this machine. */
	get liveCount(): number {
		return state.badge;
	},

	get entries(): ContainerEntry[] {
		const needle = state.search.trim().toLowerCase();
		return (this.result?.entries ?? []).filter((entry) => matchesContainer(entry, needle));
	},

	/** Rows in display order, split into running and everything else. */
	get groups(): Array<{ id: string; title: string; blurb: string; entries: ContainerEntry[] }> {
		const entries = this.entries;
		return STATE_GROUPS.map((group) => ({
			id: group.id,
			title: group.title,
			blurb: group.blurb,
			entries: entries.filter((entry) => group.states.includes(entry.state))
		}));
	},

	get images(): ContainerImageEntry[] {
		const needle = state.search.trim().toLowerCase();
		return (this.result?.images ?? []).filter((image) =>
			`${image.repository}:${image.tag} ${image.id} ${image.usedBy.join(' ')}`
				.toLowerCase()
				.includes(needle)
		);
	},

	get volumes(): ContainerVolumeEntry[] {
		const needle = state.search.trim().toLowerCase();
		return (this.result?.volumes ?? []).filter((volume) =>
			`${volume.name} ${volume.driver} ${volume.mountpoint ?? ''} ${volume.usedBy.join(' ')}`
				.toLowerCase()
				.includes(needle)
		);
	},

	get networks(): ContainerNetworkEntry[] {
		const needle = state.search.trim().toLowerCase();
		return (this.result?.networks ?? []).filter((network) =>
			`${network.name} ${network.driver} ${network.scope} ${network.usedBy.join(' ')}`
				.toLowerCase()
				.includes(needle)
		);
	},

	get diskUsage(): ContainerDiskUsage | null {
		return state.diskUsage;
	},
	get diskUsageMeasuring(): boolean {
		return state.diskUsageMeasuring;
	},
	get pruneJob(): PruneJob | null {
		return state.pruneJob;
	},

	/** True while this host's sweep is still running. */
	get pruning(): boolean {
		return state.pruneJob !== null && state.pruneJob.finishedAt === null;
	},
	get statsLoading(): string | null {
		return state.statsLoading;
	},

	statsFor(containerId: string): ContainerStats | null {
		return state.stats[containerId] ?? null;
	},

	get selected(): ContainerEntry | null {
		if (!state.selectedId) return null;
		return (this.result?.entries ?? []).find((entry) => entry.id === state.selectedId) ?? null;
	},

	/** The container whose shell is open, as long as it is still on this host. */
	get shellContainer(): ContainerEntry | null {
		if (!state.shellId) return null;
		return (this.result?.entries ?? []).find((entry) => entry.id === state.shellId) ?? null;
	},

	detailFor(containerId: string): ContainerDetail | null {
		return state.details[containerId] ?? null;
	},

	isCollapsed(groupId: string): boolean {
		return state.collapsed.has(groupId);
	},

	toggleGroup(groupId: string): void {
		if (state.collapsed.has(groupId)) state.collapsed.delete(groupId);
		else state.collapsed.add(groupId);
	},

	select(containerId: string | null): void {
		state.selectedId = state.selectedId === containerId ? null : containerId;
		if (state.selectedId) void this.loadDetail(state.selectedId);
	},

	/**
	 * Open a host: start the server watching it and show its first listing.
	 *
	 * Only one host is watched at a time. Leaving a host stops its polling —
	 * an SSH host in particular should not keep costing a listing every few
	 * seconds for a tab that is no longer on screen — while its last result
	 * stays cached, so coming back renders immediately and then refreshes.
	 */
	async watch(hostId: string): Promise<void> {
		const previous = state.activeHostId;
		state.activeHostId = hostId;
		state.error = null;
		if (previous !== hostId) {
			state.selectedId = null;
			state.view = 'list';
			state.shellId = null;
			await this.stopLogs();
			await this.unwatch(previous);
		}
		if (state.watching.has(hostId)) return;

		state.isLoading = !state.results[hostId];
		try {
			const response = (await ws.http('containers:watch', { hostId }, requestBudget('scan'))) as {
				result: ContainerScanResult;
			};
			state.watching.add(hostId);
			state.results[hostId] = response.result;
			state.error = response.result.error;
		} catch (error) {
			debug.warn('containers', `Could not watch ${hostId}:`, error);
			state.error = error instanceof Error ? error.message : String(error);
		} finally {
			state.isLoading = false;
		}
	},

	/** Stop watching one host, leaving its last listing cached for a quick return. */
	async unwatch(hostId: string): Promise<void> {
		if (!state.watching.has(hostId)) return;
		state.watching.delete(hostId);
		try {
			await ws.http('containers:unwatch', { hostId });
		} catch (error) {
			debug.warn('containers', `Could not unwatch ${hostId}:`, error);
		}
	},

	/** Everything `inspect` knows, fetched once per container per open. */
	async loadDetail(containerId: string): Promise<void> {
		state.detailLoading = true;
		try {
			const response = (await ws.http(
				'containers:inspect',
				{ hostId: state.activeHostId, containerId },
				requestBudget('inspect')
			)) as { detail: ContainerDetail | null; envRedacted: boolean };
			if (response.detail) state.details[containerId] = response.detail;
			state.envRedacted = response.envRedacted === true;
		} catch (error) {
			debug.warn('containers', `Could not inspect ${containerId}:`, error);
		} finally {
			state.detailLoading = false;
		}
	},

	/**
	 * Start, stop or restart a container. The server re-reads the host before
	 * acting, so the row only has to name itself.
	 */
	async act(
		entry: ContainerEntry,
		action: ContainerAction
	): Promise<{ ok: boolean; error: string | null }> {
		state.actingId = entry.id;
		try {
			const response = (await ws.http(
				'containers:action',
				{ hostId: state.activeHostId, containerId: entry.id, action },
				requestBudget('action')
			)) as { result: { ok: boolean; error: string | null }; gone: boolean };

			if (response.gone) return { ok: false, error: 'That container is no longer on this host.' };
			return response.result;
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			state.actingId = null;
		}
	},

	/**
	 * Remove an image, a volume or a network. The runtime refuses anything still
	 * in use and that refusal is passed straight back, so a volume a running
	 * container has mounted survives a mis-click.
	 */
	async removeResource(
		kind: RemovableResourceKind,
		id: string,
		force = false
	): Promise<{ ok: boolean; error: string | null }> {
		state.actingId = id;
		try {
			const response = (await ws.http(
				'containers:remove',
				{ hostId: state.activeHostId, kind, id, force },
				requestBudget('action')
			)) as { result: { ok: boolean; error: string | null } };
			return response.result;
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			state.actingId = null;
		}
	},

	/**
	 * Start a sweep, and stop caring whether this dialog is still open.
	 *
	 * Returns once the server has the job, not once the sweep is done — a prune
	 * runs for minutes. The result arrives on `containers:prune-changed`, which
	 * is handled in the store rather than in the dialog precisely because the
	 * dialog may be gone by then.
	 */
	async prune(kinds: PruneKind[]): Promise<void> {
		const hostId = state.activeHostId;
		try {
			const response = (await ws.http('containers:prune', { hostId, kinds })) as {
				job: PruneJob;
			};
			if (hostId === state.activeHostId) state.pruneJob = response.job;
		} catch (error) {
			debug.warn('containers', 'Could not start the clean-up:', error);
			showError(
				'Could not start the clean-up',
				error instanceof Error ? error.message : String(error)
			);
		}
	},

	/**
	 * Attach to whatever sweep this host has, running or just finished.
	 *
	 * Read whenever the panel opens: the sweep belongs to the host, so one
	 * started before a refresh — or from another device — has to be found rather
	 * than assumed absent.
	 */
	async loadPruneStatus(): Promise<void> {
		const hostId = state.activeHostId;
		try {
			const response = (await ws.http('containers:prune-status', { hostId })) as {
				job: PruneJob | null;
			};
			if (hostId === state.activeHostId) state.pruneJob = response.job;
		} catch (error) {
			debug.warn('containers', 'Could not read the clean-up status:', error);
		}
	},

	/** Acknowledge a finished sweep, so its report stops being offered. */
	async dismissPrune(): Promise<void> {
		if (this.pruning) return;
		const hostId = state.activeHostId;
		state.pruneJob = null;
		try {
			await ws.http('containers:prune-dismiss', { hostId });
		} catch (error) {
			debug.warn('containers', 'Could not dismiss the clean-up report:', error);
		}
	},

	/**
	 * What this host is holding, and how much of it it could give back.
	 *
	 * Returns as soon as the server has answered with whatever it last measured,
	 * which is usually instant and may be nothing at all on a first open. The
	 * measurement itself is not awaited — `system df` takes as long as the host's
	 * disk is large, over a minute on a machine with a few hundred volumes — so
	 * it arrives later on `containers:disk-usage-measured`.
	 */
	async loadDiskUsage(force = false): Promise<void> {
		const hostId = state.activeHostId;
		try {
			const response = (await ws.http('containers:disk-usage', { hostId, force })) as {
				usage: ContainerDiskUsage | null;
				measuring: boolean;
			};
			// The dialog can be closed and another host opened while this is in
			// flight; a reading belongs to the host it was asked for.
			if (hostId !== state.activeHostId) return;
			state.diskUsage = response.usage;
			state.diskUsageMeasuring = response.measuring;
		} catch (error) {
			debug.warn('containers', 'Could not read disk usage:', error);
			if (hostId !== state.activeHostId) return;
			state.diskUsage = {
				rows: [],
				error: error instanceof Error ? error.message : String(error),
				measuredAt: null
			};
			state.diskUsageMeasuring = false;
		}
	},

	/** One sample of what a container is consuming, when the pane asks for it. */
	async loadStats(containerId: string): Promise<void> {
		state.statsLoading = containerId;
		try {
			const response = (await ws.http(
				'containers:stats',
				{
					hostId: state.activeHostId,
					containerId
				},
				requestBudget('stats')
			)) as { stats: ContainerStats | null };
			if (response.stats) state.stats[containerId] = response.stats;
		} catch (error) {
			debug.warn('containers', `Could not read stats for ${containerId}:`, error);
		} finally {
			state.statsLoading = null;
		}
	},

	// -- logs ----------------------------------------------------------------

	/** Follow a container's output, replacing whatever was being followed. */
	async startLogs(entry: ContainerEntry): Promise<void> {
		await this.stopLogs();

		state.logs = {
			streamId: null,
			hostId: state.activeHostId,
			containerId: entry.id,
			containerName: entry.name,
			lines: [],
			ended: null,
			starting: true,
			error: null,
			paused: false
		};
		state.view = 'logs';

		try {
			const response = (await ws.http('containers:logs-start', {
				hostId: state.activeHostId,
				containerId: entry.id
			})) as { streamId: string; backlog: string };

			if (!state.logs || state.logs.containerId !== entry.id) return;
			state.logs.streamId = response.streamId;
			state.logs.starting = false;
			if (response.backlog) appendLogText(state.logs, response.backlog);
		} catch (error) {
			if (!state.logs) return;
			state.logs.starting = false;
			state.logs.error = error instanceof Error ? error.message : String(error);
		}
	},

	async stopLogs(): Promise<void> {
		const logs = state.logs;
		state.logs = null;
		if (!logs?.streamId) return;
		try {
			await ws.http('containers:logs-stop', { streamId: logs.streamId });
		} catch (error) {
			debug.warn('containers', 'Could not stop the log stream:', error);
		}
	},

	togglePause(): void {
		if (state.logs) state.logs.paused = !state.logs.paused;
	},

	clearLogs(): void {
		if (state.logs) state.logs.lines = [];
	},

	// -- views ---------------------------------------------------------------

	/** Open the shell for a container, which is the pane's other full view. */
	openShell(entry: ContainerEntry): void {
		state.shellId = entry.id;
		state.view = 'shell';
	},

	/** Back to the lists. The shell keeps running; the log stream does not. */
	closeView(): void {
		if (state.view === 'logs') void this.stopLogs();
		state.view = 'list';
	},

	/** Leave the shell open but go back to the lists, keeping the session alive. */
	showList(): void {
		state.view = 'list';
	},

	reopenShell(): void {
		if (state.shellId) state.view = 'shell';
	},

	closeShell(): void {
		state.shellId = null;
		state.view = 'list';
	},

	/**
	 * Point the panel at one container, used by the cross-link from Ports.
	 *
	 * Goes through `watch` rather than setting the host directly: the panel this
	 * opens will ask to watch the host anyway, and assigning it here would make
	 * that call believe the host had not changed — leaving the previous one
	 * polling on the server with nothing on screen.
	 */
	focus(hostId: string, containerId: string): void {
		void (async () => {
			// A leftover search would filter the row out of the list the moment
			// it is selected, which reads as the jump having done nothing.
			state.search = '';
			await this.watch(hostId);
			state.tab = 'containers';
			state.view = 'list';
			state.selectedId = containerId;
			await this.loadDetail(containerId);
		})();
	},

	// -- realtime ------------------------------------------------------------

	/** Ask for the current count, which pushes alone cannot deliver on load. */
	async loadBadge(): Promise<void> {
		try {
			const response = (await ws.http('containers:summary', {})) as { count: number };
			state.badge = typeof response?.count === 'number' ? response.count : 0;
		} catch (error) {
			debug.warn('containers', 'Could not read the container count:', error);
		}
	},

	/**
	 * Subscribe to pushed listings, log output and the sidebar count. Call once
	 * on app mount: the badge arrives whether or not the panel has ever been
	 * opened.
	 */
	initRealtimeListener(): () => void {
		const cleanupChanged = ws.on('containers:changed', (data: { result: ContainerScanResult }) => {
			if (!data?.result) return;
			state.results[data.result.hostId] = data.result;
			if (data.result.hostId === state.activeHostId) state.error = data.result.error;
		});

		const cleanupBadge = ws.on('containers:badge', (data: { count: number }) => {
			state.badge = typeof data?.count === 'number' ? data.count : 0;
		});

		/**
		 * A sweep reaching its end.
		 *
		 * Reported here rather than in the dialog because the dialog is exactly
		 * what may not exist any more: a sweep runs for minutes and the modal that
		 * started it is often long closed. The toast is how someone who walked
		 * away finds out, and the figures are re-read because a sweep is the one
		 * thing that certainly moved them.
		 */
		const cleanupPrune = ws.on('containers:prune-changed', (data: { job: PruneJob }) => {
			const job = data?.job;
			if (!job) return;
			// The store mirrors one host, so only that host's job is held here — but
			// being told a sweep finished is not state, and a sweep on the host you
			// are not currently looking at is exactly the one you would otherwise
			// never hear about.
			if (job.hostId === state.activeHostId) {
				state.pruneJob = job;
				void containersStore.loadDiskUsage(true);
			}

			const outcomes = job.outcomes ?? [];
			const failed = outcomes.filter((outcome) => !outcome.ok);
			if (failed.length > 0) {
				showError(
					'Some sweeps failed',
					failed.map((outcome) => `${outcome.kind}: ${outcome.error}`).join('\n')
				);
				return;
			}
			const reclaimed = outcomes
				.map((outcome) => outcome.reclaimed)
				.filter((value): value is string => value !== null);
			showSuccess(
				'Cleaned up',
				reclaimed.length > 0 ? `Reclaimed ${reclaimed.join(' + ')}.` : 'The host is tidy.'
			);
		});

		// The disk reading, whenever the server finishes walking the disk for it.
		const cleanupDiskUsage = ws.on(
			'containers:disk-usage-measured',
			(data: { hostId: string; usage: ContainerDiskUsage }) => {
				if (!data?.usage || data.hostId !== state.activeHostId) return;
				state.diskUsage = data.usage;
				state.diskUsageMeasuring = false;
			}
		);

		const cleanupLogs = ws.on('containers:log-chunk', (chunk: ContainerLogChunk) => {
			const logs = state.logs;
			if (!logs || !chunk || chunk.streamId !== logs.streamId) return;
			if (chunk.data) appendLogText(logs, chunk.data);
			if (chunk.done) {
				logs.ended = chunk.error ?? 'The stream ended.';
				logs.streamId = null;
			}
		});

		// A watch lives on the socket that asked for it, so a reconnect leaves the
		// server watching nothing while this side still believes it is. Without
		// re-asking, the list would sit there looking live and never change again.
		const cleanupReconnect = onWsReconnect(() => {
			const wasWatching = state.watching.size > 0;
			state.watching.clear();
			void containersStore.loadBadge();
			if (!wasWatching) return;
			void containersStore.watch(state.activeHostId);
		});

		// The count is state, not an event, so it is read on load rather than
		// waited for — a refreshed page must not sit at zero until it changes.
		void containersStore.loadBadge();

		return () => {
			cleanupChanged();
			cleanupBadge();
			cleanupPrune();
			cleanupDiskUsage();
			cleanupLogs();
			cleanupReconnect();
		};
	}
};

/**
 * Append output, keeping the view's buffer bounded the same way the server's
 * is. A container writing a megabyte a second would otherwise turn a log view
 * into an out-of-memory crash in the browser rather than on the host.
 */
function appendLogText(logs: LogState, text: string): void {
	const pieces = text.split('\n');
	const last = logs.lines.length - 1;
	// The first piece continues whatever line the previous chunk left open.
	if (last >= 0) logs.lines[last] += pieces.shift() ?? '';
	for (const piece of pieces) logs.lines.push(piece);
	if (logs.lines.length > CONTAINER_LOG_BUFFER_LINES) {
		logs.lines.splice(0, logs.lines.length - CONTAINER_LOG_BUFFER_LINES);
	}
}
