/**
 * OpenCode Provider Catalog (models.dev)
 *
 * Multi-provider preset metadata for OpenCode — fetched from
 * `models.dev/api.json` and cached in the settings table. Drives the
 * "Add Provider" picker in Settings → Engines → OpenCode.
 *
 * This file mirrors `qwen/presets.ts` (the canonical name for multi-provider
 * preset catalogs — see README §4.5). The runtime config builder that turns
 * DB-stored providers into env vars + `OPENCODE_CONFIG_CONTENT` lives in
 * `./config.ts`.
 */
import { settingsQueries } from '../../../database/queries';
import { debug } from '$shared/utils/logger';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_KEY = 'opencode.models_dev_cache';
const CACHE_TS_KEY = 'opencode.models_dev_cached_at';

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

	const catalog: ModelsDevProvider[] = [];
	for (const [key, entry] of Object.entries(raw)) {
		if (!entry.npm) continue;
		catalog.push({
			id: entry.id || key,
			name: entry.name || key,
			npm: entry.npm,
			env: entry.env || [],
			api: entry.api || null,
		});
	}

	catalog.sort((a, b) => a.name.localeCompare(b.name));

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
