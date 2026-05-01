import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description =
	'Seed Qwen Code provider and store credentials as JSON with per-account preset/baseUrl';

interface ProviderRow {
	id: number;
	options: string | null;
}

interface AccountRow {
	id: number;
	credential: string | null;
}

const DEFAULT_PRESET = 'dashscope-intl';
const DASHSCOPE_INTL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const DASHSCOPE_CN = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const OPENROUTER = 'https://openrouter.ai/api/v1';
const FIREWORKS = 'https://api.fireworks.ai/inference/v1';

function presetFromBaseUrl(baseUrl: string | null | undefined): string {
	if (!baseUrl) return DEFAULT_PRESET;
	const lower = baseUrl.toLowerCase();
	if (lower.startsWith(DASHSCOPE_INTL.toLowerCase())) return 'dashscope-intl';
	if (lower.startsWith(DASHSCOPE_CN.toLowerCase())) return 'dashscope-cn';
	if (lower.startsWith(OPENROUTER.toLowerCase())) return 'openrouter';
	if (lower.startsWith(FIREWORKS.toLowerCase())) return 'fireworks';
	return 'custom';
}

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Seeding Qwen Code provider...');
	db.exec(`
		INSERT OR IGNORE INTO engine_providers (engine_type, slug, name, npm, api_url, options, is_enabled)
		VALUES ('qwen', 'qwen', 'Qwen', NULL, NULL, '{}', 1)
	`);
	debug.log('migration', 'Qwen Code provider seeded');

	debug.log('migration', 'Migrating Qwen credentials to JSON form...');

	const providers = db.prepare(
		`SELECT id, options FROM engine_providers WHERE engine_type = 'qwen'`
	).all() as ProviderRow[];

	for (const provider of providers) {
		// Pull the previous provider-level baseUrl (if any) so we can fold it
		// into each account's credential JSON.
		let providerBaseUrl: string | undefined;
		try {
			const opts = JSON.parse(provider.options || '{}') as { baseUrl?: unknown };
			if (typeof opts.baseUrl === 'string' && opts.baseUrl.trim().length > 0) {
				providerBaseUrl = opts.baseUrl.trim();
			}
		} catch {
			/* malformed options — treat as no baseUrl */
		}

		const preset = presetFromBaseUrl(providerBaseUrl);

		const accounts = db.prepare(
			`SELECT id, credential FROM engine_accounts WHERE provider_id = ?`
		).all(provider.id) as AccountRow[];

		for (const account of accounts) {
			const raw = (account.credential ?? '').trim();
			// Skip accounts that already store JSON (idempotent re-run safety).
			if (raw.startsWith('{')) continue;

			const json: Record<string, unknown> = { apiKey: raw, preset };
			if (providerBaseUrl) json.baseUrl = providerBaseUrl;

			db.prepare(`UPDATE engine_accounts SET credential = ? WHERE id = ?`).run(
				JSON.stringify(json),
				account.id,
			);
		}

		// Clear the provider-level baseUrl now that it's per-account.
		if (providerBaseUrl !== undefined) {
			db.prepare(`UPDATE engine_providers SET options = ? WHERE id = ?`).run('{}', provider.id);
		}
	}

	debug.log('migration', 'Qwen credentials migrated to JSON form');
};

export const down = (db: DatabaseConnection): void => {
	// Best-effort reverse: extract `apiKey` from the JSON blob and write it
	// back as a raw string before removing the provider.
	debug.log('migration', 'Reverting Qwen credentials to raw API key strings...');

	const providers = db.prepare(
		`SELECT id, options FROM engine_providers WHERE engine_type = 'qwen'`
	).all() as ProviderRow[];

	for (const provider of providers) {
		const accounts = db.prepare(
			`SELECT id, credential FROM engine_accounts WHERE provider_id = ?`
		).all(provider.id) as AccountRow[];

		for (const account of accounts) {
			const raw = (account.credential ?? '').trim();
			if (!raw.startsWith('{')) continue;
			try {
				const parsed = JSON.parse(raw) as { apiKey?: unknown };
				const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : '';
				db.prepare(`UPDATE engine_accounts SET credential = ? WHERE id = ?`).run(apiKey, account.id);
			} catch {
				/* leave malformed entries alone */
			}
		}
	}

	debug.log('migration', 'Removing Qwen Code provider...');
	db.exec(`DELETE FROM engine_providers WHERE engine_type = 'qwen' AND slug = 'qwen'`);
	debug.log('migration', 'Qwen Code provider removed');
};
