import { getDatabase } from '../index';
import type { DBDbClientConnectionRow } from '$shared/types/database/schema';
import type {
	DbClientConnection,
	DbClientConnectionInput,
	DbClientSshConfig,
	DbDriver,
	DbSshAuthMethod,
	DbSslMode
} from '$shared/types/db-client';

const DEFAULT_SSH: DbClientSshConfig = {
	enabled: false,
	host: '',
	port: 22,
	username: '',
	authMethod: 'password',
	password: '',
	privateKey: '',
	passphrase: ''
};

function rowToConnection(row: DBDbClientConnectionRow): DbClientConnection {
	let options: Record<string, unknown> = {};
	if (row.options_json) {
		try {
			const parsed = JSON.parse(row.options_json);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				options = parsed as Record<string, unknown>;
			}
		} catch {
			options = {};
		}
	}

	const ssh: DbClientSshConfig = {
		enabled: row.ssh_enabled === 1,
		host: row.ssh_host ?? '',
		port: row.ssh_port ?? 22,
		username: row.ssh_username ?? '',
		authMethod: (row.ssh_auth_method ?? 'password') as DbSshAuthMethod,
		password: row.ssh_password ?? '',
		privateKey: row.ssh_private_key ?? '',
		passphrase: row.ssh_passphrase ?? ''
	};

	return {
		id: row.id,
		name: row.name,
		driver: row.driver as DbDriver,
		host: row.host,
		port: row.port,
		username: row.username,
		password: row.password,
		database: row.database,
		sslMode: (row.ssl_mode ?? 'disable') as DbSslMode,
		sslCa: row.ssl_ca,
		ssh,
		options,
		color: row.color,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastUsedAt: row.last_used_at
	};
}

function redactConnectionSecrets(connection: DbClientConnection): DbClientConnection {
	return {
		...connection,
		password: null,
		ssh: {
			...connection.ssh,
			password: undefined,
			privateKey: undefined,
			passphrase: undefined
		}
	};
}

function hasConnectionAccess(
	row: DBDbClientConnectionRow,
	userId: string,
	isAdmin: boolean
): boolean {
	if (isAdmin) return true;
	return row.owner_user_id === userId;
}

function preserveExistingSecret(
	patchValue: string | undefined,
	existingValue: string | null
): string | null {
	if (patchValue === undefined || patchValue === '') return existingValue;
	return patchValue;
}

interface InsertParams {
	name: string;
	driver: DbDriver;
	host: string | null;
	port: number | null;
	username: string | null;
	password: string | null;
	database: string | null;
	sslMode: DbSslMode;
	sslCa: string | null;
	ssh: DbClientSshConfig;
	options: Record<string, unknown>;
	color: string | null;
	ownerUserId: string | null;
}

function normalizeInput(input: DbClientConnectionInput, ownerUserId: string | null): InsertParams {
	const ssh: DbClientSshConfig = {
		...DEFAULT_SSH,
		...(input.ssh ?? {})
	};
	return {
		name: input.name,
		driver: input.driver,
		host: input.host ?? null,
		port: input.port ?? null,
		username: input.username ?? null,
		password: input.password ?? null,
		database: input.database ?? null,
		sslMode: input.sslMode ?? 'disable',
		sslCa: input.sslCa ?? null,
		ssh,
		options: input.options ?? {},
		color: input.color ?? null,
		ownerUserId
	};
}

function getRowById(id: string): DBDbClientConnectionRow | null {
	const db = getDatabase();
	return db.prepare(`
		SELECT * FROM db_client_connections WHERE id = ?
	`).get(id) as DBDbClientConnectionRow | null;
}

function insertConnection(input: DbClientConnectionInput, ownerUserId: string | null): DbClientConnection {
	const db = getDatabase();
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const params = normalizeInput(input, ownerUserId);

	db.prepare(`
		INSERT INTO db_client_connections (
			id, name, driver,
			host, port, username, password, database,
			ssl_mode, ssl_ca,
			ssh_enabled, ssh_host, ssh_port, ssh_username, ssh_auth_method,
			ssh_password, ssh_private_key, ssh_passphrase,
			options_json, color,
			owner_user_id,
			created_at, updated_at, last_used_at
		) VALUES (
			?, ?, ?,
			?, ?, ?, ?, ?,
			?, ?,
			?, ?, ?, ?, ?,
			?, ?, ?,
			?, ?,
			?,
			?, ?, ?
		)
	`).run(
		id, params.name, params.driver,
		params.host, params.port, params.username, params.password, params.database,
		params.sslMode, params.sslCa,
		params.ssh.enabled ? 1 : 0,
		params.ssh.host || null,
		params.ssh.port,
		params.ssh.username || null,
		params.ssh.authMethod,
		params.ssh.password || null,
		params.ssh.privateKey || null,
		params.ssh.passphrase || null,
		JSON.stringify(params.options),
		params.color,
		params.ownerUserId,
		now, now, null
	);

	const row = getRowById(id);
	if (!row) {
		throw new Error('db-client connection not found');
	}
	return rowToConnection(row);
}

export const dbClientConnectionQueries = {
	listForUser(userId: string, isAdmin: boolean): DbClientConnection[] {
		const db = getDatabase();
		const rows = (isAdmin
			? db.prepare(`
				SELECT * FROM db_client_connections
				ORDER BY (last_used_at IS NULL), last_used_at DESC, created_at DESC
			`).all()
			: db.prepare(`
				SELECT * FROM db_client_connections
				WHERE owner_user_id = ?
				ORDER BY (last_used_at IS NULL), last_used_at DESC, created_at DESC
			`).all(userId)) as DBDbClientConnectionRow[];

		return rows.map((row) => redactConnectionSecrets(rowToConnection(row)));
	},

	getForUser(id: string, userId: string, isAdmin: boolean): DbClientConnection | null {
		const row = getRowById(id);
		if (!row || !hasConnectionAccess(row, userId, isAdmin)) {
			return null;
		}
		return redactConnectionSecrets(rowToConnection(row));
	},

	ensureAccess(id: string, userId: string, isAdmin: boolean): DbClientConnection {
		const row = getRowById(id);
		if (!row || !hasConnectionAccess(row, userId, isAdmin)) {
			throw new Error('db-client connection not found');
		}
		return rowToConnection(row);
	},

	list(): DbClientConnection[] {
		const db = getDatabase();
		const rows = db.prepare(`
			SELECT * FROM db_client_connections
			ORDER BY (last_used_at IS NULL), last_used_at DESC, created_at DESC
		`).all() as DBDbClientConnectionRow[];
		return rows.map(rowToConnection);
	},

	get(id: string): DbClientConnection | null {
		const row = getRowById(id);
		return row ? rowToConnection(row) : null;
	},

	create(input: DbClientConnectionInput): DbClientConnection {
		return insertConnection(input, null);
	},

	createForUser(input: DbClientConnectionInput, ownerUserId: string): DbClientConnection {
		const connection = insertConnection(input, ownerUserId);
		return redactConnectionSecrets(connection);
	},

	update(id: string, patch: Partial<DbClientConnectionInput>): DbClientConnection {
		const db = getDatabase();
		const existing = getRowById(id);
		if (!existing) {
			throw new Error('db-client connection not found');
		}

		const sets: string[] = [];
		const values: unknown[] = [];
		const push = (col: string, val: unknown): void => {
			sets.push(`${col} = ?`);
			values.push(val);
		};

		if (patch.name !== undefined) push('name', patch.name);
		if (patch.driver !== undefined) push('driver', patch.driver);
		if (patch.host !== undefined) push('host', patch.host || null);
		if (patch.port !== undefined) push('port', patch.port ?? null);
		if (patch.username !== undefined) push('username', patch.username || null);
		if (patch.password !== undefined && patch.password !== '') push('password', patch.password);
		if (patch.database !== undefined) push('database', patch.database || null);
		if (patch.sslMode !== undefined) push('ssl_mode', patch.sslMode);
		if (patch.sslCa !== undefined) push('ssl_ca', patch.sslCa || null);
		if (patch.color !== undefined) push('color', patch.color || null);
		if (patch.options !== undefined) push('options_json', JSON.stringify(patch.options ?? {}));

		if (patch.ssh !== undefined) {
			const merged: DbClientSshConfig = {
				enabled: existing.ssh_enabled === 1,
				host: existing.ssh_host ?? '',
				port: existing.ssh_port ?? 22,
				username: existing.ssh_username ?? '',
				authMethod: (existing.ssh_auth_method ?? 'password') as DbSshAuthMethod,
				password: existing.ssh_password ?? '',
				privateKey: existing.ssh_private_key ?? '',
				passphrase: existing.ssh_passphrase ?? '',
				...patch.ssh
			};
			const sshPassword = preserveExistingSecret(patch.ssh.password, existing.ssh_password);
			const sshPrivateKey = preserveExistingSecret(patch.ssh.privateKey, existing.ssh_private_key);
			const sshPassphrase = preserveExistingSecret(patch.ssh.passphrase, existing.ssh_passphrase);

			push('ssh_enabled', merged.enabled ? 1 : 0);
			push('ssh_host', merged.host || null);
			push('ssh_port', merged.port);
			push('ssh_username', merged.username || null);
			push('ssh_auth_method', merged.authMethod);
			push('ssh_password', sshPassword);
			push('ssh_private_key', sshPrivateKey);
			push('ssh_passphrase', sshPassphrase);
		}

		push('updated_at', new Date().toISOString());

		if (sets.length === 0) {
			return rowToConnection(existing);
		}

		values.push(id);
		db.prepare(`UPDATE db_client_connections SET ${sets.join(', ')} WHERE id = ?`).run(...values);

		const row = getRowById(id);
		if (!row) {
			throw new Error('db-client connection not found');
		}
		return rowToConnection(row);
	},

	updateForUser(
		id: string,
		patch: Partial<DbClientConnectionInput>,
		userId: string,
		isAdmin: boolean
	): DbClientConnection {
		this.ensureAccess(id, userId, isAdmin);
		const updated = this.update(id, patch);
		return redactConnectionSecrets(updated);
	},

	delete(id: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM db_client_connections WHERE id = ?').run(id);
	},

	deleteForUser(id: string, userId: string, isAdmin: boolean): void {
		this.ensureAccess(id, userId, isAdmin);
		this.delete(id);
	},

	markUsed(id: string): void {
		const db = getDatabase();
		const now = new Date().toISOString();
		db.prepare('UPDATE db_client_connections SET last_used_at = ? WHERE id = ?').run(now, id);
	}
};
