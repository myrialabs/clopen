import { getDatabase } from '../index';
import type {
	SqlApiEndpoint,
	SqlApiEndpointCreateInput,
	SqlApiEndpointUpdateInput,
	SqlApiKey,
	SqlApiParam,
	SqlApiRequestLog
} from '$shared/types/sql-rest-api';

// ─── Row mappers ──────────────────────────────────────────────────────────────

interface RawEndpointRow {
	id: string;
	connection_id: string;
	name: string;
	description: string;
	slug: string;
	sql_template: string;
	params: string;
	is_public: number;
	enabled: number;
	rate_limit_requests: number;
	rate_limit_window_secs: number;
	cache_ttl_secs: number;
	created_by: string;
	created_by_name: string;
	created_at: string;
	updated_at: string;
}

interface RawKeyRow {
	id: string;
	endpoint_id: string;
	name: string;
	key_hash: string;
	key_prefix: string;
	enabled: number;
	last_used_at: string | null;
	expires_at: string | null;
	created_by: string;
	created_at: string;
}

interface RawLogRow {
	id: string;
	endpoint_id: string;
	endpoint_slug: string;
	api_key_id: string | null;
	ip_address: string | null;
	params: string;
	status_code: number;
	row_count: number | null;
	execution_time_ms: number | null;
	error: string | null;
	requested_at: string;
}

function toEndpoint(row: RawEndpointRow): SqlApiEndpoint {
	return {
		id: row.id,
		connectionId: row.connection_id,
		name: row.name,
		description: row.description,
		slug: row.slug,
		sqlTemplate: row.sql_template,
		params: JSON.parse(row.params) as SqlApiParam[],
		isPublic: row.is_public === 1,
		enabled: row.enabled === 1,
		rateLimitRequests: row.rate_limit_requests,
		rateLimitWindowSecs: row.rate_limit_window_secs,
		cacheTtlSecs: row.cache_ttl_secs,
		createdBy: row.created_by,
		createdByName: row.created_by_name,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function toKey(row: RawKeyRow): SqlApiKey {
	return {
		id: row.id,
		endpointId: row.endpoint_id,
		name: row.name,
		keyPrefix: row.key_prefix,
		enabled: row.enabled === 1,
		lastUsedAt: row.last_used_at,
		expiresAt: row.expires_at,
		createdBy: row.created_by,
		createdAt: row.created_at
	};
}

function toLog(row: RawLogRow): SqlApiRequestLog {
	return {
		id: row.id,
		endpointId: row.endpoint_id,
		endpointSlug: row.endpoint_slug,
		apiKeyId: row.api_key_id,
		ipAddress: row.ip_address,
		params: JSON.parse(row.params) as Record<string, string>,
		statusCode: row.status_code,
		rowCount: row.row_count,
		executionTimeMs: row.execution_time_ms,
		error: row.error,
		requestedAt: row.requested_at
	};
}

// ─── Endpoint queries ─────────────────────────────────────────────────────────

export const sqlRestApiQueries = {
	// ── Endpoints ──────────────────────────────────────────────────────────────

	createEndpoint(id: string, userId: string, userName: string, input: SqlApiEndpointCreateInput): SqlApiEndpoint {
		const db = getDatabase();
		const now = new Date().toISOString();
		db.prepare(`
			INSERT INTO sql_api_endpoints
			(id, connection_id, name, description, slug, sql_template, params, is_public, enabled,
			 rate_limit_requests, rate_limit_window_secs, cache_ttl_secs, created_by, created_by_name, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			id,
			input.connectionId,
			input.name,
			input.description,
			input.slug,
			input.sqlTemplate,
			JSON.stringify(input.params),
			input.isPublic ? 1 : 0,
			input.rateLimitRequests,
			input.rateLimitWindowSecs,
			input.cacheTtlSecs,
			userId,
			userName,
			now,
			now
		);
		return this.getEndpointById(id)!;
	},

	getEndpointById(id: string): SqlApiEndpoint | null {
		const db = getDatabase();
		const row = db.prepare('SELECT * FROM sql_api_endpoints WHERE id = ?').get(id) as RawEndpointRow | undefined;
		return row ? toEndpoint(row) : null;
	},

	getEndpointBySlug(slug: string): SqlApiEndpoint | null {
		const db = getDatabase();
		const row = db.prepare('SELECT * FROM sql_api_endpoints WHERE slug = ?').get(slug) as RawEndpointRow | undefined;
		return row ? toEndpoint(row) : null;
	},

	listEndpoints(): SqlApiEndpoint[] {
		const db = getDatabase();
		const rows = db.prepare('SELECT * FROM sql_api_endpoints ORDER BY created_at DESC').all() as RawEndpointRow[];
		return rows.map(toEndpoint);
	},

	listEndpointsByConnection(connectionId: string): SqlApiEndpoint[] {
		const db = getDatabase();
		const rows = db.prepare(
			'SELECT * FROM sql_api_endpoints WHERE connection_id = ? ORDER BY created_at DESC'
		).all(connectionId) as RawEndpointRow[];
		return rows.map(toEndpoint);
	},

	updateEndpoint(userId: string, input: SqlApiEndpointUpdateInput): SqlApiEndpoint | null {
		const db = getDatabase();
		const now = new Date().toISOString();
		const result = db.prepare(`
			UPDATE sql_api_endpoints
			SET connection_id = ?, name = ?, description = ?, slug = ?, sql_template = ?,
			    params = ?, is_public = ?, enabled = ?, rate_limit_requests = ?,
			    rate_limit_window_secs = ?, cache_ttl_secs = ?, updated_at = ?
			WHERE id = ? AND created_by = ?
		`).run(
			input.connectionId,
			input.name,
			input.description,
			input.slug,
			input.sqlTemplate,
			JSON.stringify(input.params),
			input.isPublic ? 1 : 0,
			input.enabled ? 1 : 0,
			input.rateLimitRequests,
			input.rateLimitWindowSecs,
			input.cacheTtlSecs,
			now,
			input.id,
			userId
		);
		if ((result as { changes: number }).changes === 0) return null;
		return this.getEndpointById(input.id);
	},

	deleteEndpoint(id: string, userId: string): boolean {
		const db = getDatabase();
		const result = db.prepare('DELETE FROM sql_api_endpoints WHERE id = ? AND created_by = ?').run(id, userId);
		return (result as { changes: number }).changes > 0;
	},

	slugExists(slug: string, excludeId?: string): boolean {
		const db = getDatabase();
		if (excludeId) {
			const row = db.prepare('SELECT id FROM sql_api_endpoints WHERE slug = ? AND id != ?').get(slug, excludeId);
			return !!row;
		}
		const row = db.prepare('SELECT id FROM sql_api_endpoints WHERE slug = ?').get(slug);
		return !!row;
	},

	// ── API Keys ───────────────────────────────────────────────────────────────

	createKey(id: string, userId: string, endpointId: string, name: string, keyHash: string, keyPrefix: string, expiresAt: string | null): SqlApiKey {
		const db = getDatabase();
		const now = new Date().toISOString();
		db.prepare(`
			INSERT INTO sql_api_keys (id, endpoint_id, name, key_hash, key_prefix, enabled, last_used_at, expires_at, created_by, created_at)
			VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)
		`).run(id, endpointId, name, keyHash, keyPrefix, expiresAt, userId, now);
		return this.getKeyById(id)!;
	},

	getKeyById(id: string): SqlApiKey | null {
		const db = getDatabase();
		const row = db.prepare('SELECT * FROM sql_api_keys WHERE id = ?').get(id) as RawKeyRow | undefined;
		return row ? toKey(row) : null;
	},

	getKeyByHash(hash: string): SqlApiKey | null {
		const db = getDatabase();
		const row = db.prepare('SELECT * FROM sql_api_keys WHERE key_hash = ?').get(hash) as RawKeyRow | undefined;
		return row ? toKey(row) : null;
	},

	listKeysByEndpoint(endpointId: string): SqlApiKey[] {
		const db = getDatabase();
		const rows = db.prepare(
			"SELECT * FROM sql_api_keys WHERE endpoint_id = ? OR endpoint_id = '*' ORDER BY created_at DESC"
		).all(endpointId) as RawKeyRow[];
		return rows.map(toKey);
	},

	listAllKeys(): SqlApiKey[] {
		const db = getDatabase();
		const rows = db.prepare('SELECT * FROM sql_api_keys ORDER BY created_at DESC').all() as RawKeyRow[];
		return rows.map(toKey);
	},

	touchKeyLastUsed(id: string): void {
		const db = getDatabase();
		db.prepare('UPDATE sql_api_keys SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
	},

	setKeyEnabled(id: string, enabled: boolean): void {
		const db = getDatabase();
		db.prepare('UPDATE sql_api_keys SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
	},

	deleteKey(id: string): boolean {
		const db = getDatabase();
		const result = db.prepare('DELETE FROM sql_api_keys WHERE id = ?').run(id);
		return (result as { changes: number }).changes > 0;
	},

	// ── Request log ───────────────────────────────────────────────────────────

	addRequestLog(entry: {
		id: string;
		endpointId: string;
		endpointSlug: string;
		apiKeyId: string | null;
		ipAddress: string | null;
		params: Record<string, string>;
		statusCode: number;
		rowCount: number | null;
		executionTimeMs: number | null;
		error: string | null;
	}): void {
		const db = getDatabase();
		db.prepare(`
			INSERT INTO sql_api_request_log
			(id, endpoint_id, endpoint_slug, api_key_id, ip_address, params, status_code, row_count, execution_time_ms, error, requested_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			entry.id,
			entry.endpointId,
			entry.endpointSlug,
			entry.apiKeyId,
			entry.ipAddress,
			JSON.stringify(entry.params),
			entry.statusCode,
			entry.rowCount,
			entry.executionTimeMs,
			entry.error,
			new Date().toISOString()
		);
	},

	listRequestLogs(endpointId: string, limit = 100): SqlApiRequestLog[] {
		const db = getDatabase();
		const rows = db.prepare(
			'SELECT * FROM sql_api_request_log WHERE endpoint_id = ? ORDER BY requested_at DESC LIMIT ?'
		).all(endpointId, limit) as RawLogRow[];
		return rows.map(toLog);
	},

	pruneRequestLogs(keepDays = 30): void {
		const db = getDatabase();
		const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
		db.prepare('DELETE FROM sql_api_request_log WHERE requested_at < ?').run(cutoff);
	}
};
