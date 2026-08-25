/**
 * Cursor credential storage.
 *
 * Cursor authenticates with a single `CURSOR_API_KEY` (a user API key from the
 * Cursor dashboard, or a team service-account key). Unlike the multi-provider
 * engines (Cline/Qwen), a Cursor account is single-provider: one `engine_providers`
 * row (`slug = 'cursor'`) owns every stored account, and the account's
 * `credential` carries just the key.
 *
 * The key is passed to `Agent.create({ apiKey })` per stream — there is no shared
 * dotfile to swap, so multi-account within Clopen is a pure DB `is_active` switch
 * (see `backend/engine/README.md` §10.13). Stored as a JSON wrapper
 * (`{ "apiKey": "…" }`) for forward-compatibility, but a raw key string is also
 * accepted.
 */

import { engineQueries, type EngineAccount } from '$backend/database/queries/engine-queries';

export interface CursorCredential {
	apiKey: string;
}

/** The single `engine_providers` row that owns every Cursor account. */
export function getCursorProvider() {
	return engineQueries.getProviderBySlug('cursor', 'cursor');
}

/** Every stored Cursor account. */
export function getCursorAccounts(): EngineAccount[] {
	const provider = getCursorProvider();
	return provider ? engineQueries.getAccountsByProvider(provider.id) : [];
}

/** The active Cursor account (or the most recently added one as a fallback). */
export function getActiveCursorAccount(): EngineAccount | null {
	const active = engineQueries.getActiveAccountForEngine('cursor');
	if (active) return active;
	const accounts = getCursorAccounts();
	return accounts.length ? accounts[accounts.length - 1] : null;
}

/** Parse a stored `engine_accounts.credential` blob into a Cursor credential. */
export function parseCursorCredential(stored: string | null | undefined): CursorCredential | null {
	if (!stored) return null;
	const trimmed = stored.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith('{')) {
		try {
			const parsed = JSON.parse(trimmed) as Partial<CursorCredential>;
			return parsed?.apiKey ? { apiKey: parsed.apiKey } : null;
		} catch {
			return null;
		}
	}
	// Raw API key.
	return { apiKey: trimmed };
}

export function serializeCursorCredential(cred: CursorCredential): string {
	return JSON.stringify(cred);
}

/** Resolve the API key for an account, throwing if it is unusable. */
export function resolveCursorApiKey(account: EngineAccount): string {
	const parsed = parseCursorCredential(account.credential);
	if (!parsed) throw new Error('Cursor account has no usable API key.');
	return parsed.apiKey;
}
