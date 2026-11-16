/**
 * Outbound: what Clopen tells a paired chat, and keeping it true.
 *
 * A chat is told only about turns IT started; it is a conversation, not a
 * notifier. Fed by server-side stream events, so it fires whether or not
 * any browser tab is open:
 *
 *   - The turn asks something (AskUserQuestion): one message per question,
 *     its options as buttons.
 *   - A question is answered somewhere else (the web UI): the message is
 *     re-rendered as answered and loses its buttons, so the phone never
 *     offers a choice the session has already moved past.
 *   - The turn ends: the answer goes back in full, formatted and split as
 *     needed, with the images it shows sent as pictures.
 *
 * Every message that stands for a point in the conversation is recorded with
 * the Clopen message it stands for, which is what lets a reply to it continue
 * from exactly there.
 */

import type { AskUserQuestion } from '$shared/types/unified';
import {
	channelMessageQueries,
	integrationAccountQueries,
	newChannelMessageId,
	channelLinkQueries,
	projectQueries,
	sessionQueries,
	type ChannelMessageRow,
	type ChannelLinkRow
} from '$backend/database/queries';
import { isAssistantProject, ASSISTANT_NAME } from '$shared/utils/assistant-project';
import { activeChat, chatOfSession, clopenLinks, linksInChat, listChats, MAIN_CHAT } from '$backend/assistant/chats';
import { debug } from '$shared/utils/logger';
import { channelRuntime } from './runtime';
import { lastTurnAnswer, turnActionSummary } from '$backend/chat/turn-answer';
import { endLiveTurn, liveTurn, takeStoppedByChat } from './turns';
import type { InboxItem } from '$shared/types/assistant';
import { answerImages } from './media';
import { markdownToRuns, type TextRun } from '@myrialabs/chatkit';
import { resolveSessionPath } from '$backend/worktrees';
import type { ChannelButton } from './platforms/types';
import {
	encodeButtonData,
	answerRuns,
	failedRuns,
	stoppedRuns,
	questionCard,
	questionClosedCard,
	textCard,
	type ChannelContext,
	type QuestionPayload
} from './messages';

/** A message older than this is no longer a sensible thing to reply to. */
const MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function resolveContext(projectId: string, chatSessionId: string | null | undefined): ChannelContext {
	const project = projectQueries.getById(projectId);
	return {
		projectName: project ? (isAssistantProject(project) ? ASSISTANT_NAME : project.name) : undefined,
		sessionTitle: chatSessionId ? sessionQueries.getById(chatSessionId)?.title || undefined : undefined
	};
}

/** A link that opens this session, when Clopen has an address another device can reach. */
export function sessionUrl(projectId: string, chatSessionId: string): string | null {
	const origin = channelRuntime.publicOrigin();
	return origin ? `${origin}/#session/${encodeURIComponent(projectId)}/${encodeURIComponent(chatSessionId)}` : null;
}

/** Does this account have `capability` switched on? */
export function accountHas(accountId: string, capability: 'control'): boolean {
	const account = integrationAccountQueries.getById(accountId);
	return Boolean(account) && integrationAccountQueries.capabilitiesOf(account!).includes(capability);
}

export function parsePayload<T>(row: ChannelMessageRow): T {
	try {
		return JSON.parse(row.payload) as T;
	} catch {
		return {} as T;
	}
}

/**
 * Tool uses already announced (or being announced). The stream emits a
 * question's message more than once as it fills in, and two sends racing each
 * other would both find no row yet.
 */
const announced = new Set<string>();

export async function announceQuestion(input: {
	projectId: string;
	chatSessionId: string;
	toolUseId: string;
	questions: AskUserQuestion[];
}): Promise<void> {
	const { projectId, chatSessionId, toolUseId } = input;
	const questions = input.questions.filter((q) => q && typeof q.question === 'string' && Array.isArray(q.options));
	if (questions.length === 0 || announced.has(toolUseId)) return;
	if (channelMessageQueries.forToolUse(toolUseId).length > 0) return;
	announced.add(toolUseId);
	setTimeout(() => announced.delete(toolUseId), 10 * 60 * 1000).unref?.();

	// Only the chat that started this turn is in a conversation with it.
	const origin = liveTurn(chatSessionId);
	const link = origin ? channelLinkQueries.getById(origin.linkId) : null;
	if (!link || !channelLinkQueries.isActive(link) || !channelRuntime.get(link.account_id)) return;

	const context = resolveContext(projectId, chatSessionId);
	const openUrl = sessionUrl(projectId, chatSessionId);

	for (const [index, question] of questions.entries()) {
		const id = newChannelMessageId();
		const payload: QuestionPayload = { question, index, total: questions.length, context, selected: [], openUrl };
		try {
			const sent = await channelRuntime.send(link.account_id, link.conversation_id, questionCard(id, payload));
			if (!sent.platform_message_id) continue;
			channelMessageQueries.create({
				id,
				linkId: link.id,
				kind: 'question',
				projectId,
				chatSessionId,
				toolUseId,
				questionIndex: index,
				platformMessageId: sent.platform_message_id,
				payload
			});
		} catch (error) {
			debug.warn('chat-apps', 'Sending a question to a channel failed:', error);
		}
	}
}

/** Close every still-open message for these questions, saying why. */
async function closeQuestions(rows: ChannelMessageRow[], reason: 'answered-elsewhere' | 'run-ended'): Promise<void> {
	for (const row of rows) {
		if (row.state !== 'open' || !channelMessageQueries.settle(row.id, 'closed')) continue;
		const link = channelLinkQueries.getById(row.link_id);
		if (!link) continue;
		await channelRuntime.edit(link.account_id, link.conversation_id, row.platform_message_id, questionClosedCard(parsePayload<QuestionPayload>(row), reason));
	}
}

/** Tool results arrived — any question they answer is settled, wherever it was answered. */
export async function settleToolUses(toolUseIds: string[]): Promise<void> {
	for (const toolUseId of toolUseIds) {
		await closeQuestions(channelMessageQueries.forToolUse(toolUseId), 'answered-elsewhere');
	}
}

let lastPruneAt = 0;

/**
 * The chat that started this turn gets its answer — in full, formatted, split
 * as needed, as a reply to the message that asked when there is one. Each
 * message is recorded against the turn's end, so replying to any of them
 * continues from here.
 */
async function deliverAnswer(
	link: ChannelLinkRow,
	input: { status: 'completed' | 'error' | 'cancelled'; projectId: string; chatSessionId: string; replyTo: string | null; reason?: string; chatName?: string | null }
): Promise<void> {
	const { status, projectId, chatSessionId } = input;
	const context = resolveContext(projectId, chatSessionId);
	// Inside the conversation the chat is already in, a header on every reply is
	// noise; it is shown only when the answer is about some other session.
	// Clopen's chat is one conversation however many chats it is split into.
	const project = projectQueries.getById(projectId);
	const showHeader = link.active_session_id !== chatSessionId && !(project && isAssistantProject(project));
	const answer = lastTurnAnswer(chatSessionId);

	// Pictures the answer shows go out after its text, and their paths leave it.
	const root = project ? resolveSessionPath(chatSessionId, project.path) : null;
	const { markdown, images } = answer.text ? await answerImages(answer.text, root) : { markdown: '', images: [] };

	let runs;
	if (status === 'cancelled') {
		// Stopped from this chat with nothing said: "Stopped" was already the reply.
		const stoppedHere = takeStoppedByChat(chatSessionId);
		if (!markdown.trim()) {
			if (!stoppedHere) await channelRuntime.send(link.account_id, link.conversation_id, textCard('⏹ Stopped.'), input.replyTo).catch(() => {});
			return;
		}
		runs = stoppedRuns({ context, showHeader, partial: markdown });
	} else if (status === 'error') {
		runs = failedRuns({ context, showHeader, reason: input.reason ?? answer.error, partial: markdown });
	} else {
		const said = markdown.trim() ? markdown : turnActionSummary(chatSessionId) ?? 'Done.';
		// From one of Clopen's chats that is not open now: named, so it is clear where it belongs.
		runs = answerRuns({ markdown: input.chatName ? `💬 _${input.chatName}_\n\n${said}` : said, context, showHeader });
	}

	try {
		const results = await channelRuntime.sendLong(link.account_id, link.conversation_id, runs, { replyTo: input.replyTo });
		for (const image of images) {
			try {
				results.push(await channelRuntime.sendFile(link.account_id, link.conversation_id, image));
			} catch (error) {
				debug.log('chat-apps', 'An image of an answer could not be sent:', error);
			}
		}
		for (const result of results) {
			if (!result.platform_message_id) continue;
			channelMessageQueries.create({
				linkId: link.id,
				kind: 'answer',
				projectId,
				chatSessionId,
				clopenMessageId: answer.endMessageId,
				platformMessageId: result.platform_message_id,
				state: 'closed'
			});
		}
	} catch (error) {
		debug.warn('chat-apps', 'Delivering an answer to a channel failed:', error);
	}
}

export async function announceRunEnded(input: {
	status: 'completed' | 'error' | 'cancelled';
	projectId: string;
	chatSessionId: string;
	reason?: string;
}): Promise<void> {
	const { status, projectId, chatSessionId, reason } = input;

	// Whatever is still asking for an answer will never get one now.
	await closeQuestions(channelMessageQueries.openQuestionsForSession(chatSessionId), 'run-ended');

	if (Date.now() - lastPruneAt > 60 * 60 * 1000) {
		lastPruneAt = Date.now();
		channelMessageQueries.pruneBefore(new Date(Date.now() - MESSAGE_RETENTION_MS).toISOString());
	}

	const origin = endLiveTurn(chatSessionId);
	if (reason === 'session-deleted') return;
	// The last words of a turn can be saved just after the turn says it ended.
	if (status === 'completed') await answerSettled(chatSessionId);
	const project = projectQueries.getById(projectId);
	if (!project || !isAssistantProject(project)) {
		// A project's chat: the answer goes back to the chat app that asked.
		if (!origin) return;
		const link = channelLinkQueries.getById(origin.linkId);
		if (link && channelLinkQueries.isActive(link) && channelRuntime.get(link.account_id)) {
			await deliverAnswer(link, { status, projectId, chatSessionId, replyTo: origin.platformMessageId, reason });
		}
		return;
	}
	// One of Clopen's chats: the answer reaches every chat app in that chat —
	// as a reply in the one it was typed in, plainly in the others. A turn
	// typed on the web, or one nobody typed (Clopen carrying on once a
	// service connected), reaches them all the same.
	const session = sessionQueries.getById(chatSessionId) as { origin?: string | null } | null;
	if (session?.origin && session.origin !== 'owner') return;
	const chatId = chatOfSession(chatSessionId);
	// The owner's Telegram hears every chat: the open one as is, another one named.
	const links = clopenLinks(channelRuntime.activeAccountIds());
	const chatName = chatId === activeChat() ? null : (listChats().find((chat) => chat.id === chatId)?.title ?? null);
	const asker = origin ? channelLinkQueries.getById(origin.linkId) : null;
	if (asker && channelLinkQueries.isActive(asker) && !links.some((link) => link.id === asker.id)) links.push(asker);
	const hasAnswer = Boolean(lastTurnAnswer(chatSessionId).text?.trim());
	for (const link of links) {
		const isAsker = link.id === asker?.id;
		// Elsewhere, only a real answer is news; "stopped" or a failure is told where it was asked.
		if (!isAsker && (status !== 'completed' || !hasAnswer)) continue;
		if (!channelRuntime.get(link.account_id)) continue;
		await deliverAnswer(link, { status, projectId, chatSessionId, replyTo: isAsker ? (origin?.platformMessageId ?? null) : null, reason, chatName });
		debug.log('chat-apps', `Answer of ${chatSessionId} delivered to chat ${link.id}${isAsker ? ' (asked there)' : ''}`);
	}
	if (!links.length) debug.log('chat-apps', `Answer of ${chatSessionId}: no chat app is linked`);
}

/**
 * What the owner typed on the web, shown in their Telegram — "💻 …" — so the
 * answer that follows has its question. The message sent is remembered by
 * the row it mirrors, so an edit on the web edits it there too.
 */
export async function mirrorOwnerMessage(chatId: string, text: string, options: { attachments: number; fromLinkId: string | null; rowId?: string }): Promise<void> {
	if (!channelRuntime.isStarted) return;
	const said = text.trim().slice(0, 3500);
	const extra = options.attachments ? ` 📎${options.attachments > 1 ? ` ×${options.attachments}` : ''}` : '';
	if (!said && !extra) return;
	const chatName = chatId === activeChat() ? null : (listChats().find((chat) => chat.id === chatId)?.title ?? null);
	for (const link of clopenLinks(channelRuntime.activeAccountIds())) {
		if (link.id === options.fromLinkId) continue;
		try {
			const sent = await channelRuntime.send(link.account_id, link.conversation_id, { runs: mirrorRuns(said + extra, chatName) });
			if (options.rowId && sent.platform_message_id) {
				channelMessageQueries.create({ linkId: link.id, kind: 'answer', clopenMessageId: options.rowId, platformMessageId: sent.platform_message_id, payload: { mirror: true, chatName } });
			}
		} catch (error) {
			debug.warn('chat-apps', 'Mirroring a message to a chat failed:', error);
		}
	}
}

function mirrorRuns(text: string, chatName: string | null): TextRun[] {
	return [{ text: '💻 ', bold: true }, ...(chatName ? [{ text: `${chatName} · `, italic: true }] : []), { text, italic: true }];
}

/** The owner edited on the web a message that was mirrored: its copy in Telegram changes too. */
export async function editMirroredMessage(rowId: string, text: string): Promise<void> {
	if (!channelRuntime.isStarted) return;
	for (const link of clopenLinks(channelRuntime.activeAccountIds())) {
		const row = channelMessageQueries.getAnswerFor(link.id, rowId);
		if (!row) continue;
		let chatName: string | null = null;
		try {
			chatName = (JSON.parse(row.payload) as { chatName?: string | null }).chatName ?? null;
		} catch {
			// Unnamed.
		}
		await channelRuntime.edit(link.account_id, link.conversation_id, row.platform_message_id, { runs: [...mirrorRuns(text.trim().slice(0, 3500), chatName), { text: ' ✏️' }] }).catch(() => {});
	}
}

/**
 * A line of Clopen's chat that is not a turn's answer (the quick word a
 * message gets): to the owner's Telegram once — the row id records that it
 * went — as a reply to the message it answers, wherever that one is there
 * (typed in Telegram, or mirrored from the web).
 */
export async function deliverLine(chatId: string, line: { id: string; text: string; replyTo: string | null }): Promise<void> {
	if (!channelRuntime.isStarted) return;
	const chatName = chatId === activeChat() ? null : chatTitle(chatId);
	for (const link of clopenLinks(channelRuntime.activeAccountIds())) {
		if (!channelRuntime.get(link.account_id) || channelMessageQueries.getAnswerFor(link.id, line.id)) continue;
		const answered = line.replyTo ? (channelMessageQueries.getUserMessage(link.id, line.replyTo) ?? channelMessageQueries.getAnswerFor(link.id, line.replyTo)) : null;
		try {
			const sent = await channelRuntime.send(link.account_id, link.conversation_id, textCard(chatName ? `💬 ${chatName}\n\n${line.text}` : line.text), answered?.platform_message_id ?? null);
			if (sent.platform_message_id) channelMessageQueries.create({ linkId: link.id, kind: 'answer', clopenMessageId: line.id, platformMessageId: sent.platform_message_id, state: 'closed', payload: { line: true } });
		} catch (error) {
			debug.warn('chat-apps', 'Sending a line to a chat failed:', error);
		}
	}
}

/** One short line to the owner's Telegram — a chat switched on the web. */
export async function noteToChatApps(text: string): Promise<void> {
	if (!channelRuntime.isStarted) return;
	for (const link of clopenLinks(channelRuntime.activeAccountIds())) {
		await channelRuntime.send(link.account_id, link.conversation_id, { runs: [{ text, italic: true }] }).catch(() => {});
	}
}

/** Wait (briefly) until the finished turn has its answer saved. */
async function answerSettled(chatSessionId: string): Promise<void> {
	for (let tries = 0; tries < 8 && !lastTurnAnswer(chatSessionId).text?.trim(); tries++) {
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

/** A deleted session leaves nothing to reply to, and nothing to continue. */
export function forgetSession(chatSessionId: string): void {
	endLiveTurn(chatSessionId);
	channelMessageQueries.deleteForSession(chatSessionId);
	channelLinkQueries.clearActiveSession(chatSessionId);
}

/**
 * Tell every paired chat something that did not come from a turn it started —
 * a report from the Clopen assistant's Inbox: a task that finished or got
 * stuck, an automation's result, an approval waiting. Chats without the
 * `control` capability still get these: they are notifications, not commands.
 *
 * One message per event: a chat that is waiting on the turn this came from
 * (`fromSessionId`) is skipped — that turn's answer is about to reach it.
 * Never throws; a chat that cannot be reached is skipped.
 */
export async function broadcastToChats(markdown: string, options: { fromSessionId?: string | null; chatId?: string | null } = {}): Promise<number> {
	if (!channelRuntime.isStarted) return 0;
	const waiting = options.fromSessionId ? liveTurn(options.fromSessionId)?.linkId ?? null : null;
	const accounts = channelRuntime.activeAccountIds();
	const all = accounts.flatMap((accountId) => channelLinkQueries.listByAccount(accountId)).filter((link) => channelLinkQueries.isActive(link));
	// Into the chat it belongs to; when no chat app is in that chat, to all of them, named — the owner must still hear it.
	const inChat = options.chatId ? linksInChat(options.chatId, accounts) : all;
	const targets = inChat.length ? inChat : all;
	const named = !inChat.length && options.chatId ? chatTitle(options.chatId) : null;
	let sent = 0;
	for (const link of targets) {
		if (link.id === waiting) continue;
		try {
			await channelRuntime.sendLong(link.account_id, link.conversation_id, markdownToRuns(named ? `_${named}_ · ${markdown}` : markdown));
			sent += 1;
		} catch (error) {
			debug.warn('chat-apps', 'Broadcasting to a chat failed:', error);
		}
	}
	return sent;
}

/** A chat's name, for a message that reaches the owner outside it; null for Main. */
function chatTitle(chatId: string): string | null {
	return listChats().find((chat) => chat.id === chatId && chat.id !== MAIN_CHAT)?.title ?? null;
}

/**
 * Files for the owner (`send`, a recipe's `tell`): to the chat that is waiting
 * on `fromSessionId`'s turn when there is one — that is the conversation they
 * belong to — otherwise to every linked chat. Never throws.
 */
/** Width and height of a PNG or JPEG, read from its header; null for anything else. */
export function imageSize(data: Uint8Array): { width: number; height: number } | null {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	if (data.byteLength > 24 && data[0] === 0x89 && data[1] === 0x50) return { width: view.getUint32(16), height: view.getUint32(20) };
	if (data.byteLength > 4 && data[0] === 0xff && data[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < data.byteLength) {
			if (data[offset] !== 0xff) return null;
			const marker = data[offset + 1];
			const length = view.getUint16(offset + 2);
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
			}
			offset += 2 + length;
		}
	}
	return null;
}

/** A tall or huge image is unreadable once a chat app shrinks it to a photo: send it as a file. */
function shouldSendAsDocument(file: { data: Uint8Array; mime: string }): boolean {
	if (!file.mime.startsWith('image/')) return false;
	const size = imageSize(file.data);
	if (!size) return false;
	return size.height / size.width > 2.5 || size.width / size.height > 2.5 || size.width + size.height > 8000;
}

/** Longest caption a file can carry; a longer message goes on its own, before the files. */
const MAX_CAPTION = 1000;

/**
 * Send files (with their message) to the owner's chats: the message rides as
 * the first file's caption, so a screenshot and what it shows arrive as one
 * message. When a chat is in a live turn, only that chat gets them — and a
 * text-only update is left to the turn's own answer instead of arriving twice.
 * Returns the chats reached and what could not be sent.
 */
export async function sendFilesToChats(
	files: Array<{ data: Uint8Array; mime: string; filename: string; caption?: string }>,
	options: { fromSessionId?: string | null; text?: string; chatId?: string | null } = {}
): Promise<{ sent: number; failed: string[] }> {
	const failed: string[] = [];
	if (!channelRuntime.isStarted || (files.length === 0 && !options.text)) return { sent: 0, failed };
	const live = options.fromSessionId ? liveTurn(options.fromSessionId) : null;
	if (live && files.length === 0) return { sent: 0, failed };
	const targets: ChannelLinkRow[] = [];
	if (live) {
		const link = channelLinkQueries.getById(live.linkId);
		if (link && channelLinkQueries.isActive(link)) targets.push(link);
	} else {
		// The chat apps in the chat it belongs to; all of them when none is in it — the owner must still get it.
		const inChat = options.chatId ? linksInChat(options.chatId, channelRuntime.activeAccountIds()) : [];
		if (inChat.length) targets.push(...inChat);
		else {
			for (const accountId of channelRuntime.activeAccountIds()) {
				for (const link of channelLinkQueries.listByAccount(accountId)) if (channelLinkQueries.isActive(link)) targets.push(link);
			}
		}
	}
	const text = options.text?.trim() ?? '';
	const captionFits = files.length > 0 && text.length > 0 && text.length <= MAX_CAPTION;
	let sent = 0;
	for (const link of targets) {
		try {
			if (text && !captionFits) await channelRuntime.sendLong(link.account_id, link.conversation_id, markdownToRuns(text));
			for (const [index, file] of files.entries()) {
				const caption = index === 0 && captionFits ? text : file.caption;
				const outgoing = { ...file, caption, asDocument: shouldSendAsDocument(file) };
				try {
					await channelRuntime.sendFile(link.account_id, link.conversation_id, outgoing);
				} catch (error) {
					// A photo the platform refuses (size, proportions) usually goes through as a file.
					if (outgoing.asDocument) throw error;
					await channelRuntime.sendFile(link.account_id, link.conversation_id, { ...outgoing, asDocument: true });
				}
			}
			sent += 1;
		} catch (error) {
			debug.warn('chat-apps', 'Sending files to a chat failed:', error);
			failed.push(error instanceof Error ? error.message : String(error));
		}
	}
	return { sent, failed };
}

/**
 * A card that needs the owner — a question, an approval, a service to connect,
 * a key to give — sent to every linked chat as one message they can act on:
 * reply to answer (or "yes"/"no" for an approval), tap the link to connect.
 * A key card also takes the chat's NEXT message as the key, so the owner
 * does not even have to reply to it.
 */
export async function announceCard(item: InboxItem): Promise<void> {
	if (!channelRuntime.isStarted) return;
	const card = String(item.data.card ?? '');
	const options = Array.isArray(item.data.options) ? (item.data.options as string[]) : [];
	const url = typeof item.data.url === 'string' ? item.data.url : null;
	const body = item.body.trim();
	const lines = [`**${item.title}**`];
	// Short in a chat: the card says what is asked; a long report behind it stays on the web.
	if (body && card !== 'connect') lines.push(body.length > 500 ? `${body.slice(0, 480).replace(/\s+\S*$/, '')}…` : body);
	// The one line of instructions, in the owner's language; buttons need none.
	const fields = Array.isArray(item.data.fields) ? (item.data.fields as Array<{ name: string; label: string; secret?: boolean }>) : [];
	// A login (email, then password) is asked one field at a time, each its own message to reply to.
	const stepwise = card === 'secret' && fields.length > 1;
	const hint =
		stepwise
			? 'Stored encrypted, removed from this chat, and never shown to the AI.'
			: card === 'secret'
			? 'Reply to this message with it. It is stored encrypted, removed from this chat, and never shown to the AI.'
			: card === 'ask' && options.length === 0
				? 'Reply to this message to answer.'
				: null;
	if (hint) {
		const { inOwnersLanguage, ownerSample } = await import('$backend/assistant/think');
		lines.push(`_${await inOwnersLanguage(hint, ownerSample(item.sessionId) ?? item.title)}_`);
	}
	const runs = markdownToRuns(lines.join('\n\n'));
	const live = item.sessionId ? liveTurn(item.sessionId) : null;
	for (const accountId of channelRuntime.activeAccountIds()) {
		for (const link of channelLinkQueries.listByAccount(accountId)) {
			if (!channelLinkQueries.isActive(link)) continue;
			// A chat waiting on the turn that raised it hears it once, in that turn's answer — unless it needs input.
			if (live?.linkId === link.id && card !== 'secret' && card !== 'connect' && item.kind !== 'approval' && card !== 'ask') continue;
			try {
				const rowId = newChannelMessageId();
				const buttons: ChannelButton[][] =
					card === 'connect' && url
						? [[{ label: `🔗 ${item.title}`, url }]]
						: item.kind === 'approval'
							? [[{ label: '✅', data: encodeButtonData(rowId, { type: 'confirm' }) }, { label: '✖', data: encodeButtonData(rowId, { type: 'cancel' }) }]]
							: card === 'ask' && options.length
								? options.slice(0, 8).map((option, index) => [{ label: option.slice(0, 60), data: encodeButtonData(rowId, { type: 'option', index }) }])
								: [];
				const sent = await channelRuntime.send(accountId, link.conversation_id, { runs, ...(buttons.length ? { buttons } : {}) });
				if (!sent.platform_message_id) continue;
				channelMessageQueries.create({
					id: rowId,
					linkId: link.id,
					kind: 'menu',
					platformMessageId: sent.platform_message_id,
					payload: { card: item.id, options }
				});
				if (stepwise) await askCardField(link, item, 0);
			} catch (error) {
				debug.warn('chat-apps', 'Sending a card to a chat failed:', error);
			}
		}
	}
}

/**
 * One field of a login card, as its own message to reply to: "✏️ Email or
 * username — reply to this message". The reply fills that field only.
 */
export async function askCardField(link: ChannelLinkRow, item: InboxItem, index: number): Promise<void> {
	const fields = Array.isArray(item.data.fields) ? (item.data.fields as Array<{ name: string; label: string }>) : [];
	const field = fields[index];
	if (!field) return;
	const { inOwnersLanguage, ownerSample } = await import('$backend/assistant/think');
	const line = await inOwnersLanguage(`${field.label} — reply to this message.`, ownerSample(item.sessionId) ?? item.title);
	const rowId = newChannelMessageId();
	const sent = await channelRuntime.send(link.account_id, link.conversation_id, { runs: [{ text: '✏️ ' }, { text: line, bold: true }] });
	if (!sent.platform_message_id) return;
	channelMessageQueries.create({ id: rowId, linkId: link.id, kind: 'menu', platformMessageId: sent.platform_message_id, payload: { card: item.id, field: index, options: [] } });
}

/**
 * A card was settled — answered here, in the web, or by the work finishing
 * (a service connected). Its message in every chat loses its buttons and
 * says so, instead of offering a link that no longer leads anywhere.
 */
export async function settleCardMessages(item: InboxItem): Promise<void> {
	if (!channelRuntime.isStarted) return;
	const rows = channelMessageQueries.forCard(item.id);
	if (!rows.length) return;
	const declined = item.resolution && (item.resolution as { approved?: boolean }).approved === false;
	const mark = item.status === 'dismissed' ? '—' : declined ? '✖' : '✅';
	for (const row of rows) {
		if (!channelMessageQueries.settle(row.id, 'closed')) continue;
		const link = channelLinkQueries.getById(row.link_id);
		if (!link || !channelLinkQueries.isActive(link)) continue;
		await channelRuntime.edit(link.account_id, link.conversation_id, row.platform_message_id, { runs: markdownToRuns(`${mark} ${item.title}`) });
	}
}
