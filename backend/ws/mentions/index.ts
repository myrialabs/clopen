/**
 * Mentions Router
 *
 * The chat composer's `@` picker:
 * - mentions:search  — rows for what was typed, at the root or inside a category
 * - mentions:capture — the snapshot of a picked row, as attachments
 *
 * Both are read-only. The workspace is the one the connection is viewing (a
 * worktree when one is open), and the chat is checked when one is named.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import type { ContextKind } from '$shared/types/mentions';
import { CONTEXT_NOUNS } from '$shared/utils/context-document';
import { captureMention, searchMentions, type MentionContext } from '$backend/mentions';
import type { WSConnection } from '$shared/utils/ws-server';
import { requireProjectWorkspace, requireSessionAccess } from '../access';

const candidateSchema = t.Object({
	key: t.String(),
	kind: t.String(),
	group: t.String(),
	label: t.String(),
	detail: t.String(),
	icon: t.String(),
	ref: t.Record(t.String(), t.Any()),
	browse: t.Optional(t.String())
});

const categorySchema = t.Object({
	id: t.String(),
	label: t.String(),
	detail: t.String(),
	icon: t.String(),
	group: t.String()
});

function contextFor(conn: WSConnection, projectId: string, chatSessionId?: string | null): MentionContext {
	const { project, root } = requireProjectWorkspace(conn, projectId);
	if (chatSessionId) requireSessionAccess(chatSessionId);
	return { conn, projectId: project.id, projectPath: project.path, root, chatSessionId: chatSessionId ?? null };
}

export const mentionsRouter = createRouter()
	.http('mentions:search', {
		data: t.Object({
			projectId: t.String({ minLength: 1 }),
			chatSessionId: t.Optional(t.Union([t.String(), t.Null()])),
			category: t.Optional(t.String()),
			query: t.String(),
			limit: t.Optional(t.Number())
		}),
		response: t.Object({
			items: t.Array(candidateSchema),
			categories: t.Array(categorySchema)
		})
	}, async ({ data, conn }) => {
		const ctx = contextFor(conn, data.projectId, data.chatSessionId);
		return searchMentions(ctx, { category: data.category, query: data.query, limit: data.limit });
	})

	.http('mentions:capture', {
		data: t.Object({
			projectId: t.String({ minLength: 1 }),
			chatSessionId: t.Optional(t.Union([t.String(), t.Null()])),
			kind: t.String(),
			ref: t.Record(t.String(), t.Any())
		}),
		response: t.Object({
			attachments: t.Array(t.Object({
				fileName: t.String(),
				mediaType: t.String(),
				data: t.String()
			}))
		})
	}, async ({ data, conn }) => {
		if (!(data.kind in CONTEXT_NOUNS)) throw new Error(`Unknown mention: ${data.kind}`);
		const ctx = contextFor(conn, data.projectId, data.chatSessionId);
		return { attachments: await captureMention(ctx, data.kind as ContextKind, data.ref) };
	});
