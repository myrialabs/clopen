/**
 * Pi credential storage.
 *
 * Pi is genuinely multi-provider and supports both API-key and OAuth
 * (subscription) auth. Rather than let Pi write its own `auth.json`, Clopen owns
 * the credential and serves it to `ModelRuntime` through a DB-backed
 * `CredentialStore` (pi-ai's `read`/`modify`/`delete` seam).
 *
 * `engine_accounts.credential` for a Pi account stores a JSON wrapper:
 *
 *   { "provider": "anthropic", "credential": { "type": "oauth", "access": …, "refresh": …, "expires": … } }
 *
 * The `credential` field is the raw pi-ai `Credential` (`ApiKeyCredential` or
 * `OAuthCredential`). Because OAuth tokens auto-refresh, `modify()` writes the
 * refreshed credential straight back into the account row — the refresh persists
 * with NO dotfile swap and NO `process.env` mutation.
 */

import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import { engineQueries, type EngineAccount } from '$backend/database/queries/engine-queries';
import { debug } from '$shared/utils/logger';

/** The single `engine_providers` row that owns every Pi account (Qwen-style). */
export function getPiProvider() {
	return engineQueries.getProviderBySlug('pi', 'pi');
}

/** Every stored Pi account (each tagged with its own pi-ai provider). */
export function getPiAccounts(): EngineAccount[] {
	const provider = getPiProvider();
	return provider ? engineQueries.getAccountsByProvider(provider.id) : [];
}

/** The account backing a given pi-ai provider id, preferring the active one. */
export function getPiAccountForProvider(providerId: string): EngineAccount | null {
	const accounts = getPiAccounts().filter(a => parsePiCredential(a.credential)?.provider === providerId);
	if (accounts.length === 0) return null;
	return accounts.find(a => a.is_active === 1) ?? accounts[accounts.length - 1];
}

export interface PiCredential {
	/** pi-ai provider id (e.g. 'anthropic', 'openai', 'openai-codex'). */
	provider: string;
	/** The raw pi-ai credential blob (api_key or oauth). */
	credential: Credential;
}

/** Parse a stored `engine_accounts.credential` blob. Returns null if unusable. */
export function parsePiCredential(stored: string | null | undefined): PiCredential | null {
	if (!stored) return null;
	const trimmed = stored.trim();
	if (!trimmed.startsWith('{')) return null;
	try {
		const parsed = JSON.parse(trimmed) as Partial<PiCredential>;
		if (!parsed || typeof parsed.provider !== 'string' || !parsed.provider) return null;
		const cred = parsed.credential as Credential | undefined;
		if (!cred || (cred.type !== 'api_key' && cred.type !== 'oauth')) return null;
		return { provider: parsed.provider, credential: cred };
	} catch {
		return null;
	}
}

export function serializePiCredential(cred: PiCredential): string {
	return JSON.stringify({ provider: cred.provider, credential: cred.credential });
}

/** Non-secret display metadata for one account (auth type + provider). */
export function describePiCredential(stored: string | null | undefined): { provider: string; type: 'api_key' | 'oauth' } | null {
	const parsed = parsePiCredential(stored);
	if (!parsed) return null;
	return { provider: parsed.provider, type: parsed.credential.type };
}

/**
 * A pi-ai `CredentialStore` backed by one or more `engine_accounts` rows.
 *
 * Keyed by pi-ai `providerId`. Each provider resolves to at most one account
 * (the newest active one when several exist for the same provider). `modify()`
 * persists refreshed OAuth tokens back to the account row so long-running
 * streams survive token rotation.
 */
export class DbCredentialStore implements CredentialStore {
	/** providerId → engine_accounts.id */
	private readonly providerToAccount = new Map<string, number>();

	constructor(accounts: EngineAccount[]) {
		for (const account of accounts) {
			const parsed = parsePiCredential(account.credential);
			if (!parsed) continue;
			// Last write wins — callers pass the active account last, or a single account.
			this.providerToAccount.set(parsed.provider, account.id);
		}
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const accountId = this.providerToAccount.get(providerId);
		if (accountId === undefined) return undefined;
		const account = engineQueries.getAccount(accountId);
		if (!account) return undefined;
		const parsed = parsePiCredential(account.credential);
		return parsed?.credential;
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const out: CredentialInfo[] = [];
		for (const [providerId, accountId] of this.providerToAccount) {
			const account = engineQueries.getAccount(accountId);
			const parsed = account ? parsePiCredential(account.credential) : null;
			if (parsed) out.push({ providerId, type: parsed.credential.type });
		}
		return out;
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		const accountId = this.providerToAccount.get(providerId);
		const current = accountId !== undefined
			? parsePiCredential(engineQueries.getAccount(accountId)?.credential)?.credential
			: undefined;

		const next = await fn(current);
		if (next === undefined) return current;

		if (accountId !== undefined) {
			engineQueries.updateAccountCredential(accountId, serializePiCredential({ provider: providerId, credential: next }));
			debug.log('engine', `Pi: persisted refreshed credential for provider "${providerId}" (account ${accountId})`);
		}
		return next;
	}

	async delete(providerId: string): Promise<void> {
		this.providerToAccount.delete(providerId);
	}
}
