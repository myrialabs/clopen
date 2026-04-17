/**
 * OpenCode Provider Config Management
 *
 * - Fetches and caches provider catalog from models.dev/api.json
 * - Generates OPENCODE_CONFIG_CONTENT JSON from DB providers + active accounts
 * - Provides restart logic for the OpenCode server
 */

import { settingsQueries, engineQueries } from '../../../database/queries';
import { debug } from '$shared/utils/logger';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_KEY = 'opencode.models_dev_cache';
const CACHE_TS_KEY = 'opencode.models_dev_cached_at';

// ============================================================================
// Models.dev Catalog (provider metadata for the "Add Provider" picker)
// ============================================================================

/** Minimal provider info from models.dev — only what we need for the picker */
export interface ModelsDevProvider {
	id: string;
	name: string;
	npm: string;
	env: string[];
	api: string | null;
}

/**
 * Fetch models.dev/api.json and cache a minimal provider catalog in the DB.
 * Returns the parsed catalog.
 */
export async function fetchAndCacheModelsDevCatalog(): Promise<ModelsDevProvider[]> {
	debug.log('engine', 'Fetching models.dev catalog...');

	const response = await fetch(MODELS_DEV_URL, {
		signal: AbortSignal.timeout(30_000),
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch models.dev: ${response.status} ${response.statusText}`);
	}

	const raw = await response.json() as Record<string, {
		id?: string;
		name?: string;
		npm?: string;
		env?: string[];
		api?: string;
		models?: Record<string, unknown>;
	}>;

	// Extract only what we need: id, name, npm, env, api
	const catalog: ModelsDevProvider[] = [];
	for (const [key, entry] of Object.entries(raw)) {
		if (!entry.npm) continue; // Skip entries without npm package
		catalog.push({
			id: entry.id || key,
			name: entry.name || key,
			npm: entry.npm,
			env: entry.env || [],
			api: entry.api || null,
		});
	}

	// Sort alphabetically by name
	catalog.sort((a, b) => a.name.localeCompare(b.name));

	// Cache in DB
	settingsQueries.set(CACHE_KEY, JSON.stringify(catalog));
	settingsQueries.set(CACHE_TS_KEY, new Date().toISOString());

	debug.log('engine', `Cached ${catalog.length} providers from models.dev`);
	return catalog;
}

/**
 * Get the cached models.dev catalog from DB. Returns null if not cached.
 */
export function getCachedModelsDevCatalog(): { catalog: ModelsDevProvider[]; cachedAt: string } | null {
	const cached = settingsQueries.get(CACHE_KEY);
	const cachedAt = settingsQueries.get(CACHE_TS_KEY);

	if (!cached?.value || !cachedAt?.value) return null;

	try {
		return {
			catalog: JSON.parse(cached.value) as ModelsDevProvider[],
			cachedAt: cachedAt.value,
		};
	} catch {
		return null;
	}
}

// ============================================================================
// OpenCode Config Generation
// ============================================================================

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

		// Parse stored options which may contain additional env var values
		let options: Record<string, string> = {};
		try {
			options = JSON.parse(provider.options || '{}');
		} catch {
			options = {};
		}

		// Look up the catalog entry to get the actual env var names
		const cached = getCachedModelsDevCatalog();
		const catalogEntry = cached?.catalog.find(c => c.id === provider.slug);
		const envNames = catalogEntry?.env || [];

		// First env var gets the active account's credential
		if (envNames.length > 0) {
			envVars[envNames[0]] = activeAccount.credential;
		}

		// Additional env vars from options (stored by their env var name)
		for (const envName of envNames.slice(1)) {
			if (options[envName]) {
				envVars[envName] = options[envName];
			}
		}
	}

	return { enabledProviders, envVars };
}
