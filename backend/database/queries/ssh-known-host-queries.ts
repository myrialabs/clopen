import { getDatabase } from '../index';
import type { DBSshKnownHostRow } from '$shared/types/database/schema';
import type { SshKnownHost } from '$shared/types/ssh';

function rowToKnownHost(row: DBSshKnownHostRow): SshKnownHost {
	return {
		id: row.id,
		host: row.host,
		port: row.port,
		keyType: row.key_type,
		fingerprint: row.fingerprint,
		addedAt: row.added_at,
		lastSeenAt: row.last_seen_at
	};
}

export const sshKnownHostQueries = {
	list(): SshKnownHost[] {
		const db = getDatabase();
		const rows = db.prepare(`
			SELECT * FROM ssh_known_hosts ORDER BY host ASC, port ASC
		`).all() as DBSshKnownHostRow[];
		return rows.map(rowToKnownHost);
	},

	find(host: string, port: number): SshKnownHost | null {
		const db = getDatabase();
		const row = db.prepare(`
			SELECT * FROM ssh_known_hosts WHERE host = ? AND port = ?
		`).get(host, port) as DBSshKnownHostRow | null;
		return row ? rowToKnownHost(row) : null;
	},

	/**
	 * Record the key a host presented, replacing any previous one. Used both for
	 * trust-on-first-use and for an explicit "trust the new key" after a change.
	 */
	trust(host: string, port: number, keyType: string, fingerprint: string): SshKnownHost {
		const db = getDatabase();
		const now = new Date().toISOString();
		db.prepare(`
			INSERT INTO ssh_known_hosts (id, host, port, key_type, fingerprint, added_at, last_seen_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (host, port) DO UPDATE SET
				key_type = excluded.key_type,
				fingerprint = excluded.fingerprint,
				added_at = excluded.added_at,
				last_seen_at = excluded.last_seen_at
		`).run(crypto.randomUUID(), host, port, keyType, fingerprint, now, now);

		const saved = this.find(host, port);
		if (!saved) throw new Error('Failed to record host key');
		return saved;
	},

	markSeen(host: string, port: number): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE ssh_known_hosts SET last_seen_at = ? WHERE host = ? AND port = ?
		`).run(new Date().toISOString(), host, port);
	},

	forget(host: string, port: number): void {
		const db = getDatabase();
		db.prepare('DELETE FROM ssh_known_hosts WHERE host = ? AND port = ?').run(host, port);
	}
};
