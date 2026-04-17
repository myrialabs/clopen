/**
 * Unified Engine Queries — providers + accounts for ALL engines.
 *
 * The previous split (claude_accounts + opencode_providers + opencode_accounts)
 * is consolidated here into:
 *   engine_providers  — one row per (engine_type, slug)
 *   engine_accounts   — credentials under a provider
 *
 * Conventions:
 *   - `slug`       : machine id (e.g. 'anthropic', 'openai'). Lowercase, stable.
 *   - `name`       : display name (user-facing).
 *   - `provider_id`: FK to engine_providers.id (always numeric).
 *   - `credential` : generic secret (OAuth token for claude-code, API key for opencode).
 */

import type { EngineType } from '$shared/types/unified';
import { getDatabase } from '../index';

// ============================================================================
// Types
// ============================================================================

export interface EngineProvider {
	id: number;
	engine_type: EngineType;
	slug: string;
	name: string;
	npm: string | null;
	api_url: string | null;
	options: string;
	is_enabled: number;
	created_at: string;
}

export interface EngineAccount {
	id: number;
	provider_id: number;
	name: string;
	credential: string;
	is_active: number;
	created_at: string;
}

/** Provider with its accounts joined. */
export interface EngineProviderWithAccounts extends EngineProvider {
	accounts: EngineAccount[];
}

// ============================================================================
// Queries
// ============================================================================

export const engineQueries = {
	// ------------------------------------------------------------------
	// Providers
	// ------------------------------------------------------------------

	getProviders(engineType?: EngineType): EngineProvider[] {
		const db = getDatabase();
		if (engineType) {
			return db.prepare(
				`SELECT * FROM engine_providers WHERE engine_type = ? ORDER BY created_at ASC`
			).all(engineType) as EngineProvider[];
		}
		return db.prepare(
			`SELECT * FROM engine_providers ORDER BY engine_type ASC, created_at ASC`
		).all() as EngineProvider[];
	},

	getEnabledProviders(engineType?: EngineType): EngineProvider[] {
		const db = getDatabase();
		if (engineType) {
			return db.prepare(
				`SELECT * FROM engine_providers WHERE engine_type = ? AND is_enabled = 1 ORDER BY created_at ASC`
			).all(engineType) as EngineProvider[];
		}
		return db.prepare(
			`SELECT * FROM engine_providers WHERE is_enabled = 1 ORDER BY engine_type ASC, created_at ASC`
		).all() as EngineProvider[];
	},

	getProvider(id: number): EngineProvider | null {
		const db = getDatabase();
		return db.prepare(`SELECT * FROM engine_providers WHERE id = ?`).get(id) as EngineProvider | null;
	},

	getProviderBySlug(engineType: EngineType, slug: string): EngineProvider | null {
		const db = getDatabase();
		return db.prepare(
			`SELECT * FROM engine_providers WHERE engine_type = ? AND slug = ?`
		).get(engineType, slug) as EngineProvider | null;
	},

	createProvider(data: {
		engineType: EngineType;
		slug: string;
		name: string;
		npm?: string | null;
		apiUrl?: string | null;
		options?: string;
	}): EngineProvider {
		const db = getDatabase();
		const result = db.prepare(`
			INSERT INTO engine_providers (engine_type, slug, name, npm, api_url, options)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run(
			data.engineType,
			data.slug,
			data.name,
			data.npm ?? null,
			data.apiUrl ?? null,
			data.options ?? '{}',
		) as { lastInsertRowid: number | bigint };
		const id = Number(result.lastInsertRowid);
		return db.prepare(`SELECT * FROM engine_providers WHERE id = ?`).get(id) as EngineProvider;
	},

	updateProviderOptions(id: number, options: string): void {
		const db = getDatabase();
		db.prepare(`UPDATE engine_providers SET options = ? WHERE id = ?`).run(options, id);
	},

	toggleProvider(id: number, enabled: boolean): void {
		const db = getDatabase();
		db.prepare(`UPDATE engine_providers SET is_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
	},

	deleteProvider(id: number): void {
		const db = getDatabase();
		// Accounts cascade via FK.
		db.prepare(`DELETE FROM engine_providers WHERE id = ?`).run(id);
	},

	// ------------------------------------------------------------------
	// Accounts
	// ------------------------------------------------------------------

	getAccount(id: number): EngineAccount | null {
		const db = getDatabase();
		return db.prepare(`SELECT * FROM engine_accounts WHERE id = ?`).get(id) as EngineAccount | null;
	},

	getAccountsByProvider(providerId: number): EngineAccount[] {
		const db = getDatabase();
		return db.prepare(
			`SELECT * FROM engine_accounts WHERE provider_id = ? ORDER BY created_at ASC`
		).all(providerId) as EngineAccount[];
	},

	getActiveAccount(providerId: number): EngineAccount | null {
		const db = getDatabase();
		return db.prepare(
			`SELECT * FROM engine_accounts WHERE provider_id = ? AND is_active = 1`
		).get(providerId) as EngineAccount | null;
	},

	/**
	 * Get the active account for the first enabled provider of the given engine.
	 * For claude-code this is effectively the active Anthropic account.
	 */
	getActiveAccountForEngine(engineType: EngineType): EngineAccount | null {
		const db = getDatabase();
		return db.prepare(`
			SELECT a.*
			FROM engine_accounts a
			JOIN engine_providers p ON p.id = a.provider_id
			WHERE p.engine_type = ? AND p.is_enabled = 1 AND a.is_active = 1
			ORDER BY p.created_at ASC, a.created_at ASC
			LIMIT 1
		`).get(engineType) as EngineAccount | null;
	},

	createAccount(providerId: number, name: string, credential: string): EngineAccount {
		const db = getDatabase();

		// If it's the first account for this provider → mark active.
		const count = (db.prepare(
			`SELECT COUNT(*) as count FROM engine_accounts WHERE provider_id = ?`
		).get(providerId) as { count: number }).count;
		const isActive = count === 0 ? 1 : 0;

		const result = db.prepare(`
			INSERT INTO engine_accounts (provider_id, name, credential, is_active)
			VALUES (?, ?, ?, ?)
		`).run(providerId, name, credential, isActive) as { lastInsertRowid: number | bigint };

		const id = Number(result.lastInsertRowid);
		return db.prepare(`SELECT * FROM engine_accounts WHERE id = ?`).get(id) as EngineAccount;
	},

	switchAccount(accountId: number): void {
		const db = getDatabase();
		const account = db.prepare(`SELECT * FROM engine_accounts WHERE id = ?`).get(accountId) as EngineAccount | null;
		if (!account) return;
		db.prepare(`UPDATE engine_accounts SET is_active = 0 WHERE provider_id = ?`).run(account.provider_id);
		db.prepare(`UPDATE engine_accounts SET is_active = 1 WHERE id = ?`).run(accountId);
	},

	deleteAccount(accountId: number): void {
		const db = getDatabase();
		const account = db.prepare(`SELECT * FROM engine_accounts WHERE id = ?`).get(accountId) as EngineAccount | null;
		if (!account) return;

		const wasActive = account.is_active === 1;
		db.prepare(`DELETE FROM engine_accounts WHERE id = ?`).run(accountId);

		// If deleted account was active, activate the first remaining account for its provider.
		if (wasActive) {
			const remaining = db.prepare(
				`SELECT id FROM engine_accounts WHERE provider_id = ? ORDER BY created_at ASC LIMIT 1`
			).get(account.provider_id) as { id: number } | null;
			if (remaining) {
				db.prepare(`UPDATE engine_accounts SET is_active = 1 WHERE id = ?`).run(remaining.id);
			}
		}
	},

	renameAccount(accountId: number, name: string): void {
		const db = getDatabase();
		db.prepare(`UPDATE engine_accounts SET name = ? WHERE id = ?`).run(name, accountId);
	},

	// ------------------------------------------------------------------
	// Composite
	// ------------------------------------------------------------------

	getProvidersWithAccounts(engineType?: EngineType): EngineProviderWithAccounts[] {
		const providers = this.getProviders(engineType);
		return providers.map(p => ({
			...p,
			accounts: this.getAccountsByProvider(p.id),
		}));
	},
};
