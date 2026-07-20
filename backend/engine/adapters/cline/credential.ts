/**
 * Cline credential storage.
 *
 * Cline (`@cline/sdk`) is genuinely multi-provider and supports both API-key and
 * OAuth (the Cline account signs in through WorkOS OAuth). Rather than let the
 * SDK write its own `~/.cline` provider settings, Clopen OWNS the credential and
 * feeds it to the stateless `Agent` per stream: an API key (or the OAuth access
 * token, formatted via `formatProviderOAuthApiKey`) is passed as
 * `AgentRuntimeConfigWithProvider.apiKey`.
 *
 * `engine_accounts.credential` for a Cline account stores a JSON wrapper:
 *
 *   { "provider": "anthropic", "authMethod": "api_key", "apiKey": "sk-…", "baseUrl": "…", "fields": { … } }
 *   { "provider": "cline",     "authMethod": "oauth",   "oauth": { "access": …, "refresh": …, "expires": … } }
 *
 * Because OAuth access tokens rotate, `resolveClineAuth()` refreshes an expired
 * token via the SDK's provider auth handler and persists the refreshed blob
 * straight back into the account row — no dotfile swap, no `process.env`
 * mutation (mirrors Pi's DB-backed credential contract).
 */

import { getProviderAuthHandler, formatProviderOAuthApiKey } from '@cline/sdk';
import type { OAuthCredentials, ProviderSettings } from '@cline/sdk';
import { engineQueries, type EngineAccount } from '$backend/database/queries/engine-queries';
import { debug } from '$shared/utils/logger';

export type ClineAuthMethod = 'api_key' | 'oauth';

export interface ClineCredential {
	/** Cline SDK provider id (e.g. 'anthropic', 'openai', 'cline'). */
	provider: string;
	authMethod: ClineAuthMethod;
	/** API key (api_key mode). */
	apiKey?: string;
	/** Custom base URL (OpenAI-compatible / self-hosted). */
	baseUrl?: string;
	/** Extra provider-scoped fields (awsRegion, gcpProjectId, …). */
	fields?: Record<string, string>;
	/** OAuth token blob (oauth mode). */
	oauth?: OAuthCredentials;
}

/** The single `engine_providers` row that owns every Cline account (Pi/Qwen-style). */
export function getClineProvider() {
	return engineQueries.getProviderBySlug('cline', 'cline');
}

/** Every stored Cline account (each tagged with its own Cline provider id). */
export function getClineAccounts(): EngineAccount[] {
	const provider = getClineProvider();
	return provider ? engineQueries.getAccountsByProvider(provider.id) : [];
}

/** The account backing a given Cline provider id, preferring the active one. */
export function getClineAccountForProvider(providerId: string): EngineAccount | null {
	const accounts = getClineAccounts().filter(a => parseClineCredential(a.credential)?.provider === providerId);
	if (accounts.length === 0) return null;
	return accounts.find(a => a.is_active === 1) ?? accounts[accounts.length - 1];
}

/** Parse a stored `engine_accounts.credential` blob. Returns null if unusable. */
export function parseClineCredential(stored: string | null | undefined): ClineCredential | null {
	if (!stored) return null;
	const trimmed = stored.trim();
	if (!trimmed.startsWith('{')) return null;
	try {
		const parsed = JSON.parse(trimmed) as Partial<ClineCredential>;
		if (!parsed || typeof parsed.provider !== 'string' || !parsed.provider) return null;
		const authMethod = parsed.authMethod === 'oauth' ? 'oauth' : 'api_key';
		if (authMethod === 'api_key' && !parsed.apiKey) return null;
		if (authMethod === 'oauth' && !parsed.oauth?.access) return null;
		return {
			provider: parsed.provider,
			authMethod,
			...(parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
			...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
			...(parsed.fields && typeof parsed.fields === 'object' ? { fields: parsed.fields } : {}),
			...(parsed.oauth ? { oauth: parsed.oauth } : {}),
		};
	} catch {
		return null;
	}
}

export function serializeClineCredential(cred: ClineCredential): string {
	return JSON.stringify(cred);
}

/** Non-secret display metadata for one account (auth method + provider). */
export function describeClineCredential(
	stored: string | null | undefined,
): { provider: string; authMethod: ClineAuthMethod } | null {
	const parsed = parseClineCredential(stored);
	if (!parsed) return null;
	return { provider: parsed.provider, authMethod: parsed.authMethod };
}

export interface ResolvedClineAuth {
	provider: string;
	apiKey?: string;
	baseUrl?: string;
	/** Gateway options for provider-scoped fields (awsRegion, gcpProjectId, …). */
	options?: Record<string, unknown>;
}

/** Refresh window: refresh an OAuth token that expires within the next minute. */
const OAUTH_REFRESH_BUFFER_MS = 60_000;

/**
 * Resolve the auth an `Agent` needs for one account. For OAuth accounts this
 * refreshes a near-expired access token (persisting the rotated blob back to the
 * DB) and formats it into the api-key the provider handler expects.
 */
export async function resolveClineAuth(account: EngineAccount): Promise<ResolvedClineAuth> {
	const parsed = parseClineCredential(account.credential);
	if (!parsed) throw new Error('Cline account has no usable credential.');

	if (parsed.authMethod === 'api_key') {
		return {
			provider: parsed.provider,
			...(parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
			...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
			...(parsed.fields && Object.keys(parsed.fields).length ? { options: { ...parsed.fields } } : {}),
		};
	}

	// OAuth: refresh if near-expiry, then format the access token as an api key.
	let creds = parsed.oauth as OAuthCredentials;
	const handler = getProviderAuthHandler(parsed.provider);
	const nearExpiry = typeof creds.expires === 'number' && creds.expires <= Date.now() + OAUTH_REFRESH_BUFFER_MS;
	if (handler && creds.refresh && nearExpiry) {
		try {
			const settings = {
				auth: {
					accessToken: creds.access,
					refreshToken: creds.refresh,
					expiresAt: creds.expires,
					...(creds.accountId ? { accountId: creds.accountId } : {}),
				},
			} as ProviderSettings;
			const refreshed = await handler.refresh({ settings, credentials: creds });
			if (refreshed?.access) {
				creds = refreshed;
				engineQueries.updateAccountCredential(
					account.id,
					serializeClineCredential({ ...parsed, oauth: refreshed }),
				);
				debug.log('engine', `Cline: refreshed OAuth token for provider "${parsed.provider}" (account ${account.id})`);
			}
		} catch (error) {
			debug.warn('engine', `Cline OAuth refresh failed for "${parsed.provider}" (using stored token): ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	let apiKey: string;
	try {
		apiKey = formatProviderOAuthApiKey(parsed.provider, { access: creds.access });
	} catch {
		apiKey = creds.access;
	}
	return {
		provider: parsed.provider,
		apiKey,
		...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
	};
}
