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
import { settingsQueries } from '$backend/database/queries/settings-queries';
import { createKeyedLock } from '$backend/utils/keyed-lock';
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

/**
 * Provider ids pi-ai has renamed, old → new. Accounts, chat sessions and saved
 * model choices keep whatever id they were created with, so every id coming in
 * is read through this; a stored credential is rewritten under the new id the
 * next time it is saved.
 */
const RENAMED_PROVIDERS: Record<string, string> = {
	// pi 1.0.3: the provider now also serves Foundry Chat Completions.
	'azure-openai-responses': 'azure',
};

/** The current pi-ai id for a provider id that may predate a rename. */
export function canonicalPiProviderId(providerId: string): string {
	return RENAMED_PROVIDERS[providerId] ?? providerId;
}

/** The account backing a given pi-ai provider id, preferring the active one. */
export function getPiAccountForProvider(providerId: string): EngineAccount | null {
	const wanted = canonicalPiProviderId(providerId);
	const accounts = getPiAccounts().filter(a => parsePiCredential(a.credential)?.provider === wanted);
	if (accounts.length === 0) return null;
	return accounts.find(a => a.is_active === 1) ?? accounts[accounts.length - 1];
}

const DEVICE_ID_KEY = 'pi_device_id';

/**
 * Stable id of this Clopen installation, created on first use. Pi's login flows
 * ask for it through `LoginOptions.getDeviceId` — Sign in with ChatGPT sends it
 * to OpenAI as the agent host id and refuses to start without one. The Pi CLI
 * keeps it in its global settings; Clopen keeps it in the `settings` table.
 */
export function getPiDeviceId(): string {
	const stored = settingsQueries.get(DEVICE_ID_KEY)?.value;
	if (stored) return stored;
	const id = crypto.randomUUID();
	settingsQueries.set(DEVICE_ID_KEY, id);
	return id;
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
		return { provider: canonicalPiProviderId(parsed.provider), credential: cred };
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
 * Per-account write chain shared by EVERY store instance in the process. Each
 * stream and each model-list refresh builds its own `DbCredentialStore`, but
 * they all write the same row — and providers that rotate refresh tokens
 * (OpenAI, Anthropic) revoke the grant when one token is spent twice. Pi's
 * refresh re-checks expiry inside `modify`, so serializing here turns the
 * second caller into a no-op instead of a second refresh.
 */
const withAccountLock = createKeyedLock<number>();

/**
 * Replace an account's stored credential (re-login, edited key) in line with
 * any refresh in flight, so the refresh can't land afterwards and put the old
 * grant back.
 */
export function writePiAccountCredential(accountId: number, serialized: string): Promise<void> {
	return withAccountLock(accountId, async () => {
		engineQueries.updateAccountCredential(accountId, serialized);
	});
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
		// No row behind it (a login into an empty store): nothing to race over.
		if (accountId === undefined) return (await fn(undefined)) ?? undefined;

		return withAccountLock(accountId, async () => {
			// Read inside the lock — a refresh that just finished must be seen.
			const current = parsePiCredential(engineQueries.getAccount(accountId)?.credential)?.credential;
			const next = await fn(current);
			if (next === undefined) return current;
			engineQueries.updateAccountCredential(accountId, serializePiCredential({ provider: providerId, credential: next }));
			debug.log('engine', `Pi: persisted refreshed credential for provider "${providerId}" (account ${accountId})`);
			return next;
		});
	}

	async delete(providerId: string): Promise<void> {
		this.providerToAccount.delete(providerId);
	}
}
