/**
 * Port manager store — what is listening, on whichever host is selected.
 *
 * The server owns the tables and pushes them; this owns which host is being
 * looked at, how the rows are filtered, and the sidebar count. Watching is
 * explicit on both ends: opening a host asks the server to watch it, and
 * leaving stops it, so no host is polled for a view nobody has open.
 *
 * One store serves both places ports are shown — the Ports panel for this
 * machine, and the SSH Client's Ports tab for a host. `local` is not a special
 * case here; it is just the host whose id happens to be `local`.
 */

import { debug } from '$shared/utils/logger';
import ws, { onWsReconnect } from '$frontend/utils/ws';
import { SvelteSet } from 'svelte/reactivity';
import type { PortEntry, PortOriginKind, PortScanResult } from '$shared/types/ports';
import { LOCAL_PORT_HOST } from '$shared/types/ports';

/** Rows are grouped by where they came from, most explicable first. */
export const ORIGIN_GROUPS: Array<{ kind: PortOriginKind; title: string; blurb: string }> = [
	{ kind: 'clopen', title: 'Opened by Clopen', blurb: 'Listeners Clopen is responsible for' },
	{ kind: 'session', title: 'Started from Clopen', blurb: 'Terminals, engines, and anything they launched' },
	{ kind: 'external', title: 'Outside Clopen', blurb: 'Everything else on this host' }
];

interface PortsState {
	/** The host being watched: `local`, or an SSH connection id. */
	activeHostId: string;
	/** Latest table per host, so switching back is instant. */
	results: Record<string, PortScanResult>;
	/** Hosts this client has asked the server to watch. */
	watching: SvelteSet<string>;
	search: string;
	/** Groups the user has collapsed, remembered while the panel is open. */
	collapsed: SvelteSet<PortOriginKind>;
	selectedKey: string | null;
	badge: number;
	isLoading: boolean;
	error: string | null;
	/** Entry key currently being stopped, so its row can show progress. */
	killingKey: string | null;
}

const state = $state<PortsState>({
	activeHostId: LOCAL_PORT_HOST,
	results: {},
	watching: new SvelteSet(),
	search: '',
	collapsed: new SvelteSet(),
	selectedKey: null,
	badge: 0,
	isLoading: false,
	error: null,
	killingKey: null
});

function matches(entry: PortEntry, needle: string): boolean {
	if (!needle) return true;
	const haystack = [
		String(entry.port),
		entry.protocol,
		entry.origin.label,
		entry.origin.detail ?? '',
		entry.process?.command ?? '',
		entry.process?.user ?? '',
		entry.process?.cwd ?? '',
		entry.pid === null ? '' : String(entry.pid),
		...entry.addresses
	]
		.join(' ')
		.toLowerCase();
	return haystack.includes(needle);
}

export const portsStore = {
	get activeHostId(): string {
		return state.activeHostId;
	},
	get result(): PortScanResult | null {
		return state.results[state.activeHostId] ?? null;
	},
	get search(): string {
		return state.search;
	},
	set search(value: string) {
		state.search = value;
	},
	get isLoading(): boolean {
		return state.isLoading;
	},
	get error(): string | null {
		return state.error;
	},
	get killingKey(): string | null {
		return state.killingKey;
	},
	get selectedKey(): string | null {
		return state.selectedKey;
	},

	/** The sidebar count: ports born in a Clopen terminal on this machine. */
	get liveCount(): number {
		return state.badge;
	},

	get entries(): PortEntry[] {
		const needle = state.search.trim().toLowerCase();
		return (this.result?.entries ?? []).filter((entry) => matches(entry, needle));
	},

	/** Rows in display order, split into the three origin groups. */
	get groups(): Array<{ kind: PortOriginKind; title: string; blurb: string; entries: PortEntry[] }> {
		const entries = this.entries;
		return ORIGIN_GROUPS.map((group) => ({
			...group,
			entries: entries.filter((entry) => entry.origin.kind === group.kind)
		}));
	},

	get selected(): PortEntry | null {
		if (!state.selectedKey) return null;
		return (this.result?.entries ?? []).find((entry) => entry.key === state.selectedKey) ?? null;
	},

	isCollapsed(kind: PortOriginKind): boolean {
		return state.collapsed.has(kind);
	},

	toggleGroup(kind: PortOriginKind): void {
		if (state.collapsed.has(kind)) state.collapsed.delete(kind);
		else state.collapsed.add(kind);
	},

	select(key: string | null): void {
		state.selectedKey = state.selectedKey === key ? null : key;
	},

	/**
	 * Open a host: start the server watching it and show its first table.
	 *
	 * Only one host is watched at a time. Leaving a host stops its polling —
	 * an SSH host in particular should not keep costing a scan per second for a
	 * tab that is no longer on screen — while its last table stays cached, so
	 * coming back renders immediately and then refreshes.
	 */
	async watch(hostId: string): Promise<void> {
		const previous = state.activeHostId;
		state.activeHostId = hostId;
		state.selectedKey = null;
		state.error = null;
		if (previous !== hostId) await this.unwatch(previous);
		if (state.watching.has(hostId)) return;

		state.isLoading = !state.results[hostId];
		try {
			const response = (await ws.http('ports:watch', { hostId })) as { result: PortScanResult };
			state.watching.add(hostId);
			state.results[hostId] = response.result;
			if (response.result.error) state.error = response.result.error;
		} catch (error) {
			debug.warn('ports', `Could not watch ${hostId}:`, error);
			state.error = error instanceof Error ? error.message : String(error);
		} finally {
			state.isLoading = false;
		}
	},

	/** Stop watching one host, leaving its last table cached for a quick return. */
	async unwatch(hostId: string): Promise<void> {
		if (!state.watching.has(hostId)) return;
		state.watching.delete(hostId);
		try {
			await ws.http('ports:unwatch', { hostId });
		} catch (error) {
			debug.warn('ports', `Could not unwatch ${hostId}:`, error);
		}
	},

	/**
	 * Stop whatever holds a port. The server re-scans before acting, so the row
	 * only has to name itself — a stale pid from this table is never signalled.
	 */
	async kill(entry: PortEntry): Promise<{ ok: boolean; error: string | null }> {
		state.killingKey = entry.key;
		try {
			const response = (await ws.http('ports:kill', {
				hostId: state.activeHostId,
				entryKey: entry.key
			})) as { result: { ok: boolean; error: string | null }; gone: boolean };

			if (response.gone) return { ok: true, error: null };
			return { ok: response.result.ok, error: response.result.error };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			state.killingKey = null;
		}
	},

	/** Ask for the current count, which pushes alone cannot deliver on load. */
	async loadBadge(): Promise<void> {
		try {
			const response = (await ws.http('ports:summary', {})) as { count: number };
			state.badge = typeof response?.count === 'number' ? response.count : 0;
		} catch (error) {
			debug.warn('ports', 'Could not read the port count:', error);
		}
	},

	/**
	 * Subscribe to pushed tables and the sidebar count. Call once on app mount:
	 * the badge arrives whether or not the panel has ever been opened.
	 */
	initRealtimeListener(): () => void {
		const cleanupChanged = ws.on('ports:changed', (data: { result: PortScanResult }) => {
			if (!data?.result) return;
			state.results[data.result.hostId] = data.result;
			if (data.result.hostId === state.activeHostId) {
				state.error = data.result.error;
			}
		});

		const cleanupBadge = ws.on('ports:badge', (data: { count: number }) => {
			state.badge = typeof data?.count === 'number' ? data.count : 0;
		});

		// A watch lives on the socket that asked for it, so a reconnect leaves the
		// server watching nothing while this side still believes it is. Without
		// re-asking, the table would sit there looking live and never change again.
		const cleanupReconnect = onWsReconnect(() => {
			const wasWatching = state.watching.size > 0;
			state.watching.clear();
			void portsStore.loadBadge();
			if (!wasWatching) return;
			void portsStore.watch(state.activeHostId);
		});

		// The count is state, not an event, so it is read on load rather than
		// waited for — a refreshed page must not sit at zero until it changes.
		void portsStore.loadBadge();

		return () => {
			cleanupChanged();
			cleanupBadge();
			cleanupReconnect();
		};
	}
};
