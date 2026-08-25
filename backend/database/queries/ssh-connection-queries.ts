import { getDatabase } from '../index';
import type { DBSshConnectionRow } from '$shared/types/database/schema';
import type { SshAuthMethod, SshConnection, SshConnectionInput } from '$shared/types/ssh';

function rowToConnection(row: DBSshConnectionRow): SshConnection {
	return {
		id: row.id,
		name: row.name,
		host: row.host,
		port: row.port,
		username: row.username,
		authMethod: row.auth_method as SshAuthMethod,
		password: row.password,
		privateKey: row.private_key,
		privateKeyPath: row.private_key_path,
		passphrase: row.passphrase,
		agentSocket: row.agent_socket,
		jumpConnectionId: row.jump_connection_id,
		initialPath: row.initial_path,
		keepaliveSeconds: row.keepalive_seconds,
		strictHostKey: row.strict_host_key === 1,
		color: row.color,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastUsedAt: row.last_used_at
	};
}

/**
 * Strip every secret before a connection leaves the server. The client only
 * ever needs to know *whether* a credential is set, which it infers from the
 * auth method — mirrors db-client's redactConnectionSecrets.
 */
function redactConnectionSecrets(connection: SshConnection): SshConnection {
	return {
		...connection,
		password: null,
		privateKey: null,
		passphrase: null
	};
}

function hasConnectionAccess(row: DBSshConnectionRow, userId: string, isAdmin: boolean): boolean {
	if (isAdmin) return true;
	return row.owner_user_id === userId;
}

/**
 * An empty string in a patch means "the form did not re-send this secret",
 * not "clear it" — otherwise editing the name of a key-authenticated host
 * would wipe the key.
 */
function preserveExistingSecret(patchValue: string | undefined, existingValue: string | null): string | null {
	if (patchValue === undefined || patchValue === '') return existingValue;
	return patchValue;
}

function getRowById(id: string): DBSshConnectionRow | null {
	const db = getDatabase();
	return db.prepare('SELECT * FROM ssh_connections WHERE id = ?').get(id) as DBSshConnectionRow | null;
}

/**
 * True when adding `jumpConnectionId` as `connectionId`'s bastion would create
 * a cycle (A jumps through B which jumps back through A). Walking the chain is
 * cheap and stops an unbounded connect loop at save time rather than at dial time.
 */
function wouldCycle(connectionId: string, jumpConnectionId: string | null): boolean {
	let cursor = jumpConnectionId;
	const visited = new Set<string>([connectionId]);
	while (cursor) {
		if (visited.has(cursor)) return true;
		visited.add(cursor);
		cursor = getRowById(cursor)?.jump_connection_id ?? null;
	}
	return false;
}

function insertConnection(input: SshConnectionInput, ownerUserId: string | null): SshConnection {
	const db = getDatabase();
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	db.prepare(`
		INSERT INTO ssh_connections (
			id, name, host, port, username, auth_method,
			password, private_key, private_key_path, passphrase, agent_socket,
			jump_connection_id, initial_path, keepalive_seconds, strict_host_key,
			color, owner_user_id, created_at, updated_at, last_used_at
		) VALUES (
			?, ?, ?, ?, ?, ?,
			?, ?, ?, ?, ?,
			?, ?, ?, ?,
			?, ?, ?, ?, ?
		)
	`).run(
		id,
		input.name,
		input.host,
		input.port ?? 22,
		input.username,
		input.authMethod ?? 'password',
		input.password || null,
		input.privateKey || null,
		input.privateKeyPath || null,
		input.passphrase || null,
		input.agentSocket || null,
		input.jumpConnectionId || null,
		input.initialPath || null,
		input.keepaliveSeconds ?? 30,
		input.strictHostKey === false ? 0 : 1,
		input.color || null,
		ownerUserId,
		now,
		now,
		null
	);

	const row = getRowById(id);
	if (!row) throw new Error('ssh connection not found');
	return rowToConnection(row);
}

export const sshConnectionQueries = {
	listForUser(userId: string, isAdmin: boolean): SshConnection[] {
		const db = getDatabase();
		const rows = (isAdmin
			? db.prepare(`
				SELECT * FROM ssh_connections
				ORDER BY (last_used_at IS NULL), last_used_at DESC, created_at DESC
			`).all()
			: db.prepare(`
				SELECT * FROM ssh_connections
				WHERE owner_user_id = ?
				ORDER BY (last_used_at IS NULL), last_used_at DESC, created_at DESC
			`).all(userId)) as DBSshConnectionRow[];

		return rows.map((row) => redactConnectionSecrets(rowToConnection(row)));
	},

	getForUser(id: string, userId: string, isAdmin: boolean): SshConnection | null {
		const row = getRowById(id);
		if (!row || !hasConnectionAccess(row, userId, isAdmin)) return null;
		return redactConnectionSecrets(rowToConnection(row));
	},

	/** Full connection including secrets — server-side callers only. Throws on denial. */
	ensureAccess(id: string, userId: string, isAdmin: boolean): SshConnection {
		const row = getRowById(id);
		if (!row || !hasConnectionAccess(row, userId, isAdmin)) {
			throw new Error('ssh connection not found');
		}
		return rowToConnection(row);
	},

	get(id: string): SshConnection | null {
		const row = getRowById(id);
		return row ? rowToConnection(row) : null;
	},

	createForUser(input: SshConnectionInput, ownerUserId: string): SshConnection {
		if (input.jumpConnectionId && !getRowById(input.jumpConnectionId)) {
			throw new Error('Jump host not found');
		}
		return redactConnectionSecrets(insertConnection(input, ownerUserId));
	},

	update(id: string, patch: Partial<SshConnectionInput>): SshConnection {
		const db = getDatabase();
		const existing = getRowById(id);
		if (!existing) throw new Error('ssh connection not found');

		const sets: string[] = [];
		const values: unknown[] = [];
		const push = (column: string, value: unknown): void => {
			sets.push(`${column} = ?`);
			values.push(value);
		};

		if (patch.name !== undefined) push('name', patch.name);
		if (patch.host !== undefined) push('host', patch.host);
		if (patch.port !== undefined) push('port', patch.port ?? 22);
		if (patch.username !== undefined) push('username', patch.username);
		if (patch.authMethod !== undefined) push('auth_method', patch.authMethod);
		if (patch.privateKeyPath !== undefined) push('private_key_path', patch.privateKeyPath || null);
		if (patch.agentSocket !== undefined) push('agent_socket', patch.agentSocket || null);
		if (patch.initialPath !== undefined) push('initial_path', patch.initialPath || null);
		if (patch.keepaliveSeconds !== undefined) push('keepalive_seconds', patch.keepaliveSeconds ?? 30);
		if (patch.strictHostKey !== undefined) push('strict_host_key', patch.strictHostKey ? 1 : 0);
		if (patch.color !== undefined) push('color', patch.color || null);

		if (patch.jumpConnectionId !== undefined) {
			const jumpConnectionId = patch.jumpConnectionId || null;
			if (jumpConnectionId && !getRowById(jumpConnectionId)) {
				throw new Error('Jump host not found');
			}
			if (jumpConnectionId === id) {
				throw new Error('A host cannot jump through itself');
			}
			if (wouldCycle(id, jumpConnectionId)) {
				throw new Error('That jump host would create a loop');
			}
			push('jump_connection_id', jumpConnectionId);
		}

		if (patch.password !== undefined) push('password', preserveExistingSecret(patch.password, existing.password));
		if (patch.privateKey !== undefined) push('private_key', preserveExistingSecret(patch.privateKey, existing.private_key));
		if (patch.passphrase !== undefined) push('passphrase', preserveExistingSecret(patch.passphrase, existing.passphrase));

		push('updated_at', new Date().toISOString());

		values.push(id);
		db.prepare(`UPDATE ssh_connections SET ${sets.join(', ')} WHERE id = ?`).run(...values);

		const row = getRowById(id);
		if (!row) throw new Error('ssh connection not found');
		return rowToConnection(row);
	},

	updateForUser(
		id: string,
		patch: Partial<SshConnectionInput>,
		userId: string,
		isAdmin: boolean
	): SshConnection {
		this.ensureAccess(id, userId, isAdmin);
		return redactConnectionSecrets(this.update(id, patch));
	},

	delete(id: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM ssh_connections WHERE id = ?').run(id);
	},

	deleteForUser(id: string, userId: string, isAdmin: boolean): void {
		this.ensureAccess(id, userId, isAdmin);
		this.delete(id);
	},

	markUsed(id: string): void {
		const db = getDatabase();
		db.prepare('UPDATE ssh_connections SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
	}
};
