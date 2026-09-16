/**
 * File share-link WebSocket handlers (File Explorer → "Share via Link / QR Code").
 *
 * - files:create-share — authenticated user mints a single-file token. The raw
 *   token is embedded in the share URL; only its hash is stored.
 * - files:revoke-share — creator (or admin) invalidates a token.
 *
 * Reachability (how another device can open the link) is NOT handled here —
 * the frontend builds the URL against the Remote Access public origin
 * (`share:ensure-origin`), reusing that system instead of a new one.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import { createFileShareLink, revokeFileShareLink } from '../../files/file-shares';

export const fileShareHandler = createRouter()
	.http('files:create-share', {
		data: t.Object({
			file_path: t.String({ minLength: 1 })
		}),
		response: t.Object({
			shareToken: t.String(),
			expiresAt: t.String()
		})
	}, async ({ data, conn }) => {
		return createFileShareLink(data.file_path, ws.getRole(conn), ws.getUserId(conn));
	})

	.http('files:revoke-share', {
		data: t.Object({
			shareToken: t.String({ minLength: 1 })
		}),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data, conn }) => {
		const success = revokeFileShareLink(data.shareToken, ws.getRole(conn), ws.getUserId(conn));
		return { success };
	});
