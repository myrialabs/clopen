/**
 * Inbound — every message a paired chat sends, and the checks in front of it.
 *
 * Nothing in a message is trusted on its own. A button names a row, and that
 * row must belong to the link of the chat that pressed it; the link's account
 * must still exist and the row's project must still be in Clopen; the person
 * pressing must be the platform user who paired the chat; and anything that
 * drives Clopen needs the bot's `control` capability. Only then does anything
 * happen.
 *
 *   /start <code>, /unlink         pairing (here)
 *   any other /command             the chat's own commands or the control catalog (`conversation.ts`)
 *   a button                        a question, a menu, or a confirmation
 *   an edit                         Edit Message on what the user sent
 *   a reply                         answer that question / continue from that point
 *   text, photos, files, an album   a question of the active session that waits, else the active session
 *
 * ONE AT A TIME PER CHAT. Messages of one chat are handled in the order they
 * arrived, each after the previous finished: two sent a second apart into a
 * chat with no session must make one session, not two. Different chats never
 * wait for each other.
 *
 * An ALBUM arrives as one message per photo. They are collected for a moment
 * and handled as one message, so five photos are one turn, not five.
 */

import type { UniversalMessage } from '@myrialabs/chatkit';
import {
	channelMessageQueries,
	channelLinkQueries,
	projectQueries,
	type ChannelMessageRow,
	type ChannelLinkRow
} from '$backend/database/queries';
import { getUserById } from '$backend/auth/auth-service';
import { debug } from '$shared/utils/logger';
import { channelRuntime, type ActiveChannel } from './runtime';
import { redeemPairingCode } from './pairing';
import { notifyLinksChanged } from './link-events';
import { REPLIES, decodeButtonData } from './messages';
import { answerQuestionWithText, handleQuestionButton, replyText } from './questions';
import { collectAttachments, isMedia, textOf, type PromptAttachment } from './media';
import { clearAwaiting, hasAwaiting, takeAwaiting } from './awaiting';
import {
	activeTarget,
	answerAsk,
	isAsking,
	isKnownCommand,
	continueActive,
	continueFrom,
	editSent,
	handleControlButton,
	handleControlCommand,
	type Conversation
} from './conversation';

export { registerComposer } from './conversation';
export { onLinksChanged } from './link-events';
export type { Composer } from './conversation';

/** How long the rest of an album may take to arrive after its first photo. */
const ALBUM_WINDOW_MS = 1200;

// ── Ordering ────────────────────────────────────────────────────────────────

const chains = new Map<string, Promise<void>>();

function chatKey(message: UniversalMessage): string {
	return `${message.address.account}\u0000${message.address.conversation_id}`;
}

/** Run `task` after everything this chat sent before it. */
function inOrder(key: string, task: () => Promise<void>): Promise<void> {
	const next = (chains.get(key) ?? Promise.resolve()).then(task).catch((error) => {
		debug.error('chat-apps', 'Handling a channel message failed:', error);
	});
	chains.set(key, next);
	void next.finally(() => {
		if (chains.get(key) === next) chains.delete(key);
	});
	return next;
}

interface PendingAlbum {
	messages: UniversalMessage[];
	channel: ActiveChannel;
	timer: ReturnType<typeof setTimeout> | null;
}

const albums = new Map<string, PendingAlbum>();

export function handleInboundMessage(message: UniversalMessage, channel: ActiveChannel): Promise<void> {
	if (message.from?.is_self) return Promise.resolve();
	const key = chatKey(message);
	const album = isMedia(message.content) && !message.edited ? channel.platform.albumOf(message) : null;
	if (!album) return inOrder(key, () => handleMessages([message], channel));

	// The photos of an album trickle in; hold them until the album is complete.
	const albumKey = `${key}\u0000${album}`;
	const pending = albums.get(albumKey);
	if (pending) pending.messages.push(message);
	const entry: PendingAlbum = pending ?? { messages: [message], channel, timer: null };
	if (entry.timer) clearTimeout(entry.timer);
	entry.timer = setTimeout(() => {
		albums.delete(albumKey);
		void inOrder(key, () => handleMessages(entry.messages, entry.channel));
	}, ALBUM_WINDOW_MS);
	entry.timer.unref?.();
	albums.set(albumKey, entry);
	return Promise.resolve();
}

// ── One message (or one album) ──────────────────────────────────────────────

/** Content a chat can drive Clopen with. Reactions and platform extras are not. */
function isActionable(message: UniversalMessage): boolean {
	const type = message.content.type;
	return type === 'text' || type === 'postback' || type === 'media' || type === 'location' || type === 'contact';
}

/** Files ChatKit downloaded that will not be used must still leave its store. */
async function discardMedia(messages: UniversalMessage[]): Promise<void> {
	for (const message of messages) {
		if (isMedia(message.content)) await channelRuntime.takeMedia(message.content.url).catch(() => null);
	}
}

async function handleMessages(messages: UniversalMessage[], channel: ActiveChannel): Promise<void> {
	const message = messages[0];
	if (!isActionable(message)) return;
	const content = message.content;
	let command = content.type === 'text' && !message.edited ? channel.platform.parseCommand(content.text) : null;

	if (!channel.platform.isDirect(message)) {
		await discardMedia(messages);
		if (command?.command === 'start') await replyText(channel, message, REPLIES.groupRefused);
		return;
	}

	const link = channelLinkQueries.getByConversation(channel.accountId, message.address.conversation_id);

	if (command?.command === 'start') {
		await pair(channel, message, link, command.argument);
		return;
	}
	if (!link) {
		await discardMedia(messages);
		await replyText(channel, message, REPLIES.notLinked);
		return;
	}
	// In a private chat the sender is the chat, but the check is cheap and the
	// day a platform's notion of "direct" turns out looser is not the day to find out.
	if (message.from?.user_id !== link.platform_user_id) {
		await discardMedia(messages);
		return;
	}
	const user = getUserById(link.user_id);
	if (!user) {
		await discardMedia(messages);
		return;
	}
	// While the bot waits for typed words, "/etc is fine" is those words, not a
	// typo'd command. Only a command Clopen knows ends the wait.
	if (command && command.command !== 'start' && !isKnownCommand(command.command) && hasAwaiting(link.id)) command = null;

	// Switched off: nothing but leaving (or asking why) works.
	if (!channelLinkQueries.isActive(link) && command?.command !== 'unlink') {
		await discardMedia(messages);
		if (content.type !== 'postback') await replyText(channel, message, REPLIES.chatOff);
		return;
	}
	channelLinkQueries.touch(link.id);
	const conversation: Conversation = { channel, message, link, user };

	try {
		if (command) {
			// A command is not the answer to whatever was being typed.
			clearAwaiting(link.id);
			await handleCommand(conversation, command.command, command.argument, content.type === 'text' ? content.text : '');
		} else if (content.type === 'postback') {
			await handleButton(conversation, content.data);
		} else {
			const { attachments, problems } = await collectAttachments(channel, messages);
			if (problems.length) await replyText(channel, message, REPLIES.attachmentsDropped(problems));
			// An album's caption sits on whichever photo the user wrote it under.
			const text = messages.map((entry) => textOf(entry.content)).filter((entry) => entry.trim()).join('\n\n');
			if (!text.trim() && attachments.length === 0) return;
			if (message.edited) await editSent(conversation, text, attachments);
			else await handleText(conversation, text, attachments);
		}
	} catch (error) {
		debug.error('chat-apps', 'Handling a channel message failed:', error);
		await replyText(channel, message, error instanceof Error ? `⚠️ ${error.message}` : REPLIES.answerFailed);
	}
}

async function pair(channel: ActiveChannel, message: UniversalMessage, link: ChannelLinkRow | null, code: string): Promise<void> {
	if (!code) {
		const reply = !link
			? REPLIES.notLinked
			: link.is_enabled !== 1
				? REPLIES.chatOff
				: REPLIES.helpIntro;
		await replyText(channel, message, reply);
		return;
	}
	const redeemed = redeemPairingCode(code, channel.accountId);
	const user = redeemed ? getUserById(redeemed.userId) : null;
	if (!redeemed || !user || !message.from) {
		await replyText(channel, message, REPLIES.pairingExpired);
		return;
	}
	const paired = channelLinkQueries.upsert({
		accountId: channel.accountId,
		userId: user.id,
		conversationId: message.address.conversation_id,
		platformUserId: message.from.user_id,
		displayName: message.from.display_name ?? null
	});
	debug.log('chat-apps', `Paired a ${channel.platform.provider} chat (${paired.id})`);
	notifyLinksChanged();
	await replyText(channel, message, REPLIES.paired(user.name));
}

async function handleCommand(conversation: Conversation, command: string, argument: string, rawText: string): Promise<void> {
	const { channel, message, link } = conversation;
	if (command === 'unlink') {
		channelLinkQueries.remove(link.id);
		await replyText(channel, message, REPLIES.unlinked);
		notifyLinksChanged();
		return;
	}
	await handleControlCommand(conversation, command, argument, rawText);
}

/** The row, if it is this chat's and its project is still in Clopen. */
async function ownedRow(conversation: Conversation, row: ChannelMessageRow | null): Promise<ChannelMessageRow | null> {
	const { channel, message, link } = conversation;
	if (!row || row.link_id !== link.id) {
		await replyText(channel, message, REPLIES.staleAction);
		return null;
	}
	if (row.project_id && !projectQueries.isListed(row.project_id)) {
		await replyText(channel, message, REPLIES.noAccess);
		return null;
	}
	return row;
}

async function handleButton(conversation: Conversation, data: string): Promise<void> {
	const decoded = decodeButtonData(data);
	if (!decoded) return;
	const row = await ownedRow(conversation, channelMessageQueries.getById(decoded.rowId));
	if (!row) return;
	if (row.kind === 'question') await handleQuestionButton(conversation.channel, conversation.message, conversation.link, row, decoded.action);
	else await handleControlButton(conversation, row, decoded.action);
}

async function answerWithText(conversation: Conversation, row: ChannelMessageRow, text: string, attachments: PromptAttachment[]): Promise<void> {
	const { channel, message, link } = conversation;
	if (attachments.length) await replyText(channel, message, REPLIES.answerTakesText);
	if (!text.trim()) return;
	await answerQuestionWithText(channel, message, link, row, text);
}

async function handleText(conversation: Conversation, text: string, attachments: PromptAttachment[]): Promise<void> {
	const { channel, message, link } = conversation;

	if (message.reply_to) {
		const target = channelMessageQueries.getByMessage(link.id, message.reply_to);
		if (target) {
			const row = await ownedRow(conversation, target);
			if (!row) return;
			if (row.kind === 'question') {
				await answerWithText(conversation, row, text, attachments);
				return;
			}
			if (row.chat_session_id && (row.kind === 'answer' || row.kind === 'user')) {
				await continueFrom(conversation, row, text, attachments);
				return;
			}
			if (row.kind === 'menu' && isAsking(row)) {
				clearAwaiting(link.id);
				await answerAsk(conversation, row, text);
				return;
			}
		}
		// A reply to something with no place in a conversation (a hint, a menu)
		// is just a message.
	}

	// The bot just asked for words ("Other…", a folder name): this is them.
	const awaited = takeAwaiting(link.id);
	const awaitedRow = awaited ? channelMessageQueries.getById(awaited.rowId) : null;
	if (awaitedRow && awaitedRow.link_id === link.id && awaitedRow.state === 'open') {
		if (awaited!.kind === 'question') {
			const row = await ownedRow(conversation, awaitedRow);
			if (row) await answerWithText(conversation, row, text, attachments);
			return;
		}
		if (isAsking(awaitedRow)) {
			await answerAsk(conversation, awaitedRow, text);
			return;
		}
	}

	// A question the session you are in is waiting on is what a plain message
	// most likely answers. One waiting in ANOTHER session is not: switching to
	// a session and typing must reach that session, so those are answered by
	// replying to them.
	const { session } = activeTarget(link);
	const open = session ? channelMessageQueries.openQuestionsForLink(link.id).filter((row) => row.chat_session_id === session.id) : [];
	if (open.length === 1) {
		const row = await ownedRow(conversation, open[0]);
		if (row) await answerWithText(conversation, row, text, attachments);
		return;
	}
	if (open.length > 1) {
		await replyText(channel, message, REPLIES.pickReply);
		return;
	}

	await continueActive(conversation, text, attachments);
}
