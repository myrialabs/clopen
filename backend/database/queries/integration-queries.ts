/**
 * Integration account + projection queries.
 *
 * `integration_accounts` is the ONLY place a third-party credential lives.
 * `credentials` is a JSON object sealed at rest by the crypto layer, so callers
 * here hand in and receive a plain object and never see an envelope.
 *
 * `integration_projections` links an account to the rows it derived on other
 * surfaces. Nothing outside `backend/integrations/projections/` should write to
 * it — a projection created by hand is a projection nothing will ever clean up.
 */

import { getDatabase } from '../index';
import { openRow, sealFor } from '../crypto';
import type { IntegrationAuthMethod, IntegrationCapability, IntegrationStatus, IntegrationTargetKind } from '$shared/types/integrations';

const TABLE = 'integration_accounts';

export interface IntegrationAccountRow {
	id: string;
	provider: string;
	label: string;
	project_id: string | null;
	auth_method: IntegrationAuthMethod;
	/** Sealed on disk, plain JSON string here. Null when the key could not open it. */
	credentials: string | null;
	capabilities: string;
	status: IntegrationStatus;
	status_detail: string | null;
	checked_at: string | null;
	is_enabled: number;
	created_at: string;
	updated_at: string;
}

export interface IntegrationProjectionRow {
	account_id: string;
	capability: IntegrationCapability;
	target_kind: IntegrationTargetKind;
	target_id: string;
	adopted: number;
	restore_json: string | null;
	created_at: string;
}

export interface IntegrationAccountInput {
	provider: string;
	label: string;
	projectId?: string | null;
	authMethod: IntegrationAuthMethod;
	credentials: Record<string, string>;
	capabilities: IntegrationCapability[];
}

/** Parse a JSON column, falling back rather than throwing on a value we could not open. */
function parse<T>(raw: string | null, fallback: T): T {
	if (!raw) return fallback;
	try {
		const parsed = JSON.parse(raw);
		return (parsed ?? fallback) as T;
	} catch {
		return fallback;
	}
}

function openAccount<T extends IntegrationAccountRow | null>(row: T): T {
	return (row ? openRow(TABLE, row) : row) as T;
}

export const integrationAccountQueries = {
	getAll(): IntegrationAccountRow[] {
		const db = getDatabase();
		return (db.prepare(
			`SELECT * FROM integration_accounts ORDER BY provider ASC, label ASC`
		).all() as IntegrationAccountRow[]).map((row) => openAccount(row));
	},

	getById(id: string): IntegrationAccountRow | null {
		const db = getDatabase();
		return openAccount(
			db.prepare(`SELECT * FROM integration_accounts WHERE id = ?`).get(id) as IntegrationAccountRow | null
		);
	},

	getByProvider(provider: string): IntegrationAccountRow[] {
		const db = getDatabase();
		return (db.prepare(
			`SELECT * FROM integration_accounts WHERE provider = ? ORDER BY label ASC`
		).all(provider) as IntegrationAccountRow[]).map((row) => openAccount(row));
	},

	/**
	 * Enabled accounts for one provider, preferring a project-bound account over
	 * a global one. This is the lookup an inbound webhook and a surface both
	 * make, and preferring the bound account is what lets two projects point at
	 * two different orgs of the same service.
	 */
	getEnabledForProvider(provider: string, projectId?: string | null): IntegrationAccountRow[] {
		return this.getByProvider(provider)
			.filter((row) => row.is_enabled === 1)
			.sort((a, b) => {
				const aBound = a.project_id === projectId ? 0 : 1;
				const bBound = b.project_id === projectId ? 0 : 1;
				return aBound - bBound;
			});
	},

	/** Decoded credentials. Empty object when the active key could not open them. */
	credentialsOf(row: IntegrationAccountRow): Record<string, string> {
		return parse<Record<string, string>>(row.credentials, {});
	},

	capabilitiesOf(row: IntegrationAccountRow): IntegrationCapability[] {
		return parse<IntegrationCapability[]>(row.capabilities, []);
	},

	create(input: IntegrationAccountInput): IntegrationAccountRow {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		db.prepare(`
			INSERT INTO integration_accounts (
				id, provider, label, project_id, auth_method,
				credentials, capabilities, status, is_enabled, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', 1, ?, ?)
		`).run(
			id,
			input.provider,
			input.label,
			input.projectId ?? null,
			input.authMethod,
			sealFor(TABLE, 'credentials', JSON.stringify(input.credentials)),
			JSON.stringify(input.capabilities),
			now,
			now
		);

		return this.getById(id)!;
	},

	/**
	 * Replace the stored credentials.
	 *
	 * The caller merges — an empty value from the form means "the field was not
	 * re-typed", not "clear it", the same rule the db-client and SSH forms use.
	 */
	setCredentials(id: string, credentials: Record<string, string>): void {
		const db = getDatabase();
		db.prepare(`UPDATE integration_accounts SET credentials = ?, updated_at = ? WHERE id = ?`).run(
			sealFor(TABLE, 'credentials', JSON.stringify(credentials)),
			new Date().toISOString(),
			id
		);
	},

	setCapabilities(id: string, capabilities: IntegrationCapability[]): void {
		const db = getDatabase();
		db.prepare(`UPDATE integration_accounts SET capabilities = ?, updated_at = ? WHERE id = ?`).run(
			JSON.stringify(capabilities),
			new Date().toISOString(),
			id
		);
	},

	setEnabled(id: string, enabled: boolean): void {
		const db = getDatabase();
		db.prepare(`UPDATE integration_accounts SET is_enabled = ?, updated_at = ? WHERE id = ?`).run(
			enabled ? 1 : 0,
			new Date().toISOString(),
			id
		);
	},

	setProject(id: string, projectId: string | null): void {
		const db = getDatabase();
		db.prepare(`UPDATE integration_accounts SET project_id = ?, updated_at = ? WHERE id = ?`).run(
			projectId,
			new Date().toISOString(),
			id
		);
	},

	setStatus(id: string, status: IntegrationStatus, detail: string | null): void {
		const db = getDatabase();
		db.prepare(
			`UPDATE integration_accounts SET status = ?, status_detail = ?, checked_at = ? WHERE id = ?`
		).run(status, detail, new Date().toISOString(), id);
	},

	remove(id: string): void {
		const db = getDatabase();
		db.prepare(`DELETE FROM integration_accounts WHERE id = ?`).run(id);
	}
};

export const integrationProjectionQueries = {
	getForAccount(accountId: string): IntegrationProjectionRow[] {
		const db = getDatabase();
		return db.prepare(
			`SELECT * FROM integration_projections WHERE account_id = ?`
		).all(accountId) as IntegrationProjectionRow[];
	},

	getAll(): IntegrationProjectionRow[] {
		const db = getDatabase();
		return db.prepare(`SELECT * FROM integration_projections`).all() as IntegrationProjectionRow[];
	},

	/** Who, if anyone, owns this surface row. Used to badge it read-only. */
	getByTarget(targetKind: IntegrationTargetKind, targetId: string): IntegrationProjectionRow | null {
		const db = getDatabase();
		return db.prepare(
			`SELECT * FROM integration_projections WHERE target_kind = ? AND target_id = ?`
		).get(targetKind, targetId) as IntegrationProjectionRow | null;
	},

	upsert(input: {
		accountId: string;
		capability: IntegrationCapability;
		targetKind: IntegrationTargetKind;
		targetId: string;
		adopted: boolean;
		restore: unknown | null;
	}): void {
		const db = getDatabase();
		db.prepare(`
			INSERT INTO integration_projections (account_id, capability, target_kind, target_id, adopted, restore_json, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (account_id, capability, target_kind) DO UPDATE SET
				target_id = excluded.target_id,
				adopted   = excluded.adopted
		`).run(
			input.accountId,
			input.capability,
			input.targetKind,
			input.targetId,
			input.adopted ? 1 : 0,
			input.restore === null ? null : JSON.stringify(input.restore),
			new Date().toISOString()
		);
	},

	remove(accountId: string, capability: IntegrationCapability, targetKind: IntegrationTargetKind): void {
		const db = getDatabase();
		db.prepare(
			`DELETE FROM integration_projections WHERE account_id = ? AND capability = ? AND target_kind = ?`
		).run(accountId, capability, targetKind);
	},

	/** The snapshot taken when an existing row was adopted, or null. */
	restoreOf<T>(row: IntegrationProjectionRow): T | null {
		return parse<T | null>(row.restore_json, null);
	}
};

export const integrationWebhookQueries = {
	/**
	 * Record a delivery, returning false when it has already been seen.
	 *
	 * The UNIQUE constraint IS the replay check. A read-then-write would let two
	 * concurrent deliveries of the same event both pass the read and both run.
	 */
	claimDelivery(provider: string, deliveryId: string): boolean {
		const db = getDatabase();
		const result = db.prepare(`
			INSERT OR IGNORE INTO integration_webhook_deliveries (provider, delivery_id, received_at)
			VALUES (?, ?, ?)
		`).run(provider, deliveryId, new Date().toISOString()) as { changes: number };
		return result.changes > 0;
	},

	/** Drop delivery ids older than the retention window so the table stays bounded. */
	pruneBefore(isoTimestamp: string): number {
		const db = getDatabase();
		const result = db.prepare(
			`DELETE FROM integration_webhook_deliveries WHERE received_at < ?`
		).run(isoTimestamp) as { changes: number };
		return result.changes;
	}
};
