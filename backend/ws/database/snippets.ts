/**
 * Database Manager - SQL Snippets Cloud Handler
 */

import { t } from 'elysia';
import { nanoid } from 'nanoid';
import { createRouter } from '$shared/utils/ws-server';
import { sqlSnippetQueries, authQueries } from '../../database/queries';
import { resolveIdentity } from '../../db-manager/rbac';

// ─── Elysia schemas ───────────────────────────────────────────────────────────

const SnippetSchema = t.Object({
	id: t.String(),
	title: t.String(),
	description: t.String(),
	sql: t.String(),
	tags: t.Array(t.String()),
	isPublic: t.Boolean(),
	shareToken: t.Union([t.String(), t.Null()]),
	createdBy: t.String(),
	createdByName: t.String(),
	createdAt: t.String(),
	updatedAt: t.String()
});

// ─── Handler ──────────────────────────────────────────────────────────────────

export const snippetsHandler = createRouter()
	// List snippets visible to the current user (own + public)
	.http(
		'db:snippets:list',
		{
			data: t.Object({}),
			response: t.Array(SnippetSchema)
		},
		async ({ conn }) => {
			const { userId } = resolveIdentity(conn);
			return sqlSnippetQueries.listForUser(userId);
		}
	)

	// Create a new snippet
	.http(
		'db:snippets:create',
		{
			data: t.Object({
				title: t.String(),
				description: t.String(),
				sql: t.String(),
				tags: t.Array(t.String()),
				isPublic: t.Boolean()
			}),
			response: SnippetSchema
		},
		async ({ data, conn }) => {
			const { userId } = resolveIdentity(conn);
			const user = authQueries.getUserById(userId);
			const userName = user?.name ?? 'Unknown';
			const id = nanoid();
			return sqlSnippetQueries.create(id, userId, userName, {
				title: data.title,
				description: data.description,
				sql: data.sql,
				tags: data.tags,
				isPublic: data.isPublic
			});
		}
	)

	// Update an existing snippet (owner only)
	.http(
		'db:snippets:update',
		{
			data: t.Object({
				id: t.String(),
				title: t.String(),
				description: t.String(),
				sql: t.String(),
				tags: t.Array(t.String()),
				isPublic: t.Boolean()
			}),
			response: t.Union([SnippetSchema, t.Null()])
		},
		async ({ data, conn }) => {
			const { userId } = resolveIdentity(conn);
			return sqlSnippetQueries.update(userId, {
				id: data.id,
				title: data.title,
				description: data.description,
				sql: data.sql,
				tags: data.tags,
				isPublic: data.isPublic
			});
		}
	)

	// Delete a snippet (owner only)
	.http(
		'db:snippets:delete',
		{
			data: t.Object({ id: t.String() }),
			response: t.Object({ ok: t.Boolean() })
		},
		async ({ data, conn }) => {
			const { userId } = resolveIdentity(conn);
			const ok = sqlSnippetQueries.delete(data.id, userId);
			return { ok };
		}
	)

	// Generate / revoke share token (owner only)
	.http(
		'db:snippets:share',
		{
			data: t.Object({ id: t.String(), generate: t.Boolean() }),
			response: t.Union([SnippetSchema, t.Null()])
		},
		async ({ data, conn }) => {
			const { userId } = resolveIdentity(conn);
			const token = data.generate ? nanoid(24) : null;
			return sqlSnippetQueries.setShareToken(data.id, userId, token);
		}
	)

	// Get snippet by share token (public, no auth required for the lookup)
	.http(
		'db:snippets:get-by-token',
		{
			data: t.Object({ token: t.String() }),
			response: t.Union([SnippetSchema, t.Null()])
		},
		async ({ data }) => {
			return sqlSnippetQueries.getByShareToken(data.token);
		}
	);
