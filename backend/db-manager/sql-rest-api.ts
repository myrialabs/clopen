/**
 * SQL-to-REST API Generator — Core Engine
 *
 * Responsibilities:
 *  - Safe parameter injection into SQL templates (prevents SQL injection)
 *  - In-memory sliding-window rate limiter (per endpoint + client)
 *  - In-memory response cache (optional, per endpoint)
 *  - OpenAPI 3.0 spec generator
 *  - API key hashing / validation
 *  - Query execution via the db-manager adapter
 */

import { executeQuery } from './index';
import { decryptConnectionCredentials, decryptSSHTunnelCredentials } from './crypto';
import { settingsQueries } from '../database/queries';
import { debug } from '$shared/utils/logger';
import type { DBConnectionConfig } from '$shared/types/db-manager';
import type {
	SqlApiEndpoint,
	SqlApiParam,
	SqlApiResponse,
	SqlApiErrorResponse
} from '$shared/types/sql-rest-api';

// ─── Connection helpers ───────────────────────────────────────────────────────

const CONNECTIONS_KEY = 'db-manager:connections';

function loadConnections(): DBConnectionConfig[] {
	try {
		const setting = settingsQueries.get(CONNECTIONS_KEY);
		if (!setting) return [];
		return JSON.parse(setting.value as string) as DBConnectionConfig[];
	} catch {
		return [];
	}
}

export async function getDecryptedConnectionById(connectionId: string): Promise<DBConnectionConfig | null> {
	const connections = loadConnections();
	const conn = connections.find((c) => c.id === connectionId);
	if (!conn) return null;
	let decrypted = await decryptConnectionCredentials(conn);
	decrypted = await decryptSSHTunnelCredentials(decrypted) as DBConnectionConfig;
	return decrypted;
}

// ─── API Key hashing ──────────────────────────────────────────────────────────

/**
 * Generate a 32-byte random API key (hex-encoded = 64 chars).
 * Returns { key, hash, prefix }.
 */
export async function generateApiKey(): Promise<{ key: string; hash: string; prefix: string }> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const key = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
	const hash = await hashApiKey(key);
	const prefix = key.slice(0, 8);
	return { key, hash, prefix };
}

export async function hashApiKey(key: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(key);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── Parameter validation & safe SQL building ─────────────────────────────────

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

/** Extract all {{param_name}} placeholder names from a SQL template */
export function extractPlaceholders(sqlTemplate: string): string[] {
	const names: string[] = [];
	let match: RegExpExecArray | null;
	const re = new RegExp(PLACEHOLDER_RE.source, 'g');
	while ((match = re.exec(sqlTemplate)) !== null) {
		if (match[1] && !names.includes(match[1])) names.push(match[1]);
	}
	return names;
}

/**
 * Safely compile a SQL template by replacing {{param}} placeholders with
 * validated, escaped literal values. No string concatenation of raw input.
 *
 * Rules:
 *  - number  → validated float literal (no quotes)
 *  - boolean → 1 or 0
 *  - string  → single-quoted with '' escaping
 *
 * Returns { sql, error } where error is set if validation fails.
 */
export function buildSafeQuery(
	sqlTemplate: string,
	paramDefs: SqlApiParam[],
	queryParams: Record<string, string>
): { sql: string; error?: string } {
	let error: string | undefined;

	const sql = sqlTemplate.replace(PLACEHOLDER_RE, (_, name: string) => {
		const def = paramDefs.find((p) => p.name === name);
		if (!def) {
			error = `Unknown parameter: ${name}`;
			return 'NULL';
		}

		const rawValue = queryParams[name] ?? def.defaultValue;

		if (rawValue === undefined || rawValue === '') {
			if (def.required) {
				error = `Missing required parameter: ${name}`;
				return 'NULL';
			}
			return 'NULL';
		}

		switch (def.type) {
			case 'number': {
				const n = Number(rawValue);
				if (!isFinite(n)) {
					error = `Parameter "${name}" must be a number`;
					return 'NULL';
				}
				return String(n);
			}
			case 'boolean':
				return ['true', '1', 'yes', 'on'].includes(rawValue.toLowerCase()) ? '1' : '0';
			default: // string — escape with doubled single-quotes
				return `'${rawValue.replace(/'/g, "''")}'`;
		}
	});

	return { sql, error };
}

/**
 * Validate that the compiled SQL is a SELECT-only statement.
 * Rejects DML/DDL to protect the database.
 */
export function assertSelectOnly(sql: string): string | null {
	const firstWord = sql.trim().replace(/\/\*.*?\*\//gs, '').trim().toUpperCase().split(/\s+/)[0] ?? '';
	const allowed = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'PRAGMA', 'EXPLAIN']);
	if (!allowed.has(firstWord)) {
		return `Only SELECT queries are allowed. Got: ${firstWord}`;
	}
	return null;
}

// ─── In-memory rate limiter ───────────────────────────────────────────────────

/** Map<key, timestamps[]> — sliding window per (endpointId + clientId) */
const rateLimitBuckets = new Map<string, number[]>();

/** Returns true if the request is allowed, false if rate-limited */
export function checkRateLimit(
	endpointId: string,
	clientId: string,
	maxRequests: number,
	windowSecs: number
): boolean {
	const key = `${endpointId}:${clientId}`;
	const now = Date.now();
	const windowMs = windowSecs * 1000;

	let timestamps = rateLimitBuckets.get(key) ?? [];
	// Trim old timestamps outside the window
	timestamps = timestamps.filter((t) => now - t < windowMs);

	if (timestamps.length >= maxRequests) {
		rateLimitBuckets.set(key, timestamps);
		return false;
	}

	timestamps.push(now);
	rateLimitBuckets.set(key, timestamps);
	return true;
}

/** Returns remaining seconds in the current window when rate-limited */
export function getRateLimitReset(
	endpointId: string,
	clientId: string,
	windowSecs: number
): number {
	const key = `${endpointId}:${clientId}`;
	const now = Date.now();
	const windowMs = windowSecs * 1000;
	const timestamps = rateLimitBuckets.get(key) ?? [];
	const oldest = timestamps.filter((t) => now - t < windowMs)[0];
	if (!oldest) return windowSecs;
	return Math.ceil((oldest + windowMs - now) / 1000);
}

// ─── In-memory response cache ─────────────────────────────────────────────────

interface CacheEntry {
	result: SqlApiResponse;
	expiresAt: number;
}

const responseCache = new Map<string, CacheEntry>();

export function getCached(cacheKey: string): SqlApiResponse | null {
	const entry = responseCache.get(cacheKey);
	if (!entry) return null;
	if (Date.now() > entry.expiresAt) {
		responseCache.delete(cacheKey);
		return null;
	}
	return entry.result;
}

export function setCache(cacheKey: string, result: SqlApiResponse, ttlSecs: number): void {
	if (ttlSecs <= 0) return;
	responseCache.set(cacheKey, { result, expiresAt: Date.now() + ttlSecs * 1000 });
}

// ─── Query execution ──────────────────────────────────────────────────────────

export async function executeEndpointQuery(
	endpoint: SqlApiEndpoint,
	queryParams: Record<string, string>
): Promise<{ result?: SqlApiResponse; error?: SqlApiErrorResponse; cached?: boolean }> {
	// Build safe SQL
	const { sql, error: paramError } = buildSafeQuery(endpoint.sqlTemplate, endpoint.params, queryParams);
	if (paramError) {
		return { error: { error: paramError, code: 'PARAM_ERROR' } };
	}

	// Enforce SELECT-only
	const selectError = assertSelectOnly(sql);
	if (selectError) {
		return { error: { error: selectError, code: 'SELECT_ONLY' } };
	}

	// Check cache
	if (endpoint.cacheTtlSecs > 0) {
		const cacheKey = `${endpoint.id}:${JSON.stringify(queryParams)}`;
		const cached = getCached(cacheKey);
		if (cached) return { result: { ...cached, cached: true } };
	}

	// Get connection config
	const config = await getDecryptedConnectionById(endpoint.connectionId);
	if (!config) {
		return { error: { error: 'Database connection not found', code: 'QUERY_ERROR' } };
	}

	try {
		const dbResult = await executeQuery(config, sql);
		if (dbResult.error) {
			return { error: { error: dbResult.error, code: 'QUERY_ERROR' } };
		}

		const response: SqlApiResponse = {
			data: dbResult.rows as Record<string, unknown>[],
			rowCount: dbResult.rowCount,
			executionTimeMs: dbResult.executionTimeMs,
			cached: false
		};

		// Populate cache if configured
		if (endpoint.cacheTtlSecs > 0) {
			const cacheKey = `${endpoint.id}:${JSON.stringify(queryParams)}`;
			setCache(cacheKey, response, endpoint.cacheTtlSecs);
		}

		return { result: response };
	} catch (err) {
		debug.error('database', 'SQL REST API query execution failed:', err);
		return {
			error: {
				error: err instanceof Error ? err.message : 'Query execution failed',
				code: 'QUERY_ERROR'
			}
		};
	}
}

// ─── OpenAPI 3.0 spec generator ──────────────────────────────────────────────

const OA_TYPE_MAP: Record<string, string> = {
	string: 'string',
	number: 'number',
	boolean: 'boolean'
};

export function generateOpenApiSpec(
	endpoints: SqlApiEndpoint[],
	baseUrl: string
): Record<string, unknown> {
	const paths: Record<string, unknown> = {};

	for (const ep of endpoints) {
		if (!ep.enabled) continue;

		const parameters = ep.params.map((p) => ({
			name: p.name,
			in: 'query' as const,
			required: p.required,
			description: p.description || p.name,
			schema: {
				type: OA_TYPE_MAP[p.type] ?? 'string',
				...(p.defaultValue !== undefined ? { default: p.defaultValue } : {})
			}
		}));

		const security = ep.isPublic ? [] : [{ apiKeyAuth: [] }];

		paths[`/sql-api/${ep.slug}`] = {
			get: {
				operationId: ep.id,
				summary: ep.name,
				description: ep.description || undefined,
				tags: [ep.connectionId],
				parameters,
				security,
				responses: {
					'200': {
						description: 'Query results',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										data: { type: 'array', items: { type: 'object', additionalProperties: true } },
										rowCount: { type: 'integer' },
										executionTimeMs: { type: 'number' },
										cached: { type: 'boolean' }
									}
								}
							}
						}
					},
					'400': { description: 'Invalid or missing parameters' },
					'401': { description: 'Unauthorized — API key required' },
					'429': {
						description: 'Rate limit exceeded',
						headers: {
							'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until next allowed request' }
						}
					},
					'500': { description: 'Query execution error' }
				}
			}
		};
	}

	return {
		openapi: '3.0.3',
		info: {
			title: 'Clopen SQL REST API',
			version: '1.0.0',
			description: 'Auto-generated REST endpoints from saved SQL queries'
		},
		servers: [{ url: baseUrl, description: 'Clopen server' }],
		components: {
			securitySchemes: {
				apiKeyAuth: {
					type: 'apiKey',
					in: 'header',
					name: 'X-Api-Key',
					description: 'API key — can also be passed as ?api_key= query parameter'
				}
			}
		},
		paths
	};
}

/** Build Swagger UI HTML page embedding the spec URL */
export function generateSwaggerHtml(specUrl: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Clopen SQL REST API Docs</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '${specUrl}',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
      deepLinking: true,
      tryItOutEnabled: true
    });
  </script>
</body>
</html>`;
}
