/**
 * File share links store — Svelte 5 Runes
 *
 * Single source of truth for "Share Link…": the live list from the server, the
 * raw URLs this browser minted, and the per-user defaults new links start from.
 *
 * The URL split matters. The server stores only a token HASH, so a link's URL
 * can never be rebuilt from the database — not by the UI, not by an admin, not
 * by an attacker who reads the table. What the server can hand back is metadata
 * (which file, whose, when it lapses, how often it was opened), which is enough
 * to REVOKE a link but not to re-show it. So the raw URL is cached here, keyed
 * by row id and persisted in sessionStorage, exactly as invite URLs are: a link
 * minted on this device stays copyable, one minted elsewhere lists as "created
 * in another session" and is still revocable.
 *
 * The list is kept fresh by `files:shares-changed`, not by a refresh button:
 * a link opened on a phone has to show up as opened on the laptop that made it,
 * and the app already holds an open socket for exactly this kind of thing.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import { loadUserState } from '$frontend/stores/core/user-state.svelte';
import { remoteAccessStore } from './remote-access.svelte';

export interface FileShare {
	id: string;
	filePath: string;
	/** Basename, resolved server-side so the UI never parses a foreign path. */
	fileName: string;
	projectName: string | null;
	worktreeName: string | null;
	/** Path within the project/worktree, `/`-separated on every platform. */
	relativePath: string;
	createdBy: string;
	createdByName: string | null;
	createdAt: string;
	/** Dies on the first open, rather than staying openable until it lapses. */
	oneTime: boolean;
	/** ISO deadline, or null for "until revoked". */
	expiresAt: string | null;
	openCount: number;
	lastOpenedAt: string | null;
	consumedAt: string | null;
}

/** What a new link starts as, until the creator says otherwise. */
export interface FileShareDefaults {
	oneTime: boolean;
	/** Minutes, or null for "until revoked". */
	expiresInMinutes: number | null;
}

export const DEFAULT_FILE_SHARE_DEFAULTS: FileShareDefaults = {
	oneTime: true,
	expiresInMinutes: 5
};

/** The deadlines offered in both pickers. `null` is "until revoked". */
export const FILE_SHARE_EXPIRY_CHOICES: { value: number | null; label: string }[] = [
	{ value: 5, label: '5 minutes' },
	{ value: 15, label: '15 minutes' },
	{ value: 60, label: '1 hour' },
	{ value: 24 * 60, label: '24 hours' },
	{ value: 7 * 24 * 60, label: '7 days' },
	{ value: null, label: 'Until revoked' }
];

interface FileShareState {
	shares: FileShare[];
	loaded: boolean;
	isLoading: boolean;
	/** Generated share URLs keyed by share id (raw token only known at creation). */
	urls: Record<string, string>;
	defaults: FileShareDefaults;
	defaultsLoaded: boolean;
}

const STORAGE_KEY = 'clopen-file-share-urls';

function loadStoredURLs(): Record<string, string> {
	try {
		const stored = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(STORAGE_KEY) : null;
		if (stored) return JSON.parse(stored);
	} catch {
		/* ignore */
	}
	return {};
}

const state = $state<FileShareState>({
	shares: [],
	loaded: false,
	isLoading: false,
	urls: loadStoredURLs(),
	defaults: { ...DEFAULT_FILE_SHARE_DEFAULTS },
	defaultsLoaded: false
});

function persistURLs() {
	try {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state.urls));
	} catch {
		/* ignore */
	}
}

/** Drop cached URLs whose share is gone, so the cache cannot outgrow the list. */
function pruneURLs(live: FileShare[]) {
	const ids = new Set(live.map((s) => s.id));
	const kept = Object.fromEntries(Object.entries(state.urls).filter(([id]) => ids.has(id)));
	if (Object.keys(kept).length !== Object.keys(state.urls).length) {
		state.urls = kept;
		persistURLs();
	}
}

function sanitizeDefaults(value: unknown): FileShareDefaults {
	const raw = (value ?? {}) as Partial<FileShareDefaults>;
	const allowed = FILE_SHARE_EXPIRY_CHOICES.map((c) => c.value);
	const expiry = raw.expiresInMinutes;
	const expiryIsKnown = expiry === null || (typeof expiry === 'number' && allowed.includes(expiry));
	return {
		oneTime: typeof raw.oneTime === 'boolean' ? raw.oneTime : DEFAULT_FILE_SHARE_DEFAULTS.oneTime,
		expiresInMinutes: expiryIsKnown ? expiry : DEFAULT_FILE_SHARE_DEFAULTS.expiresInMinutes
	};
}

export const fileSharesStore = {
	get shares(): FileShare[] { return state.shares; },
	get loaded() { return state.loaded; },
	get isLoading() { return state.isLoading; },
	get defaults(): FileShareDefaults { return state.defaults; },
	get defaultsLoaded() { return state.defaultsLoaded; },

	/** URL for a share id, if the link was generated in this browser session. */
	shareURL(id: string): string | undefined { return state.urls[id]; },

	/**
	 * Live links: every user's for an admin, your own otherwise.
	 * Always fetches fresh from the server — never serves a cached list —
	 * so a link opened from a phone is reflected immediately.
	 */
	async load(): Promise<void> {
		state.isLoading = true;
		try {
			const result = await ws.http('files:list-shares', {});
			state.shares = result.shares;
			state.loaded = true;
			pruneURLs(result.shares);
		} catch (err) {
			debug.error('file', 'Failed to load file shares:', err);
			throw err;
		} finally {
			state.isLoading = false;
		}
	},

	/** One live entry by row id, or undefined when it is gone (used, expired, revoked). */
	byId(id: string): FileShare | undefined {
		return state.shares.find((s) => s.id === id);
	},

	/**
	 * Keep the list in sync with the server for as long as a view is mounted.
	 * Every `files:shares-changed` event (minted, revoked, opened from any
	 * device) triggers a fresh `load()` — no stale-cache guard — so an open
	 * from a phone updates the laptop view without reopen. Returns the
	 * unsubscribe callback.
	 */
	subscribe(onChange?: (kind: string) => void): () => void {
		const off = ws.on('files:shares-changed', (payload) => {
			void this.load()
				.then(() => onChange?.((payload as { kind?: string })?.kind ?? 'changed'))
				.catch(() => {});
		});
		return () => off();
	},

	/** Read the saved defaults once; falls back to one-time / 5 minutes. */
	async loadDefaults(): Promise<FileShareDefaults> {
		if (state.defaultsLoaded) return state.defaults;
		const restored = await loadUserState();
		// A failed restore must not be written back as "the user's choice".
		if (restored) {
			state.defaults = sanitizeDefaults(restored.fileShareDefaults);
			state.defaultsLoaded = true;
		}
		return state.defaults;
	},

	/** Persist the defaults new links start from. */
	async saveDefaults(next: FileShareDefaults): Promise<void> {
		state.defaults = sanitizeDefaults(next);
		state.defaultsLoaded = true;
		try {
			await ws.http('user:save-state', { key: 'fileShareDefaults', value: { ...state.defaults } });
		} catch (err) {
			debug.error('file', 'Failed to save file share defaults:', err);
		}
	},

	/**
	 * Mint a link for one file against the public origin Remote Access
	 * resolves, and remember its URL so it stays copyable after the modal that
	 * created it is closed.
	 */
	async create(
		filePath: string,
		options?: Partial<FileShareDefaults>
	): Promise<{ id: string; url: string; oneTime: boolean; expiresAt: string | null; source: string }> {
		const oneTime = options?.oneTime ?? state.defaults.oneTime;
		const expiresInMinutes = options?.expiresInMinutes !== undefined
			? options.expiresInMinutes
			: state.defaults.expiresInMinutes;

		const { origin, source } = await remoteAccessStore.ensureOrigin();
		const result = await ws.http('files:create-share', {
			file_path: filePath,
			oneTime,
			expiresInMinutes
		});
		const url = `${origin}/api/files/shared?share=${encodeURIComponent(result.shareToken)}`;
		state.urls = { ...state.urls, [result.shareId]: url };
		persistURLs();
		// Refresh unconditionally so the new row (and any concurrent open)
		// is visible immediately, even when the list was never loaded before.
		await this.load().catch(() => {});
		return { id: result.shareId, url, oneTime: result.oneTime, expiresAt: result.expiresAt, source };
	},

	/** Kill a link by row id — no raw token needed, so this works from anywhere. */
	async revoke(id: string): Promise<void> {
		await ws.http('files:revoke-share', { shareId: id });
		const { [id]: _removed, ...rest } = state.urls;
		state.urls = rest;
		persistURLs();
		state.shares = state.shares.filter((s) => s.id !== id);
	}
};
