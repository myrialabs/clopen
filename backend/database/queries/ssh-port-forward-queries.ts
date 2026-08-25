import { getDatabase } from '../index';
import type { DBSshPortForwardRow } from '$shared/types/database/schema';
import type { SshForward, SshForwardInput, SshForwardType } from '$shared/types/ssh';

function rowToForward(row: DBSshPortForwardRow): SshForward {
	return {
		id: row.id,
		connectionId: row.connection_id,
		name: row.name,
		type: row.type as SshForwardType,
		listenHost: row.listen_host,
		listenPort: row.listen_port,
		destHost: row.dest_host,
		destPort: row.dest_port,
		autoStart: row.auto_start === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function getRowById(id: string): DBSshPortForwardRow | null {
	const db = getDatabase();
	return db.prepare('SELECT * FROM ssh_port_forwards WHERE id = ?').get(id) as DBSshPortForwardRow | null;
}

export const sshPortForwardQueries = {
	listForConnection(connectionId: string): SshForward[] {
		const db = getDatabase();
		const rows = db.prepare(`
			SELECT * FROM ssh_port_forwards WHERE connection_id = ? ORDER BY created_at ASC
		`).all(connectionId) as DBSshPortForwardRow[];
		return rows.map(rowToForward);
	},

	get(id: string): SshForward | null {
		const row = getRowById(id);
		return row ? rowToForward(row) : null;
	},

	create(connectionId: string, input: SshForwardInput): SshForward {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		db.prepare(`
			INSERT INTO ssh_port_forwards (
				id, connection_id, name, type,
				listen_host, listen_port, dest_host, dest_port,
				auto_start, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			id,
			connectionId,
			input.name,
			input.type,
			input.listenHost || '127.0.0.1',
			input.listenPort,
			input.type === 'dynamic' ? null : (input.destHost || null),
			input.type === 'dynamic' ? null : (input.destPort ?? null),
			input.autoStart ? 1 : 0,
			now,
			now
		);

		const created = this.get(id);
		if (!created) throw new Error('ssh port forward not found');
		return created;
	},

	update(id: string, patch: Partial<SshForwardInput>): SshForward {
		const db = getDatabase();
		const existing = getRowById(id);
		if (!existing) throw new Error('ssh port forward not found');

		const sets: string[] = [];
		const values: unknown[] = [];
		const push = (column: string, value: unknown): void => {
			sets.push(`${column} = ?`);
			values.push(value);
		};

		const type = (patch.type ?? existing.type) as SshForwardType;

		if (patch.name !== undefined) push('name', patch.name);
		if (patch.type !== undefined) push('type', patch.type);
		if (patch.listenHost !== undefined) push('listen_host', patch.listenHost || '127.0.0.1');
		if (patch.listenPort !== undefined) push('listen_port', patch.listenPort);
		// A dynamic forward has no fixed destination; clear it so a type switch
		// never leaves a stale host:port behind.
		if (type === 'dynamic') {
			push('dest_host', null);
			push('dest_port', null);
		} else {
			if (patch.destHost !== undefined) push('dest_host', patch.destHost || null);
			if (patch.destPort !== undefined) push('dest_port', patch.destPort ?? null);
		}
		if (patch.autoStart !== undefined) push('auto_start', patch.autoStart ? 1 : 0);

		push('updated_at', new Date().toISOString());

		values.push(id);
		db.prepare(`UPDATE ssh_port_forwards SET ${sets.join(', ')} WHERE id = ?`).run(...values);

		const updated = this.get(id);
		if (!updated) throw new Error('ssh port forward not found');
		return updated;
	},

	delete(id: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM ssh_port_forwards WHERE id = ?').run(id);
	}
};
