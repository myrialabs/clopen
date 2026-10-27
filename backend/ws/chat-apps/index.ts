/**
 * Chat Apps Router
 *
 * Pairing chats with the connected bots: which bots there are and how they
 * are doing, a pairing link, approving members' chats, switching a chat on
 * or off, a test message, unlinking, and the command
 * reference. Open to every signed-in user and scoped to the caller: a member
 * manages their own chats, an admin every chat (and approves new ones).
 * Connecting or removing the BOT itself is an integration (admin-only). What
 * a paired chat can DO is the control catalog, held to the user's role.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import { getUserById, type AuthUser } from '$backend/auth/auth-service';
import {
	cancelPairingLink,
	createPairingLink,
	decideChannelLink,
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
	userId: t.String(),
	userName: t.String(),
	displayName: t.Union([t.String(), t.Null()]),
	status: t.Union([t.Literal('pending'), t.Literal('approved')]),
	isEnabled: t.Boolean(),
	isMine: t.Boolean(),
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

function viewer(conn: Parameters<typeof ws.getUserId>[0]): AuthUser {
	const user = getUserById(ws.getUserId(conn));
	if (!user) throw new Error('Not signed in');
	return user;
}

// A chat pairs, is approved or changes itself from the phone, and a bot comes
// up or goes down, with no request from any tab. Every open Settings page
// re-reads what it may see; the list is scoped server-side.
onLinksChanged(() => ws.emit.global('chat-apps:changed', {}));
onBotsChanged(() => ws.emit.global('chat-apps:changed', {}));

export const chatAppsRouter = createRouter()
	.http('chat-apps:bots', {
		data: t.Object({
			/** The tab's own origin: a non-local one is a better webhook address than a tunnel. */
			requestOrigin: t.Optional(t.String())
		}),
		response: t.Array(BOT_SCHEMA)
	}, async ({ data, conn }) => {
		return listChannelBots(viewer(conn), data.requestOrigin);
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
	}, async ({ data, conn }) => {
		await setChannelLinkEnabled(viewer(conn), data.linkId, data.enabled);
		return { ok: true };
	})

	.http('chat-apps:decide', {
		data: t.Object({ linkId: t.String(), decision: t.Union([t.Literal('approve'), t.Literal('reject')]) }),
		response: OK
	}, async ({ data, conn }) => {
		await decideChannelLink(viewer(conn), data.linkId, data.decision);
		return { ok: true };
	})

	.http('chat-apps:unlink', {
		data: t.Object({ linkId: t.String() }),
		response: OK
	}, async ({ data, conn }) => {
		await removeChannelLink(viewer(conn), data.linkId);
		return { ok: true };
	})

	.http('chat-apps:test', {
		data: t.Object({ linkId: t.String() }),
		response: OK
	}, async ({ data, conn }) => {
		await sendChannelTest(viewer(conn), data.linkId);
		return { ok: true };
	})

	.http('chat-apps:commands', {
		data: t.Object({}),
		response: t.Array(t.Object({
			command: t.String(),
			hint: t.Union([t.String(), t.Null()]),
			description: t.String(),
			group: t.String(),
			adminOnly: t.Boolean()
		}))
	}, async ({ conn }) => {
		return listChatAppCommands(viewer(conn));
	})

	.emit('chat-apps:changed', t.Object({}));
