/**
 * Which remote databases an account brought into DB Client.
 *
 * A link is the answer to "which one", asked once per database rather than once
 * per credential. It is the database counterpart of `deploy_bindings`: the
 * account holds the token, and everything that varies per remote database —
 * which project, which connection mode, and the password the provider will not
 * hand back — lives here.
 *
 * `secrets` is sealed at rest by the crypto layer, so callers here hand in and
 * receive a plain object and never see an envelope. A blob that the active key
 * cannot open reads as `{}`, which the projector treats exactly as it treats a
 * link whose password was never entered: it projects a connection that cannot
 * log in and says so, rather than throwing on every read path.
 */

import { getDatabase } from '../index';
import { openRow, sealFor } from '../crypto';
import type { DbDriver } from '$shared/types/db-client';

const TABLE = 'integration_db_links';

export interface IntegrationDbLinkRow {
	id: string;
	account_id: string;
	/** The provider's own id for the database — a Supabase project ref. */
	remote_ref: string;
	label: string;
	driver: DbDriver;
	mode: string;
	/** Sealed on disk, plain JSON string here. Null when the key could not open it. */
	secrets: string | null;
	config_json: string;
	detected: number;
	created_at: string;
	updated_at: string;
}

export interface IntegrationDbLinkInput {
	accountId: string;
	remoteRef: string;
	label: string;
	driver: DbDriver;
	mode: string;
	secrets: Record<string, string>;
	config: Record<string, unknown>;
	detected?: boolean;
}

function parse<T>(raw: string | null, fallback: T): T {
	if (!raw) return fallback;
	try {
		const parsed = JSON.parse(raw);
		return (parsed ?? fallback) as T;
	} catch {
		return fallback;
	}
}

function openLink<T extends IntegrationDbLinkRow | null>(row: T): T {
	return (row ? openRow(TABLE, row) : row) as T;
}

export const integrationDbLinkQueries = {
	getForAccount(accountId: string): IntegrationDbLinkRow[] {
		const db = getDatabase();
		return (db.prepare(
			`SELECT * FROM integration_db_links WHERE account_id = ? ORDER BY label ASC`
		).all(accountId) as IntegrationDbLinkRow[]).map((row) => openLink(row));
	},

	getById(id: string): IntegrationDbLinkRow | null {
		const db = getDatabase();
		return openLink(
			db.prepare(`SELECT * FROM integration_db_links WHERE id = ?`).get(id) as IntegrationDbLinkRow | null
		);
	},

	getByRef(accountId: string, remoteRef: string): IntegrationDbLinkRow | null {
		const db = getDatabase();
		return openLink(
			db.prepare(
				`SELECT * FROM integration_db_links WHERE account_id = ? AND remote_ref = ?`
			).get(accountId, remoteRef) as IntegrationDbLinkRow | null
		);
	},

	secretsOf(row: IntegrationDbLinkRow): Record<string, string> {
		return parse<Record<string, string>>(row.secrets, {});
	},

	configOf<T = Record<string, unknown>>(row: IntegrationDbLinkRow): T {
		return parse<T>(row.config_json, {} as T);
	},

	create(input: IntegrationDbLinkInput): IntegrationDbLinkRow {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		db.prepare(`
			INSERT INTO integration_db_links (
				id, account_id, remote_ref, label, driver, mode,
				secrets, config_json, detected, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			id,
			input.accountId,
			input.remoteRef,
			input.label,
			input.driver,
			input.mode,
			sealFor(TABLE, 'secrets', JSON.stringify(input.secrets)),
			JSON.stringify(input.config),
			input.detected ? 1 : 0,
			now,
			now
		);

		return this.getById(id)!;
	},

	/**
	 * Patch a link.
	 *
	 * `secrets` is REPLACED rather than merged, and the caller merges — an empty
	 * password field means "not re-typed", not "clear it", the same rule the
	 * db-client and SSH forms already use.
	 */
	update(
		id: string,
		patch: { label?: string; mode?: string; secrets?: Record<string, string>; config?: Record<string, unknown> }
	): IntegrationDbLinkRow | null {
		const db = getDatabase();
		const sets: string[] = [];
		const values: unknown[] = [];

		if (patch.label !== undefined) {
			sets.push('label = ?');
			values.push(patch.label);
		}
		if (patch.mode !== undefined) {
			sets.push('mode = ?');
			values.push(patch.mode);
		}
		if (patch.secrets !== undefined) {
			sets.push('secrets = ?');
			values.push(sealFor(TABLE, 'secrets', JSON.stringify(patch.secrets)));
		}
		if (patch.config !== undefined) {
			sets.push('config_json = ?');
			values.push(JSON.stringify(patch.config));
		}

		if (sets.length === 0) return this.getById(id);

		sets.push('updated_at = ?');
		values.push(new Date().toISOString(), id);

		db.prepare(`UPDATE integration_db_links SET ${sets.join(', ')} WHERE id = ?`).run(...values);
		return this.getById(id);
	},

	remove(id: string): void {
		const db = getDatabase();
		db.prepare(`DELETE FROM integration_db_links WHERE id = ?`).run(id);
	}
};
