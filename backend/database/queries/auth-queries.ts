import { getDatabase } from '../index';

export interface DBUser {
	id: string;
	name: string;
	color: string;
	avatar: string;
	personal_access_token_hash: string | null;
	created_at: string;
	updated_at: string;
}

export interface DBAuthSession {
	id: string;
	user_id: string;
	token_hash: string;
	expires_at: string;
	created_at: string;
	last_active_at: string;
	user_agent: string | null;
	ip_address: string | null;
	/** How the session was created: 'setup' | 'device-link' | 'login' | 'pat' | 'no-auth'. */
	source: string | null;
}

export interface DBDeviceCode {
	id: string;
	code_hash: string;
	user_id: string;
	label: string | null;
	expires_at: string;
	claimed_at: string | null;
	created_at: string;
}

export const authQueries = {
	// ===================== Users =====================

	createUser(user: Omit<DBUser, 'updated_at'> & { updated_at?: string }): DBUser {
		const db = getDatabase();
		const now = new Date().toISOString();
		db.prepare(`
			INSERT INTO users (id, name, color, avatar, personal_access_token_hash, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(
			user.id,
			user.name,
			user.color,
			user.avatar,
			user.personal_access_token_hash,
			user.created_at,
			user.updated_at ?? now
		);
		return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as DBUser;
	},

	getUserById(id: string): DBUser | null {
		const db = getDatabase();
		return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as DBUser | null;
	},

	getUserByPatHash(hash: string): DBUser | null {
		const db = getDatabase();
		return db.prepare('SELECT * FROM users WHERE personal_access_token_hash = ?').get(hash) as DBUser | null;
	},

	/** The owner — the install's only account — or null before setup. */
	getOwner(): DBUser | null {
		const db = getDatabase();
		return db.prepare('SELECT * FROM users ORDER BY created_at ASC LIMIT 1').get() as DBUser | null;
	},

	countUsers(): number {
		const db = getDatabase();
		const result = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
		return result.count;
	},

	updateUser(id: string, fields: Partial<Pick<DBUser, 'name' | 'color' | 'avatar' | 'personal_access_token_hash'>>): void {
		const db = getDatabase();
		const now = new Date().toISOString();
		const sets: string[] = ['updated_at = ?'];
		const values: any[] = [now];

		if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
		if (fields.color !== undefined) { sets.push('color = ?'); values.push(fields.color); }
		if (fields.avatar !== undefined) { sets.push('avatar = ?'); values.push(fields.avatar); }
		if (fields.personal_access_token_hash !== undefined) { sets.push('personal_access_token_hash = ?'); values.push(fields.personal_access_token_hash); }

		values.push(id);
		db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
	},

	// ===================== Auth Sessions =====================

	createSession(session: DBAuthSession): DBAuthSession {
		const db = getDatabase();
		db.prepare(`
			INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at, last_active_at, user_agent, ip_address, source)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			session.id,
			session.user_id,
			session.token_hash,
			session.expires_at,
			session.created_at,
			session.last_active_at,
			session.user_agent,
			session.ip_address,
			session.source
		);
		return db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(session.id) as DBAuthSession;
	},

	getSessionByTokenHash(hash: string): DBAuthSession | null {
		const db = getDatabase();
		return db.prepare('SELECT * FROM auth_sessions WHERE token_hash = ?').get(hash) as DBAuthSession | null;
	},

	/** Every signed-in device. */
	getAllSessions(): DBAuthSession[] {
		const db = getDatabase();
		return db.prepare('SELECT * FROM auth_sessions ORDER BY last_active_at DESC').all() as DBAuthSession[];
	},

	getSessionById(id: string): DBAuthSession | null {
		const db = getDatabase();
		return db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(id) as DBAuthSession | null;
	},

	updateLastActive(id: string): void {
		const db = getDatabase();
		const now = new Date().toISOString();
		db.prepare('UPDATE auth_sessions SET last_active_at = ? WHERE id = ?').run(now, id);
	},

	deleteSession(id: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(id);
	},

	deleteSessionByTokenHash(hash: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hash);
	},

	deleteExpiredSessions(): number {
		const db = getDatabase();
		const now = new Date().toISOString();
		const result = db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(now) as { changes: number };
		return result.changes;
	},

	deleteAllSessions(): number {
		const db = getDatabase();
		const result = db.prepare('DELETE FROM auth_sessions').run() as { changes: number };
		return result.changes;
	},

	// ===================== Device Codes =====================

	createDeviceCode(code: DBDeviceCode): DBDeviceCode {
		const db = getDatabase();
		db.prepare(`
			INSERT INTO device_codes (id, code_hash, user_id, label, expires_at, claimed_at, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(
			code.id,
			code.code_hash,
			code.user_id,
			code.label,
			code.expires_at,
			code.claimed_at,
			code.created_at
		);
		return db.prepare('SELECT * FROM device_codes WHERE id = ?').get(code.id) as DBDeviceCode;
	},

	getDeviceCodeByHash(hash: string): DBDeviceCode | null {
		const db = getDatabase();
		return db.prepare('SELECT * FROM device_codes WHERE code_hash = ?').get(hash) as DBDeviceCode | null;
	},

	/** Mark a device code as claimed. Returns rows changed — used to guarantee single-use under races. */
	markDeviceCodeClaimed(id: string, claimedAt: string): number {
		const db = getDatabase();
		const result = db.prepare(
			'UPDATE device_codes SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL'
		).run(claimedAt, id) as { changes: number };
		return result.changes;
	},

	deleteDeviceCode(id: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM device_codes WHERE id = ?').run(id);
	},

	/** Count a user's pending (unclaimed, unexpired) device codes. */
	countPendingDeviceCodes(userId: string): number {
		const db = getDatabase();
		const now = new Date().toISOString();
		const result = db.prepare(
			'SELECT COUNT(*) as count FROM device_codes WHERE user_id = ? AND claimed_at IS NULL AND expires_at > ?'
		).get(userId, now) as { count: number };
		return result.count;
	},

	/** Remove expired or already-claimed device codes. */
	deleteStaleDeviceCodes(): number {
		const db = getDatabase();
		const now = new Date().toISOString();
		const result = db.prepare(
			'DELETE FROM device_codes WHERE expires_at < ? OR claimed_at IS NOT NULL'
		).run(now) as { changes: number };
		return result.changes;
	}
};
