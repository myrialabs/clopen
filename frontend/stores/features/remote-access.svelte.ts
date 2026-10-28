/**
 * Remote Access store — Svelte 5 Runes
 *
 * Single source of truth for the "make this Clopen reachable from another
 * device" flow. Resolves a public origin (configured domain, current origin, or
 * a Cloudflare quick tunnel) and mints device-pairing links against it.
 *
 * The origin is resolved server-side (`share:ensure-origin`) so the UI never has
 * to know whether a tunnel was needed; `source` is surfaced only for a badge.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

export type PublicOriginSource = 'configured' | 'domain' | 'tunnel';

export interface ShareLink {
	url: string;
	source: PublicOriginSource;
	/** ISO expiry of the underlying device code. */
	expiresAt: string;
	/** Invalidate the underlying device code so the link stops working. */
	revoke: () => Promise<void>;
}

interface RemoteAccessState {
	origin: string | null;
	source: PublicOriginSource | null;
	isPreparing: boolean;
	error: string | null;
	/** Number of *other* devices currently online — backs the sidebar count. */
	activeConnections: number;
}

const state = $state<RemoteAccessState>({
	origin: null,
	source: null,
	isPreparing: false,
	error: null,
	activeConnections: 0
});

async function ensureOrigin(): Promise<{ origin: string; source: PublicOriginSource }> {
	const requestOrigin = typeof window !== 'undefined' ? window.location.origin : undefined;
	const result = await ws.http('share:ensure-origin', { requestOrigin });
	state.origin = result.origin;
	state.source = result.source;
	return result;
}

export const remoteAccessStore = {
	get origin() { return state.origin; },
	get source() { return state.source; },
	get isPreparing() { return state.isPreparing; },
	get error() { return state.error; },
	/** Number of other devices currently online (live connections). */
	get activeConnections() { return state.activeConnections; },

	/**
	 * Resolve the public origin every share link is built against. Exposed so
	 * other share surfaces (file links) reuse this resolution — including its
	 * tunnel side effect — instead of calling `share:ensure-origin` themselves.
	 */
	ensureOrigin(): Promise<{ origin: string; source: PublicOriginSource }> {
		return ensureOrigin();
	},

	/** Refresh the active-connection count from the server. */
	async refreshSummary(): Promise<void> {
		try {
			const summary = await ws.http('remote-access:summary', {});
			state.activeConnections = summary.activeConnections;
		} catch (err) {
			debug.error('remote-access', 'Failed to load summary:', err);
		}
	},

	/**
	 * Start listening for server-side Remote Access changes (device connected/
	 * disconnected, device code created/claimed/revoked) and keep the count in
	 * sync. Call once after auth is ready. Returns cleanup.
	 */
	initRealtimeListener(): () => void {
		this.refreshSummary();
		const off = ws.on('remote-access:changed', () => {
			this.refreshSummary();
		});
		return () => off();
	},

	/**
	 * Create a device-pairing share link: `${origin}/#device/<code>`. The scanning
	 * device signs in as the owner. One-time, short TTL.
	 */
	async createDeviceLink(label?: string): Promise<ShareLink> {
		state.isPreparing = true;
		state.error = null;
		try {
			const { origin, source } = await ensureOrigin();
			const result = await ws.http('auth:create-device-code', label ? { label } : {});
			const code = result.deviceCode;
			const url = `${origin}/#device/${code}`;
			debug.log('remote-access', `Device link ready via ${source}`);
			return {
				url,
				source,
				expiresAt: result.expiresAt,
				revoke: () => ws.http('auth:revoke-device-code', { deviceCode: code }).then(() => {})
			};
		} catch (err) {
			state.error = err instanceof Error ? err.message : 'Failed to create device link';
			throw err;
		} finally {
			state.isPreparing = false;
		}
	}
};
