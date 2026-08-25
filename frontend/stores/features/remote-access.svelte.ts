/**
 * Remote Access store — Svelte 5 Runes
 *
 * Single source of truth for the "make this Clopen reachable from another
 * device" flow. Resolves a public origin (configured domain, current origin, or
 * a Cloudflare quick tunnel), mints share artifacts against it (device-pairing
 * links + member invites), and owns the invite list + generated URLs so the
 * quick-action panel and the Settings → Access hub stay in sync.
 *
 * The origin is resolved server-side (`share:ensure-origin`) so the UI never has
 * to know whether a tunnel was needed; `source` is surfaced only for a badge.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

export type PublicOriginSource = 'configured' | 'domain' | 'tunnel';

/** How long an unused invite link stays valid before it expires on its own. */
const INVITE_TTL_MINUTES = 15;

export interface ShareLink {
	kind: 'invite' | 'device';
	url: string;
	source: PublicOriginSource;
	/** ISO expiry, when the underlying token expires (device codes only). */
	expiresAt?: string;
	/** Invalidate this link's underlying token (invite/device code) so it stops working. */
	revoke: () => Promise<void>;
}

export interface Invite {
	id: string;
	role: string;
	label: string | null;
	max_uses: number;
	use_count: number;
	expires_at: string | null;
	created_at: string;
	/** JSON array of project ids to grant on join (null = none). */
	project_ids: string | null;
}

interface RemoteAccessState {
	origin: string | null;
	source: PublicOriginSource | null;
	isPreparing: boolean;
	error: string | null;
	/** Number of *other* devices currently online — backs the sidebar count. */
	activeConnections: number;
	/** All invites (admin view), kept in sync via realtime + explicit loads. */
	invites: Invite[];
	invitesLoaded: boolean;
	/** Generated invite URLs keyed by invite id (raw token only known at creation). */
	inviteURLs: Record<string, string>;
}

// Invite URLs are persisted so they survive a refresh — the raw token is only
// ever returned once, at creation time. Shared across every invite surface.
const STORAGE_KEY = 'clopen-invite-urls';

function loadStoredURLs(): Record<string, string> {
	try {
		const stored = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(STORAGE_KEY) : null;
		if (stored) return JSON.parse(stored);
	} catch {
		/* ignore */
	}
	return {};
}

const state = $state<RemoteAccessState>({
	origin: null,
	source: null,
	isPreparing: false,
	error: null,
	activeConnections: 0,
	invites: [],
	invitesLoaded: false,
	inviteURLs: loadStoredURLs()
});

function persistURLs() {
	try {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state.inviteURLs));
	} catch {
		/* ignore */
	}
}

async function ensureOrigin(): Promise<{ origin: string; source: PublicOriginSource }> {
	const requestOrigin = typeof window !== 'undefined' ? window.location.origin : undefined;
	const result = await ws.http('share:ensure-origin', { requestOrigin });
	state.origin = result.origin;
	state.source = result.source;
	return result;
}

/** An invite is "active" while it still has uses left and hasn't expired. */
function isActiveInvite(inv: Invite): boolean {
	const usedUp = inv.max_uses > 0 && inv.use_count >= inv.max_uses;
	const expired = inv.expires_at !== null && new Date(inv.expires_at).getTime() < Date.now();
	return !usedUp && !expired;
}

export const remoteAccessStore = {
	get origin() { return state.origin; },
	get source() { return state.source; },
	get isPreparing() { return state.isPreparing; },
	get error() { return state.error; },
	/** Number of other devices currently online (live connections). */
	get activeConnections() { return state.activeConnections; },
	get invitesLoaded() { return state.invitesLoaded; },
	/** Active (usable) invites only. */
	get activeInvites(): Invite[] { return state.invites.filter(isActiveInvite); },
	/** URL for a given invite id, if it was generated on this device. */
	inviteURL(id: string): string | undefined { return state.inviteURLs[id]; },

	/** Refresh the active-connection count from the server. */
	async refreshSummary(): Promise<void> {
		try {
			const summary = await ws.http('remote-access:summary', {});
			state.activeConnections = summary.activeConnections;
		} catch (err) {
			debug.error('remote-access', 'Failed to load summary:', err);
		}
	},

	/** Load all invites (admin only). Silently no-ops for non-admins. */
	async loadInvites(): Promise<void> {
		try {
			state.invites = await ws.http('auth:list-invites', {});
			state.invitesLoaded = true;
		} catch (err) {
			debug.error('remote-access', 'Failed to load invites:', err);
		}
	},

	/**
	 * Start listening for server-side Remote Access changes (device connected/
	 * disconnected, device code or invite created/claimed/revoked) and keep the
	 * count + invite list in sync. Call once after auth is ready. Returns cleanup.
	 */
	initRealtimeListener(): () => void {
		this.refreshSummary();
		const off = ws.on('remote-access:changed', () => {
			this.refreshSummary();
			if (state.invitesLoaded) this.loadInvites();
		});
		return () => off();
	},

	/**
	 * Create a member invite. Single-use with a short TTL so an unused link dies
	 * on its own (a live countdown surfaces it, mirroring the device flow).
	 * Optionally pre-assigns projects so the new member has access the moment they
	 * join. Resolves the adaptive public origin, stores the generated URL
	 * centrally, and refreshes the list. Admin-only (auth:create-invite).
	 */
	async createInvite(projectIds?: string[]): Promise<{ invite: Invite; url: string; source: PublicOriginSource }> {
		const { origin, source } = await ensureOrigin();
		const result = await ws.http('auth:create-invite', {
			maxUses: 1,
			expiresInMinutes: INVITE_TTL_MINUTES,
			...(projectIds && projectIds.length ? { projectIds } : {})
		});
		const url = `${origin}/#invite/${result.inviteToken}`;
		state.inviteURLs = { ...state.inviteURLs, [result.invite.id]: url };
		persistURLs();
		await this.loadInvites();
		debug.log('remote-access', `Invite link ready via ${source}`);
		return { invite: result.invite as Invite, url, source };
	},

	/** Revoke an invite and drop its stored URL. */
	async revokeInvite(id: string): Promise<void> {
		await ws.http('auth:revoke-invite', { id });
		const { [id]: _removed, ...rest } = state.inviteURLs;
		state.inviteURLs = rest;
		persistURLs();
		state.invites = state.invites.filter((inv) => inv.id !== id);
	},

	/**
	 * Create a device-pairing share link: `${origin}/#device/<code>`. The scanning
	 * device signs in as the current user. One-time, short TTL.
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
				kind: 'device',
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
