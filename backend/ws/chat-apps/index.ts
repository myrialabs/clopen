/**
 * Chat Apps Router
 *
 * Pairing chats with the connected bots: which bots there are and how they
 * are doing, a pairing link, switching a chat on or off, a test message,
 * unlinking, and the command reference. Connecting or removing the BOT itself
 * is an integration. What a paired chat can DO is the control catalog.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import {
	cancelPairingLink,
	createPairingLink,
	listChannelBots,
	listChatAppCommands,
	onBotsChanged,
	onLinksChanged,
	removeChannelLink,
	sendChannelTest,
	setChannelLinkEnabled
} from '$backend/chat-apps';

const LINK_SCHEMA = t.Object({
	id: t.String(),
	displayName: t.Union([t.String(), t.Null()]),
	isEnabled: t.Boolean(),
	createdAt: t.String(),
	lastUsedAt: t.Union([t.String(), t.Null()])
});

const BOT_SCHEMA = t.Object({
	accountId: t.String(),
	provider: t.String(),
	label: t.String(),
	botName: t.Union([t.String(), t.Null()]),
	projectId: t.Union([t.String(), t.Null()]),
	running: t.Boolean(),
	mode: t.Union([t.Literal('webhook'), t.Literal('polling'), t.Null()]),
	originSource: t.Union([t.Literal('configured'), t.Literal('domain'), t.Literal('tunnel'), t.Null()]),
	connection: t.Union([t.Literal('connecting'), t.Literal('open'), t.Literal('closed'), t.Null()]),
	error: t.Union([t.String(), t.Null()]),
	control: t.Boolean(),
	links: t.Array(LINK_SCHEMA)
});

const OK = t.Object({ ok: t.Boolean() });

// A chat pairs or changes itself from the phone, and a bot comes up or goes
// down, with no request from any tab. Every open Settings page re-reads.
onLinksChanged(() => ws.emit.global('chat-apps:changed', {}));
onBotsChanged(() => ws.emit.global('chat-apps:changed', {}));

export const chatAppsRouter = createRouter()
	.http('chat-apps:bots', {
		data: t.Object({
			/** The tab's own origin: a non-local one is a better webhook address than a tunnel. */
			requestOrigin: t.Optional(t.String())
		}),
		response: t.Array(BOT_SCHEMA)
	}, async ({ data }) => {
		return listChannelBots(data.requestOrigin);
	})

	.http('chat-apps:pair', {
		data: t.Object({ accountId: t.String() }),
		response: t.Object({ url: t.String(), expiresAt: t.String(), ttlSeconds: t.Number() })
	}, async ({ data, conn }) => {
		return createPairingLink(ws.getUserId(conn), data.accountId);
	})

	.http('chat-apps:pair-cancel', {
		data: t.Object({ accountId: t.String() }),
		response: OK
	}, async ({ data, conn }) => {
		cancelPairingLink(ws.getUserId(conn), data.accountId);
		return { ok: true };
	})

	.http('chat-apps:set-enabled', {
		data: t.Object({ linkId: t.String(), enabled: t.Boolean() }),
		response: OK
	}, async ({ data }) => {
		await setChannelLinkEnabled(data.linkId, data.enabled);
		return { ok: true };
	})

	.http('chat-apps:unlink', {
		data: t.Object({ linkId: t.String() }),
		response: OK
	}, async ({ data }) => {
		await removeChannelLink(data.linkId);
		return { ok: true };
	})

	.http('chat-apps:test', {
		data: t.Object({ linkId: t.String() }),
		response: OK
	}, async ({ data }) => {
		await sendChannelTest(data.linkId);
		return { ok: true };
	})

	.http('chat-apps:commands', {
		data: t.Object({}),
		response: t.Array(t.Object({
			command: t.String(),
			hint: t.Union([t.String(), t.Null()]),
			description: t.String(),
			group: t.String()
		}))
	}, async () => {
		return listChatAppCommands();
	})

	.emit('chat-apps:changed', t.Object({}));
