/**
 * File share-link WebSocket handlers (File Explorer → "Share Link…").
 *
 * - files:create-share — authenticated user mints a link for one file, with
 *   its one-time / deadline options. The raw token is embedded in the share
 *   URL; only its hash is stored, and the row id comes back alongside it so
 *   the link stays manageable afterwards.
 * - files:list-shares — live links. Carries no token material, so it can
 *   never rebuild a URL.
 * - files:revoke-share — invalidates a link by row id.
 * - files:shares-changed — broadcast whenever that list moves, so every open
 *   management view reflects a mint, a revoke or an open without polling.
 *
 * Reachability (how another device can open the link) is NOT handled here —
 * the frontend builds the URL against the Remote Access public origin
 * (`share:ensure-origin`), reusing that system instead of a new one.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import {
	createFileShareLink,
	listFileShares,
	revokeFileShareLink,
	MAX_FILE_SHARE_TTL_MINUTES
} from '../../files/file-shares';

const shareSummary = t.Object({
	id: t.String(),
	filePath: t.String(),
	fileName: t.String(),
	projectName: t.Union([t.String(), t.Null()]),
	worktreeName: t.Union([t.String(), t.Null()]),
	relativePath: t.String(),
	createdAt: t.String(),
	oneTime: t.Boolean(),
	expiresAt: t.Union([t.String(), t.Null()]),
	openCount: t.Number(),
	lastOpenedAt: t.Union([t.String(), t.Null()]),
	consumedAt: t.Union([t.String(), t.Null()])
});

export const fileShareHandler = createRouter()
	.http('files:create-share', {
		data: t.Object({
			file_path: t.String({ minLength: 1 }),
			/** Burn on the first open. Defaults to true. */
			oneTime: t.Optional(t.Boolean()),
			/** Minutes until it lapses, or null for "until revoked". */
			expiresInMinutes: t.Optional(
				t.Union([t.Number({ minimum: 1, maximum: MAX_FILE_SHARE_TTL_MINUTES }), t.Null()])
			)
		}),
		response: t.Object({
			shareId: t.String(),
			shareToken: t.String(),
			oneTime: t.Boolean(),
			expiresAt: t.Union([t.String(), t.Null()])
		})
	}, async ({ data, conn }) => {
		const result = await createFileShareLink(data.file_path, ws.getUserId(conn), {
			oneTime: data.oneTime,
			expiresInMinutes: data.expiresInMinutes
		});
		ws.emit.global('files:shares-changed', { kind: 'created' });
		return result;
	})

	.http('files:list-shares', {
		data: t.Object({}),
		response: t.Object({ shares: t.Array(shareSummary) })
	}, async () => {
		return { shares: listFileShares() };
	})

	.http('files:revoke-share', {
		data: t.Object({
			shareId: t.String({ minLength: 1 })
		}),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		const success = revokeFileShareLink(data.shareId);
		if (success) ws.emit.global('files:shares-changed', { kind: 'revoked' });
		return { success };
	})

	// Broadcast-only: every listener re-reads the list.
	.emit('files:shares-changed', t.Object({
		kind: t.String()
	}));
