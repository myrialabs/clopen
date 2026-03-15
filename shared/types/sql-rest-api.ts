/**
 * SQL-to-REST API Generator — Shared Types
 */

export type SqlApiParamType = 'string' | 'number' | 'boolean';

export interface SqlApiParam {
	name: string;
	type: SqlApiParamType;
	description: string;
	required: boolean;
	defaultValue?: string;
}

export interface SqlApiEndpoint {
	id: string;
	connectionId: string;
	name: string;
	description: string;
	/** URL-friendly unique slug used in GET /sql-api/:slug */
	slug: string;
	/** SQL with {{param_name}} placeholders */
	sqlTemplate: string;
	params: SqlApiParam[];
	/** true = no API key required */
	isPublic: boolean;
	enabled: boolean;
	/** Max requests per window */
	rateLimitRequests: number;
	/** Window size in seconds */
	rateLimitWindowSecs: number;
	/** Response cache TTL in seconds — 0 = disabled */
	cacheTtlSecs: number;
	createdBy: string;
	createdByName: string;
	createdAt: string;
	updatedAt: string;
}

export interface SqlApiEndpointCreateInput {
	connectionId: string;
	name: string;
	description: string;
	slug: string;
	sqlTemplate: string;
	params: SqlApiParam[];
	isPublic: boolean;
	rateLimitRequests: number;
	rateLimitWindowSecs: number;
	cacheTtlSecs: number;
}

export interface SqlApiEndpointUpdateInput extends SqlApiEndpointCreateInput {
	id: string;
	enabled: boolean;
}

export interface SqlApiKey {
	id: string;
	/** Endpoint id this key grants access to, or '*' for all endpoints */
	endpointId: string;
	name: string;
	/** First 8 chars of the raw key — for display only */
	keyPrefix: string;
	enabled: boolean;
	lastUsedAt: string | null;
	/** null = never expires */
	expiresAt: string | null;
	createdBy: string;
	createdAt: string;
}

/** Returned only once, at creation time */
export interface SqlApiKeyWithSecret extends SqlApiKey {
	key: string;
}

export interface SqlApiRequestLog {
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
	requestedAt: string;
}

/** Successful runtime response from GET /sql-api/:slug */
export interface SqlApiResponse {
	data: Record<string, unknown>[];
	rowCount: number;
	executionTimeMs: number;
	cached: boolean;
}

export interface SqlApiErrorResponse {
	error: string;
	code: 'ENDPOINT_NOT_FOUND' | 'ENDPOINT_DISABLED' | 'UNAUTHORIZED' | 'RATE_LIMITED' | 'PARAM_ERROR' | 'QUERY_ERROR' | 'SELECT_ONLY';
}
