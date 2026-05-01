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
 * Generate OpenCode provider config from DB providers + active accounts.
 *
 * Returns:
 * - enabledProviders: list of provider IDs to put in OPENCODE_CONFIG_CONTENT
 * - envVars: actual environment variables to inject into the spawned process
 *
 * API keys are injected as env vars using the original env var names from
 * the models.dev catalog (stored in the provider's options JSON), NOT as
 * hardcoded "apiKey" in the config JSON.
 */
export function generateOpenCodeProviderConfig(): OpenCodeProviderConfigResult {
	const providers = engineQueries.getEnabledProviders('opencode');
	const enabledProviders: string[] = ['opencode'];
	const envVars: Record<string, string> = {};

	for (const provider of providers) {
		const activeAccount = engineQueries.getActiveAccount(provider.id);
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

		if (envNames.length > 0) {
			envVars[envNames[0]] = activeAccount.credential;
		}

		for (const envName of envNames.slice(1)) {
			if (options[envName]) {
				envVars[envName] = options[envName];
			}
		}
	}

	return { enabledProviders, envVars };
}
