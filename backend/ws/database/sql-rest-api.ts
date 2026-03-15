/**
 * Database Manager — SQL-to-REST API Generator WS Handler
 * Manages endpoint CRUD and API key lifecycle through the app UI.
 */

import { t } from 'elysia';
import { nanoid } from 'nanoid';
import { createRouter } from '$shared/utils/ws-server';
import { sqlRestApiQueries, authQueries } from '../../database/queries';
import { resolveIdentity } from '../../db-manager/rbac';
import { generateApiKey, extractPlaceholders } from '../../db-manager/sql-rest-api';

// ─── Elysia schemas ───────────────────────────────────────────────────────────

const ParamSchema = t.Object({
	name: t.String(),
	type: t.Union([t.Literal('string'), t.Literal('number'), t.Literal('boolean')]),
	description: t.String(),
	required: t.Boolean(),
	defaultValue: t.Optional(t.String())
});

const EndpointSchema = t.Object({
	id: t.String(),
	connectionId: t.String(),
	name: t.String(),
	description: t.String(),
	slug: t.String(),
	sqlTemplate: t.String(),
	params: t.Array(ParamSchema),
	isPublic: t.Boolean(),
	enabled: t.Boolean(),
	rateLimitRequests: t.Number(),
	rateLimitWindowSecs: t.Number(),
	cacheTtlSecs: t.Number(),
	createdBy: t.String(),
	createdByName: t.String(),
	createdAt: t.String(),
	updatedAt: t.String()
});

const ApiKeySchema = t.Object({
	id: t.String(),
	endpointId: t.String(),
	name: t.String(),
	keyPrefix: t.String(),
	enabled: t.Boolean(),
	lastUsedAt: t.Union([t.String(), t.Null()]),
	expiresAt: t.Union([t.String(), t.Null()]),
	createdBy: t.String(),
	createdAt: t.String()
});

const RequestLogSchema = t.Object({
	id: t.String(),
	endpointId: t.String(),
	endpointSlug: t.String(),
	apiKeyId: t.Union([t.String(), t.Null()]),
	ipAddress: t.Union([t.String(), t.Null()]),
	params: t.Record(t.String(), t.String()),
	statusCode: t.Number(),
	rowCount: t.Union([t.Number(), t.Null()]),
	executionTimeMs: t.Union([t.Number(), t.Null()]),
	error: t.Union([t.String(), t.Null()]),
	requestedAt: t.String()
});

// ─── Handler ──────────────────────────────────────────────────────────────────

export const sqlRestApiHandler = createRouter()

	// List all endpoints (admin sees all; non-admin sees own)
	.http(
		'db:rest-api:list',
		{
			data: t.Object({ connectionId: t.Optional(t.String()) }),
			response: t.Array(EndpointSchema)
		},
		async ({ data, conn }) => {
			const { userId, appRole } = resolveIdentity(conn);
			let endpoints = data.connectionId
				? sqlRestApiQueries.listEndpointsByConnection(data.connectionId)
				: sqlRestApiQueries.listEndpoints();
			if (appRole !== 'admin') {
				endpoints = endpoints.filter((e) => e.createdBy === userId);
			}
			return endpoints;
		}
	)

	// Get a single endpoint by id
	.http(
		'db:rest-api:get',
		{
			data: t.Object({ id: t.String() }),
			response: t.Union([EndpointSchema, t.Null()])
		},
		async ({ data }) => {
			return sqlRestApiQueries.getEndpointById(data.id);
		}
	)

	// Create endpoint
	.http(
		'db:rest-api:create',
		{
			data: t.Object({
				connectionId: t.String(),
				name: t.String({ minLength: 1 }),
				description: t.String(),
				slug: t.String({ minLength: 1 }),
				sqlTemplate: t.String({ minLength: 1 }),
				params: t.Array(ParamSchema),
				isPublic: t.Boolean(),
				rateLimitRequests: t.Number(),
				rateLimitWindowSecs: t.Number(),
				cacheTtlSecs: t.Number()
			}),
			response: EndpointSchema
		},
		async ({ data, conn }) => {
			const { userId } = resolveIdentity(conn);
			const user = authQueries.getUserById(userId);
			const userName = user?.name ?? 'Unknown';

			// Validate slug uniqueness
			if (sqlRestApiQueries.slugExists(data.slug)) {
				throw new Error(`Slug "${data.slug}" is already in use`);
			}

			// Validate slug format
			if (!/^[a-z0-9-]+$/.test(data.slug)) {
				throw new Error('Slug must contain only lowercase letters, numbers, and hyphens');
			}

			const id = nanoid();
			return sqlRestApiQueries.createEndpoint(id, userId, userName, data);
		}
	)

	// Update endpoint
	.http(
		'db:rest-api:update',
		{
			data: t.Object({
				id: t.String(),
				connectionId: t.String(),
				name: t.String({ minLength: 1 }),
				description: t.String(),
				slug: t.String({ minLength: 1 }),
				sqlTemplate: t.String({ minLength: 1 }),
				params: t.Array(ParamSchema),
				isPublic: t.Boolean(),
				enabled: t.Boolean(),
				rateLimitRequests: t.Number(),
				rateLimitWindowSecs: t.Number(),
				cacheTtlSecs: t.Number()
			}),
			response: t.Union([EndpointSchema, t.Null()])
		},
		async ({ data, conn }) => {
			const { userId } = resolveIdentity(conn);

			// Check slug uniqueness (excluding self)
			if (sqlRestApiQueries.slugExists(data.slug, data.id)) {
				throw new Error(`Slug "${data.slug}" is already in use`);
			}

			if (!/^[a-z0-9-]+$/.test(data.slug)) {
				throw new Error('Slug must contain only lowercase letters, numbers, and hyphens');
			}

			return sqlRestApiQueries.updateEndpoint(userId, data);
		}
	)

	// Delete endpoint
	.http(
		'db:rest-api:delete',
		{
			data: t.Object({ id: t.String() }),
			response: t.Object({ ok: t.Boolean() })
		},
		async ({ data, conn }) => {
			const { userId } = resolveIdentity(conn);
			const ok = sqlRestApiQueries.deleteEndpoint(data.id, userId);
			return { ok };
		}
	)

	// Extract placeholders from a SQL template (for param auto-discovery)
	.http(
		'db:rest-api:extract-params',
		{
			data: t.Object({ sqlTemplate: t.String() }),
			response: t.Array(t.String())
		},
		async ({ data }) => {
			return extractPlaceholders(data.sqlTemplate);
		}
	)

	// ── API Keys ──────────────────────────────────────────────────────────────

	// List keys for an endpoint
	.http(
		'db:rest-api:keys:list',
		{
			data: t.Object({ endpointId: t.String() }),
			response: t.Array(ApiKeySchema)
		},
		async ({ data }) => {
			return sqlRestApiQueries.listKeysByEndpoint(data.endpointId);
		}
	)

	// Create a new API key — secret is returned only here
	.http(
		'db:rest-api:keys:create',
		{
			data: t.Object({
				endpointId: t.String(),
				name: t.String({ minLength: 1 }),
				expiresAt: t.Union([t.String(), t.Null()])
			}),
			response: t.Object({
				key: ApiKeySchema,
				secret: t.String()
			})
		},
		async ({ data, conn }) => {
			const { userId } = resolveIdentity(conn);
			const { key: secret, hash, prefix } = await generateApiKey();
			const id = nanoid();
			const key = sqlRestApiQueries.createKey(
				id,
				userId,
				data.endpointId,
				data.name,
				hash,
				prefix,
				data.expiresAt
			);
			return { key, secret };
		}
	)

	// Revoke (delete) a key
	.http(
		'db:rest-api:keys:delete',
		{
			data: t.Object({ id: t.String() }),
			response: t.Object({ ok: t.Boolean() })
		},
		async ({ data }) => {
			const ok = sqlRestApiQueries.deleteKey(data.id);
			return { ok };
		}
	)

	// Toggle key enabled/disabled
	.http(
		'db:rest-api:keys:toggle',
		{
			data: t.Object({ id: t.String(), enabled: t.Boolean() }),
			response: t.Object({ ok: t.Boolean() })
		},
		async ({ data }) => {
			sqlRestApiQueries.setKeyEnabled(data.id, data.enabled);
			return { ok: true };
		}
	)

	// ── Request Log ───────────────────────────────────────────────────────────

	.http(
		'db:rest-api:logs',
		{
			data: t.Object({ endpointId: t.String(), limit: t.Optional(t.Number()) }),
			response: t.Array(RequestLogSchema)
		},
		async ({ data }) => {
			return sqlRestApiQueries.listRequestLogs(data.endpointId, data.limit ?? 100);
		}
	);
