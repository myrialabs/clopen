import { getDatabase } from '../index';

export interface OpenCodeProvider {
	id: number;
	provider_id: string;
	name: string;
	npm: string;
	api_url: string | null;
	options: string;
	is_enabled: number;
	created_at: string;
}

export interface OpenCodeAccount {
	id: number;
	provider_id: number;
	name: string;
	api_key: string;
	is_active: number;
	created_at: string;
}

/** Provider with its accounts joined */
export interface OpenCodeProviderWithAccounts extends OpenCodeProvider {
	accounts: OpenCodeAccount[];
}

export const opencodeProviderQueries = {
	// ========================================================================
	// Providers
	// ========================================================================

	getProviders(): OpenCodeProvider[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM opencode_providers
			ORDER BY created_at ASC
		`).all() as OpenCodeProvider[];
	},

	getEnabledProviders(): OpenCodeProvider[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM opencode_providers
			WHERE is_enabled = 1
			ORDER BY created_at ASC
		`).all() as OpenCodeProvider[];
	},

	getProvider(id: number): OpenCodeProvider | null {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM opencode_providers WHERE id = ?
		`).get(id) as OpenCodeProvider | null;
	},

	getProviderByProviderId(providerId: string): OpenCodeProvider | null {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM opencode_providers WHERE provider_id = ?
		`).get(providerId) as OpenCodeProvider | null;
	},

	createProvider(data: {
		providerId: string;
		name: string;
		npm: string;
		apiUrl?: string;
		options?: string;
	}): OpenCodeProvider {
		const db = getDatabase();
		db.prepare(`
			INSERT INTO opencode_providers (provider_id, name, npm, api_url, options)
			VALUES (?, ?, ?, ?, ?)
		`).run(
			data.providerId,
			data.name,
			data.npm,
			data.apiUrl || null,
			data.options || '{}'
		);

		const inserted = db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };
		return db.prepare('SELECT * FROM opencode_providers WHERE id = ?').get(inserted.id) as OpenCodeProvider;
	},

	updateProviderOptions(id: number, options: string): void {
		const db = getDatabase();
		db.prepare('UPDATE opencode_providers SET options = ? WHERE id = ?').run(options, id);
	},

	toggleProvider(id: number, enabled: boolean): void {
		const db = getDatabase();
		db.prepare('UPDATE opencode_providers SET is_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
	},

	deleteProvider(id: number): void {
		const db = getDatabase();
		// Accounts are cascade-deleted via FK constraint
		db.prepare('DELETE FROM opencode_providers WHERE id = ?').run(id);
	},

	// ========================================================================
	// Accounts
	// ========================================================================

	getAccountsByProvider(providerDbId: number): OpenCodeAccount[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM opencode_accounts
			WHERE provider_id = ?
			ORDER BY created_at ASC
		`).all(providerDbId) as OpenCodeAccount[];
	},

	getActiveAccount(providerDbId: number): OpenCodeAccount | null {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM opencode_accounts
			WHERE provider_id = ? AND is_active = 1
		`).get(providerDbId) as OpenCodeAccount | null;
	},

	createAccount(providerDbId: number, name: string, apiKey: string): OpenCodeAccount {
		const db = getDatabase();

		// If first account for this provider, make it active
		const count = (db.prepare(
			'SELECT COUNT(*) as count FROM opencode_accounts WHERE provider_id = ?'
		).get(providerDbId) as { count: number }).count;
		const isActive = count === 0 ? 1 : 0;

		db.prepare(`
			INSERT INTO opencode_accounts (provider_id, name, api_key, is_active)
			VALUES (?, ?, ?, ?)
		`).run(providerDbId, name, apiKey, isActive);

		const inserted = db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };
		return db.prepare('SELECT * FROM opencode_accounts WHERE id = ?').get(inserted.id) as OpenCodeAccount;
	},

	switchAccount(accountId: number): void {
		const db = getDatabase();

		// Get the provider_id for this account
		const account = db.prepare('SELECT * FROM opencode_accounts WHERE id = ?').get(accountId) as OpenCodeAccount | null;
		if (!account) return;

		// Deactivate all accounts for this provider, then activate the target
		db.prepare('UPDATE opencode_accounts SET is_active = 0 WHERE provider_id = ?').run(account.provider_id);
		db.prepare('UPDATE opencode_accounts SET is_active = 1 WHERE id = ?').run(accountId);
	},

	deleteAccount(accountId: number): void {
		const db = getDatabase();

		const account = db.prepare('SELECT * FROM opencode_accounts WHERE id = ?').get(accountId) as OpenCodeAccount | null;
		if (!account) return;

		const wasActive = account.is_active === 1;
		db.prepare('DELETE FROM opencode_accounts WHERE id = ?').run(accountId);

		// If deleted account was active, activate first remaining account for this provider
		if (wasActive) {
			const remaining = db.prepare(
				'SELECT id FROM opencode_accounts WHERE provider_id = ? ORDER BY created_at ASC LIMIT 1'
			).get(account.provider_id) as { id: number } | null;
			if (remaining) {
				db.prepare('UPDATE opencode_accounts SET is_active = 1 WHERE id = ?').run(remaining.id);
			}
		}
	},

	renameAccount(accountId: number, name: string): void {
		const db = getDatabase();
		db.prepare('UPDATE opencode_accounts SET name = ? WHERE id = ?').run(name, accountId);
	},

	// ========================================================================
	// Composite: Providers with Accounts
	// ========================================================================

	getProvidersWithAccounts(): OpenCodeProviderWithAccounts[] {
		const providers = this.getProviders();
		return providers.map(p => ({
			...p,
			accounts: this.getAccountsByProvider(p.id)
		}));
	},
};
