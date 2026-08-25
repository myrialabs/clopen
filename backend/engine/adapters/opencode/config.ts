/**
 * OpenCode runtime config builder.
 *
 * Translates DB-stored providers + active accounts into the env-var bundle
 * (`enabledProviders`, `envVars`) consumed by the spawned OpenCode server.
 *
 * The catalog itself (multi-provider preset metadata fetched from
 * models.dev) lives in `./presets.ts` — see README §4.5 for the file-naming
 * standard.
 */

import { engineQueries } from '../../../database/queries';
import { getCachedModelsDevCatalog } from './presets';

export interface OpenCodeProviderConfigResult {
	/** List of enabled provider IDs for OPENCODE_CONFIG_CONTENT */
	enabledProviders: string[];
	/** Env vars to inject (actual env var names → values) */
	envVars: Record<string, string>;
}

/**
 * Parse an account credential into a per-env-var map.
 *
 * Accounts created with multi-env-var providers (e.g. AWS Bedrock,
 * Cloudflare) store all secrets as a JSON object in `credential`:
 *   `{"AWS_ACCESS_KEY_ID": "...", "AWS_SECRET_ACCESS_KEY": "..."}`.
 *
 * Older single-env-var accounts store the raw secret string. Returns null
 * when the credential is not a JSON object so callers can fall back to the
 * legacy single-key behavior.
 */
export function parseCredentialMap(credential: string): Record<string, string> | null {
	const trimmed = credential.trim();
	if (!trimmed.startsWith('{')) return null;
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			const out: Record<string, string> = {};
			for (const [k, v] of Object.entries(parsed)) {
				if (typeof v === 'string') out[k] = v;
			}
			return out;
		}
	} catch {
		return null;
	}
	return null;
}

/**
 * Generate OpenCode provider config from DB providers + active accounts.
 *
 * Returns:
 * - enabledProviders: list of provider IDs to put in OPENCODE_CONFIG_CONTENT
 * - envVars: actual environment variables to inject into the spawned process
 *
 * Per-account credentials may be a JSON object holding all required env vars
 * for that account, or a plain string (legacy single-env-var format). When
 * plain, the value is bound to the catalog's first env name and the rest
 * fall back to the provider's shared `options` JSON.
 */
export function generateOpenCodeProviderConfig(): OpenCodeProviderConfigResult {
	const providers = engineQueries.getEnabledProviders('opencode');
	const enabledProviders: string[] = ['opencode'];
	const envVars: Record<string, string> = {};

	for (const provider of providers) {
		const activeAccount = engineQueries.getActiveAccount(provider.id);

		// Custom providers (api_url set) are OpenAI-compatible endpoints that
		// don't need env-var management — the config injection in server.ts
		// handles npm + baseURL + model discovery from /v1/models.
		if (provider.api_url) {
			enabledProviders.push(provider.slug);
			continue;
		}

		if (!activeAccount) continue;

		enabledProviders.push(provider.slug);

		let options: Record<string, string> = {};
		try {
			options = JSON.parse(provider.options || '{}');
		} catch {
			options = {};
		}

		const cached = getCachedModelsDevCatalog();
		const catalogEntry = cached?.catalog.find(c => c.id === provider.slug);
		const envNames = catalogEntry?.env || [];

		const credentialMap = parseCredentialMap(activeAccount.credential);

		if (credentialMap) {
			// New format: account credential carries every env var the
			// provider needs. Provider options remain a fallback for any
			// missing keys (e.g. region defaults).
			for (const envName of envNames) {
				const value = credentialMap[envName] ?? options[envName];
				if (value) envVars[envName] = value;
			}
		} else {
			if (envNames.length > 0) {
				envVars[envNames[0]] = activeAccount.credential;
			}
			for (const envName of envNames.slice(1)) {
				if (options[envName]) {
					envVars[envName] = options[envName];
				}
			}
		}
	}

	return { enabledProviders, envVars };
}
