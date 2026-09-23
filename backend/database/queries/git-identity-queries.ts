/**
 * Git identity storage — rows in, rows out, secrets sealed at this boundary.
 *
 * Every write that touches `ssh_private_key`, `ssh_passphrase` or `https_token`
 * goes through `sealFor`, and every read goes through `openRow`, which is the
 * contract `backend/database/crypto/secret-columns.ts` audits at startup.
 * Nothing above this module handles a sealed value.
 *
 * Secrets are UPDATED ONLY WHEN SUPPLIED. `undefined` means "leave what is
 * stored", `null` means "clear it". Without that distinction every edit of a
 * label would have to round-trip the private key through the browser to avoid
 * wiping it — which is exactly what the DTO refuses to do.
 */

import { getDatabase } from '../index';
import { openRow, openRows, sealFor } from '../crypto/secret-columns';
import type { GitIdentityAuthMethod, GitIdentitySource } from '$shared/types/git-identity';

const TABLE = 'git_identities';

export interface GitIdentityRow {
	id: string;
	owner_user_id: string;
	label: string;
	name: string;
	email: string;
	auth_method: GitIdentityAuthMethod;
	ssh_private_key: string | null;
	ssh_public_key: string | null;
	ssh_passphrase: string | null;
	https_username: string | null;
	https_token: string | null;
	integration_account_id: string | null;
	hosts: string;
	is_default: number;
	source: GitIdentitySource;
	created_at: string;
	updated_at: string;
}

export interface GitIdentityBindingRow {
	project_id: string;
	user_id: string;
	identity_id: string;
	created_at: string;
	updated_at: string;
}

/** Create/update payload. Omitted secret fields keep their stored value. */
export interface GitIdentityWrite {
	label: string;
	name: string;
	email: string;
	authMethod: GitIdentityAuthMethod;
	hosts: string[];
	sshPrivateKey?: string | null;
	sshPublicKey?: string | null;
	sshPassphrase?: string | null;
	httpsUsername?: string | null;
	httpsToken?: string | null;
	integrationAccountId?: string | null;
	/** Only honoured on create — `update` never moves a row between sources. */
	source?: GitIdentitySource;
}

/**
 * Parse the stored `hosts` JSON into a lowercased list.
 *
 * Tolerant on read: a malformed blob yields no host claim rather than throwing,
 * because the identity is still perfectly usable for attribution and failing
 * the whole read would take the user's commit identity with it.
 */
export function parseHosts(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((h): h is string => typeof h === 'string')
			.map((h) => h.trim().toLowerCase())
			.filter(Boolean);
	} catch {
		return [];
	}
}

function serializeHosts(hosts: string[]): string {
	const normalized = hosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
	return JSON.stringify([...new Set(normalized)]);
}

export const gitIdentityQueries = {
	getById(id: string): GitIdentityRow | null {
		const db = getDatabase();
		const row = db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(id) as
			| GitIdentityRow
			| undefined;
		return row ? openRow(TABLE, row) : null;
	},

	listByUser(userId: string): GitIdentityRow[] {
		const db = getDatabase();
		const rows = db
			.prepare(`SELECT * FROM ${TABLE} WHERE owner_user_id = ? ORDER BY is_default DESC, label`)
			.all(userId) as GitIdentityRow[];
		return openRows(TABLE, rows);
	},

	/** The row mirrored from the machine's global git config, if there is one. */
	getLocalMachine(userId: string): GitIdentityRow | null {
		const db = getDatabase();
		const row = db
			.prepare(`SELECT * FROM ${TABLE} WHERE owner_user_id = ? AND source = 'local-machine'`)
			.get(userId) as GitIdentityRow | undefined;
		return row ? openRow(TABLE, row) : null;
	},

	getDefaultForUser(userId: string): GitIdentityRow | null {
		const db = getDatabase();
		const row = db
			.prepare(`SELECT * FROM ${TABLE} WHERE owner_user_id = ? AND is_default = 1`)
			.get(userId) as GitIdentityRow | undefined;
		return row ? openRow(TABLE, row) : null;
	},

	create(id: string, userId: string, input: GitIdentityWrite): GitIdentityRow {
		const db = getDatabase();
		const now = new Date().toISOString();
		db.prepare(
			`
			INSERT INTO ${TABLE} (
				id, owner_user_id, label, name, email, auth_method,
				ssh_private_key, ssh_public_key, ssh_passphrase,
				https_username, https_token, integration_account_id,
				hosts, is_default, source, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
		`
		).run(
			id,
			userId,
			input.label,
			input.name,
			input.email,
			input.authMethod,
			sealFor(TABLE, 'ssh_private_key', input.sshPrivateKey ?? null),
			input.sshPublicKey ?? null,
			sealFor(TABLE, 'ssh_passphrase', input.sshPassphrase ?? null),
			input.httpsUsername ?? null,
			sealFor(TABLE, 'https_token', input.httpsToken ?? null),
			input.integrationAccountId ?? null,
			serializeHosts(input.hosts),
			input.source ?? 'manual',
			now,
			now
		);
		return this.getById(id)!;
	},

	update(id: string, input: GitIdentityWrite): GitIdentityRow | null {
		const db = getDatabase();
		const existing = db.prepare(`SELECT id FROM ${TABLE} WHERE id = ?`).get(id);
		if (!existing) return null;

		// Secrets are appended conditionally so an omitted field never becomes a
		// stored NULL. Column and parameter lists are built together to keep them
		// impossible to misalign.
		const sets: string[] = [
			'label = ?',
			'name = ?',
			'email = ?',
			'auth_method = ?',
			'hosts = ?',
			'ssh_public_key = ?',
			'https_username = ?',
			'integration_account_id = ?',
			'updated_at = ?'
		];
		const params: unknown[] = [
			input.label,
			input.name,
			input.email,
			input.authMethod,
			serializeHosts(input.hosts),
			input.sshPublicKey ?? null,
			input.httpsUsername ?? null,
			input.integrationAccountId ?? null,
			new Date().toISOString()
		];

		if (input.sshPrivateKey !== undefined) {
			sets.push('ssh_private_key = ?');
			params.push(sealFor(TABLE, 'ssh_private_key', input.sshPrivateKey));
		}
		if (input.sshPassphrase !== undefined) {
			sets.push('ssh_passphrase = ?');
			params.push(sealFor(TABLE, 'ssh_passphrase', input.sshPassphrase));
		}
		if (input.httpsToken !== undefined) {
			sets.push('https_token = ?');
			params.push(sealFor(TABLE, 'https_token', input.httpsToken));
		}

		params.push(id);
		db.prepare(`UPDATE ${TABLE} SET ${sets.join(', ')} WHERE id = ?`).run(...(params as never[]));
		return this.getById(id);
	},

	/**
	 * Make one identity the user's default, clearing any previous one.
	 *
	 * Both statements run in a transaction because the partial unique index
	 * rejects a moment where two rows claim the default — clearing first and
	 * setting second is not optional, it is what makes the write legal.
	 */
	setDefault(userId: string, id: string): void {
		const db = getDatabase();
		const swap = () => {
			db.prepare(`UPDATE ${TABLE} SET is_default = 0 WHERE owner_user_id = ? AND is_default = 1`).run(
				userId
			);
			db.prepare(`UPDATE ${TABLE} SET is_default = 1, updated_at = ? WHERE id = ? AND owner_user_id = ?`).run(
				new Date().toISOString(),
				id,
				userId
			);
		};
		// Not every driver exposes transactions (see `DatabaseConnection`). Running
		// it unbatched is a worse guarantee, not a wrong result: the clear still
		// precedes the set, which is what the partial unique index requires.
		if (db.transaction) db.transaction(swap)();
		else swap();
	},

	remove(id: string): boolean {
		const db = getDatabase();
		const result = db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).run(id) as { changes: number };
		return result.changes > 0;
	},

	/** True when the label is already taken by another of this user's identities. */
	labelTaken(userId: string, label: string, exceptId?: string): boolean {
		const db = getDatabase();
		const row = db
			.prepare(
				`SELECT id FROM ${TABLE} WHERE owner_user_id = ? AND label = ? AND id IS NOT ?`
			)
			.get(userId, label, exceptId ?? null);
		return !!row;
	}
};

export const gitIdentityBindingQueries = {
	get(projectId: string, userId: string): GitIdentityBindingRow | null {
		const db = getDatabase();
		const row = db
			.prepare('SELECT * FROM git_identity_bindings WHERE project_id = ? AND user_id = ?')
			.get(projectId, userId) as GitIdentityBindingRow | undefined;
		return row ?? null;
	},

	set(projectId: string, userId: string, identityId: string): void {
		const db = getDatabase();
		const now = new Date().toISOString();
		db.prepare(
			`
			INSERT INTO git_identity_bindings (project_id, user_id, identity_id, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(project_id, user_id) DO UPDATE SET
				identity_id = excluded.identity_id,
				updated_at = excluded.updated_at
		`
		).run(projectId, userId, identityId, now, now);
	},

	clear(projectId: string, userId: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM git_identity_bindings WHERE project_id = ? AND user_id = ?').run(
			projectId,
			userId
		);
	},

	/** Projects this identity is bound to — what a delete confirmation shows. */
	countForIdentity(identityId: string): number {
		const db = getDatabase();
		const row = db
			.prepare('SELECT COUNT(*) as count FROM git_identity_bindings WHERE identity_id = ?')
			.get(identityId) as { count: number };
		return row.count;
	}
};
