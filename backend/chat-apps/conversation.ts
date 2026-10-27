/**
 * Controlling Clopen from a chat — the conversation half of a chat app.
 *
 * A chat app has one thread per chat; Clopen has many sessions in many
 * projects. Each paired chat therefore carries an ACTIVE TARGET — a project,
 * and the session in it that a plain message continues:
 *
 *   - A plain message (text, photos, files, an album) continues the active
 *     session (queued if it is busy), or starts one if the chat has none
 *     yet. With no project picked, the chat is in the user's Home: chatting
 *     never requires choosing a project.
 *   - A reply to an earlier message continues from THAT point. If it is the
 *     latest point that is just the next turn; if it is an older one, Clopen
 *     goes back to it — the same restore as the web UI's — and the new turn
 *     branches from there.
 *   - Editing a message the user sent from the chat is Edit Message — or, if
 *     it is still waiting in the queue, simply changes what will run.
 *
 * Everything else (sessions, files, skills, projects, models, engine
 * accounts) is the CONTROL CATALOG (`backend/control/`). This
 * module only turns a command into an action, an action's result into a
 * message with buttons, and a button back into an action. It implements none
 * of them.
 *
 * A button acts where it was SHOWN. A menu and a confirmation carry the
 * target they were made for, so tapping one after switching sessions never
 * acts on the session the chat moved to: "Delete 'A'?" deletes A.
 *
 * Going back restores FILES, not just the conversation. That is never done
 * silently from a phone: it is asked first, with the session it touches and
 * the message it will send, and files another session changed since are left
 * as they are rather than overwritten. Destructive catalog actions are asked
 * about the same way.
 */

import { readFileSync } from 'fs';
import { markdownToRuns, type TextRun, type UniversalMessage } from '@myrialabs/chatkit';
import type { StreamRequest } from '$shared/types/unified';
import type { ChatSession, Project } from '$shared/types/database/schema';
import {
	channelLinkQueries,
	channelMessageQueries,
	messageQueries,
	sessionQueries,
	type ChannelLinkRow,
	type ChannelMessageRow
} from '$backend/database/queries';
import { getUserById, type AuthUser } from '$backend/auth/auth-service';
import { checkSessionRestoreConflicts, restoreSessionTo, restoreTargetEnd } from '$backend/snapshot/restore';
import { INITIAL_NODE_ID } from '$backend/snapshot/helpers';
import { lastTurnAnswer, userMessageText } from '$backend/chat/turn-answer';
import {
	accessibleSession,
	accountFor,
	normaliseSkillName,
	checkArgs,
	confirmationFor,
	controlActionForCommand,
	controlHelp,
	createControlContext,
	createSession,
	getControlAction,
	isSessionBusy,
	modelOf,
	parseCommandArgument,
	pickModel,
	projectLabel,
	resolveTarget,
	runControlAction,
	canRun,
	type ControlChoice,
	type ControlResult,
	type ControlTarget
} from '$backend/control';
import { debug } from '$shared/utils/logger';
import { channelRuntime, type ActiveChannel } from './runtime';
import { accountHas, parsePayload } from './outbound';
import { expectTurn, forgetExpectedTurn, markStoppedByChat, queuedPromptFor, setExpectedQueueId } from './turns';
import { replyText } from './questions';
import { setAwaiting } from './awaiting';
import { approveLink, rejectLink } from './approvals';
import { promptContent, type PromptAttachment } from './media';
import { REPLIES, CHAT_COMMANDS, confirmCard, menuCard, textCard, type ButtonAction } from './messages';

/**
 * The composer, as a chat app needs it: start (or queue) a turn exactly as
 * the web does, and change a message still waiting in the queue. Injected by
 * the chat composer at load: it lives in the WebSocket layer, which imports
 * this module through the stream hooks, so importing it back would be a cycle.
 */
export interface Composer {
	submit(input: { userId: string; userName: string; request: StreamRequest }): Promise<{ outcome: 'started' | 'queued'; queueId: string }>;
	replaceQueued(chatSessionId: string, queueId: string, userId: string, content: unknown[]): boolean;
}

let composer: Composer | null = null;

export function registerComposer(instance: Composer): void {
	composer = instance;
}

export interface Conversation {
	channel: ActiveChannel;
	message: UniversalMessage;
	link: ChannelLinkRow;
	user: AuthUser;
}

/** The project and session a plain message from this chat goes to. */
export function activeTarget(link: ChannelLinkRow, user: AuthUser): { project: Project; session: ChatSession | null } {
	return resolveTarget(user.id, { projectId: link.active_project_id ?? undefined, sessionId: link.active_session_id });
}

function activeControlTarget(conversation: Conversation): ControlTarget {
	const { project, session } = activeTarget(reload(conversation.link), conversation.user);
	return { projectId: project.id, sessionId: session?.id ?? null };
}

/** Driving Clopen needs the bot's `control` capability. */
export function canControl(link: ChannelLinkRow): boolean {
	return accountHas(link.account_id, 'control');
}

async function requireControl(conversation: Conversation): Promise<boolean> {
	if (canControl(conversation.link)) return true;
	await replyText(conversation.channel, conversation.message, REPLIES.controlOff);
	return false;
}

function reload(link: ChannelLinkRow): ChannelLinkRow {
	return channelLinkQueries.getById(link.id) ?? link;
}

// ── Sending ─────────────────────────────────────────────────────────────────

/**
 * Send `text` and `attachments` as the next turn of `session` (or of a new
 * session in `project`), on behalf of the chat's user. The turn's answer
 * comes back to this chat; the user's message is mapped so it can be edited
 * later.
 */
export async function sendPrompt(
	conversation: Conversation,
	target: { project: Project; session: ChatSession | null },
	text: string,
	attachments: PromptAttachment[],
	options: { platformMessageId: string | null }
): Promise<void> {
	const { channel, message, link, user } = conversation;
	if (!composer) {
		await replyText(channel, message, REPLIES.answerFailed);
		return;
	}
	if (!text.trim() && attachments.length === 0) {
		await replyText(channel, message, REPLIES.nothingToSend);
		return;
	}

	let session = target.session;
	if (!session) {
		const model = pickModel(user.id, target.project.id);
		if (!model) {
			await replyText(channel, message, REPLIES.noModel);
			return;
		}
		session = createSession(target.project, model);
	}
	const model = modelOf(session) ?? pickModel(user.id, target.project.id);
	if (!model) {
		await replyText(channel, message, REPLIES.noModel);
		return;
	}

	// The web picker always sends an account; so must a chat. A session made
	// here, or one that just switched engine, has none pinned yet.
	const account = accountFor(session, model);
	const engine = {
		type: model.engine,
		provider: model.provider,
		model: { id: model.modelId, name: model.modelName },
		account: account ?? { id: 0, name: '' }
	};
	const sender = { id: user.id, name: user.name };
	const promptMessageId = crypto.randomUUID();
	const request: StreamRequest = {
		projectPath: target.project.path,
		projectId: target.project.id,
		chatSessionId: session.id,
		prompt: {
			type: 'user',
			createdAt: new Date().toISOString(),
			messageId: promptMessageId,
			sessionId: session.id,
			// The branch tip is resolved server-side from HEAD, as for a queued message.
			parent: { messageId: null, sessionId: null, toolUseId: null },
			engine,
			sender,
			content: promptContent(text, attachments),
			synthetic: false
		} as StreamRequest['prompt'],
		engine: engine as StreamRequest['engine'],
		sender,
		profileId: session.profile_id ?? null,
		reasoningEffort: session.reasoning_effort ?? null,
		requestedByUserId: user.id
	};

	channelLinkQueries.setActive(link.id, target.project.id, session.id);
	expectTurn(session.id, {
		linkId: link.id,
		accountId: channel.accountId,
		conversationId: message.address.conversation_id,
		projectId: target.project.id,
		platformMessageId: options.platformMessageId,
		promptMessageId
	});

	try {
		const { outcome, queueId } = await composer.submit({ userId: user.id, userName: user.name, request });
		if (outcome === 'queued') {
			setExpectedQueueId(session.id, promptMessageId, queueId);
			await replyText(channel, message, REPLIES.queued);
		}
	} catch (error) {
		forgetExpectedTurn(session.id, promptMessageId);
		debug.warn('chat-apps', 'Sending a prompt from a chat app failed:', error);
		await replyText(channel, message, `${REPLIES.answerFailed}${error instanceof Error ? ` (${error.message})` : ''}`);
	}
}

/** A plain message: continue the active target. */
export async function continueActive(conversation: Conversation, text: string, attachments: PromptAttachment[]): Promise<void> {
	if (!(await requireControl(conversation))) return;
	const target = activeTarget(reload(conversation.link), conversation.user);
	await sendPrompt(conversation, target, text, attachments, { platformMessageId: conversation.message.platform_message_id ?? null });
}

// ── Confirmations ───────────────────────────────────────────────────────────

interface RewindPayload {
	kind: 'rewind';
	/** `undo` goes back without sending anything. */
	action: 'branch' | 'edit' | 'retry' | 'undo';
	projectId: string;
	sessionId: string;
	/** What to restore to: a message id, or `__initial__` for before the first message. */
	restoreTo: string;
	text: string;
	/** The chat message to map the new turn's user message to (edit/branch), if any. */
	platformMessageId: string | null;
}

/** A catalog action waiting for a yes — with the target it was asked about. */
interface ActionPayload {
	kind: 'action';
	actionId: string;
	args: Record<string, unknown>;
	target: ControlTarget;
}

/** Text that looked like a command but is not one, offered as a message. */
interface SendPayload {
	kind: 'send';
	text: string;
}

type ConfirmPayload = RewindPayload | ActionPayload | SendPayload;

/**
 * Files riding on a confirmation (an edit or a reply that goes back first).
 * Kept in memory rather than in the row: they can be megabytes, and a
 * confirmation outliving a restart can still send its text.
 */
const confirmAttachments = new Map<string, { attachments: PromptAttachment[]; at: number }>();
const CONFIRM_ATTACHMENTS_TTL_MS = 60 * 60 * 1000;

function keepAttachments(rowId: string, attachments: PromptAttachment[]): void {
	const now = Date.now();
	for (const [id, entry] of confirmAttachments) if (now - entry.at > CONFIRM_ATTACHMENTS_TTL_MS) confirmAttachments.delete(id);
	if (attachments.length) confirmAttachments.set(rowId, { attachments, at: now });
}

function takeAttachments(rowId: string): PromptAttachment[] {
	const entry = confirmAttachments.get(rowId);
	confirmAttachments.delete(rowId);
	return entry?.attachments ?? [];
}

/**
 * Write the confirm row first — its id rides on the buttons — then send it.
 * Older open confirmations that `supersedes` matches are closed: editing a
 * message twice asks once, about the newest text.
 */
async function sendConfirmation(
	conversation: Conversation,
	payload: ConfirmPayload,
	card: { title: string; detail: string; confirmLabel: string },
	scope: { projectId?: string; sessionId?: string },
	options: { attachments?: PromptAttachment[]; supersedes?: (older: ConfirmPayload) => boolean } = {}
): Promise<void> {
	const { channel, message, link } = conversation;
	if (options.supersedes) {
		for (const older of channelMessageQueries.openConfirmsForLink(link.id)) {
			if (!options.supersedes(parsePayload<ConfirmPayload>(older)) || !channelMessageQueries.settle(older.id, 'closed')) continue;
			takeAttachments(older.id);
			await channelRuntime.edit(link.account_id, link.conversation_id, older.platform_message_id, textCard(REPLIES.editReplaced));
		}
	}
	const id = channelMessageQueries.create({
		linkId: link.id,
		kind: 'confirm',
		projectId: scope.projectId ?? null,
		chatSessionId: scope.sessionId ?? null,
		platformMessageId: 'pending',
		payload
	}).id;
	keepAttachments(id, options.attachments ?? []);
	try {
		const sent = await channelRuntime.send(channel.accountId, message.address.conversation_id, confirmCard(id, card), message.content.type === 'postback' ? null : message.platform_message_id ?? null);
		if (sent.platform_message_id) channelMessageQueries.setPlatformMessage(id, sent.platform_message_id);
	} catch (error) {
		channelMessageQueries.settle(id, 'closed');
		takeAttachments(id);
		throw error;
	}
}

// ── Going back: reply to an older point, edit, retry, undo ──────────────────

/**
 * Continue from a specific point. The latest point is simply the next turn;
 * an older one is a rewind, which is confirmed first.
 */
export async function continueFrom(conversation: Conversation, row: ChannelMessageRow, text: string, attachments: PromptAttachment[]): Promise<void> {
	if (!(await requireControl(conversation))) return;
	const target = accessibleSession(conversation.user.id, row.chat_session_id);
	if (!target) {
		await replyText(conversation.channel, conversation.message, REPLIES.sessionGone);
		return;
	}
	const head = sessionQueries.getHead(target.session.id);
	const end = row.clopen_message_id ? restoreTargetEnd(target.session.id, row.clopen_message_id) : null;
	// No point recorded, or the point IS the latest: this is just the next message.
	if (!row.clopen_message_id || !end || end === head) {
		await sendPrompt(conversation, target, text, attachments, { platformMessageId: conversation.message.platform_message_id ?? null });
		return;
	}
	await askRewind(
		conversation,
		target,
		{
			kind: 'rewind',
			action: 'branch',
			projectId: target.project.id,
			sessionId: target.session.id,
			restoreTo: row.clopen_message_id,
			text,
			platformMessageId: conversation.message.platform_message_id ?? null
		},
		attachments
	);
}

/**
 * The user edited a message they sent from this chat. Still in the queue: it
 * just changes what will run. Already a turn: Edit Message.
 */
export async function editSent(conversation: Conversation, text: string, attachments: PromptAttachment[]): Promise<void> {
	const { link, message, user } = conversation;
	const platformMessageId = message.platform_message_id ?? null;
	if (!platformMessageId) {
		await replyText(conversation.channel, message, REPLIES.notEditable);
		return;
	}
	if (!(await requireControl(conversation))) return;

	const queued = queuedPromptFor(link.id, platformMessageId);
	if (queued && composer?.replaceQueued(queued.chatSessionId, queued.prompt.queueId!, user.id, promptContent(text, attachments))) {
		await replyText(conversation.channel, message, REPLIES.queuedEdited);
		return;
	}

	const row = channelMessageQueries.getByMessage(link.id, platformMessageId);
	if (!row || row.kind !== 'user' || !row.clopen_message_id) {
		await replyText(conversation.channel, message, REPLIES.notEditable);
		return;
	}
	const target = accessibleSession(user.id, row.chat_session_id);
	const original = messageQueries.getById(row.clopen_message_id);
	if (!target || !original) {
		await replyText(conversation.channel, message, REPLIES.notEditable);
		return;
	}
	await askRewind(
		conversation,
		target,
		{
			kind: 'rewind',
			action: 'edit',
			projectId: target.project.id,
			sessionId: target.session.id,
			restoreTo: original.parent_message_id || INITIAL_NODE_ID,
			text,
			platformMessageId
		},
		attachments
	);
}

/** The active session's last turn: its user message and what it said. */
function lastTurn(conversation: Conversation) {
	const { session } = activeTarget(reload(conversation.link), conversation.user);
	const target = session ? accessibleSession(conversation.user.id, session.id) : null;
	const turn = target ? lastTurnAnswer(target.session.id) : null;
	const userRow = turn?.userMessageId ? messageQueries.getById(turn.userMessageId) : null;
	return { target, userRow, text: turn?.userMessageId ? userMessageText(turn.userMessageId) : null };
}

/** /retry — ask the active session's last message again. */
async function retryLast(conversation: Conversation): Promise<void> {
	const { target, userRow, text } = lastTurn(conversation);
	if (!target || !text || !userRow) {
		await replyText(conversation.channel, conversation.message, REPLIES.nothingToRetry);
		return;
	}
	await askRewind(conversation, target, {
		kind: 'rewind',
		action: 'retry',
		projectId: target.project.id,
		sessionId: target.session.id,
		restoreTo: userRow.parent_message_id || INITIAL_NODE_ID,
		text,
		platformMessageId: null
	});
}

/** /undo — go back to before the active session's last message, sending nothing. */
async function undoLast(conversation: Conversation): Promise<void> {
	const { target, userRow, text } = lastTurn(conversation);
	if (!target || !userRow) {
		await replyText(conversation.channel, conversation.message, REPLIES.nothingToUndo);
		return;
	}
	await askRewind(conversation, target, {
		kind: 'rewind',
		action: 'undo',
		projectId: target.project.id,
		sessionId: target.session.id,
		restoreTo: userRow.parent_message_id || INITIAL_NODE_ID,
		text: text ?? '',
		platformMessageId: null
	});
}

const REWIND_WORDING: Record<RewindPayload['action'], { title: string; confirm: string }> = {
	branch: { title: '↩️ Continue from that point?', confirm: 'Go back & send' },
	edit: { title: '✏️ Edit and resend?', confirm: 'Edit & resend' },
	retry: { title: '🔁 Ask again?', confirm: 'Ask again' },
	undo: { title: '↩️ Undo the last message?', confirm: 'Undo' }
};

async function askRewind(
	conversation: Conversation,
	target: { project: Project; session: ChatSession },
	payload: RewindPayload,
	attachments: PromptAttachment[] = []
): Promise<void> {
	if (isSessionBusy(target.session)) {
		await replyText(conversation.channel, conversation.message, REPLIES.busyBranch);
		return;
	}
	let conflicts = 0;
	try {
		conflicts = (await checkSessionRestoreConflicts(target.session.id, payload.restoreTo)).conflicts.length;
	} catch (error) {
		debug.warn('chat-apps', 'Checking restore conflicts failed:', error);
	}
	const where = `"${target.session.title || 'this session'}" in ${projectLabel(target.project)}`;
	const quoted = payload.text.length > 160 ? `${payload.text.slice(0, 159)}…` : payload.text;
	const files = attachments.length ? ` (with ${attachments.length} file${attachments.length === 1 ? '' : 's'})` : '';
	const kept = conflicts > 0 ? ` (${conflicts} file${conflicts === 1 ? '' : 's'} another session changed since will be left as they are)` : '';
	const detail =
		payload.action === 'undo'
			? `Clopen goes back to before the last message in ${where}. Like Restore in Clopen, files it changed are restored${kept}. Nothing is sent.`
			: `Clopen goes back to that point in ${where}. Like Restore in Clopen, files the session changed after it are restored${kept}. Then it sends${files}:\n\n“${quoted}”`;
	const wording = REWIND_WORDING[payload.action];
	await sendConfirmation(
		conversation,
		payload,
		{ title: wording.title, detail, confirmLabel: wording.confirm },
		{ projectId: target.project.id, sessionId: target.session.id },
		{
			attachments,
			// A newer edit of the same message replaces the question about the older one.
			supersedes: payload.action === 'edit' && payload.platformMessageId
				? (older) => older.kind === 'rewind' && older.action === 'edit' && older.platformMessageId === payload.platformMessageId
				: undefined
		}
	);
}

async function performRewind(conversation: Conversation, row: ChannelMessageRow, payload: RewindPayload): Promise<void> {
	const { channel, message, link } = conversation;
	const attachments = takeAttachments(row.id);
	const target = accessibleSession(conversation.user.id, payload.sessionId);
	if (!target) {
		await replyText(channel, message, REPLIES.sessionGone);
		return;
	}
	if (isSessionBusy(target.session)) {
		await replyText(channel, message, REPLIES.busyRestore);
		return;
	}
	try {
		// Never overwrite what another session changed since: from a phone there
		// is no conflict dialog to ask, so the safe answer is the default.
		const check = await checkSessionRestoreConflicts(target.session.id, payload.restoreTo);
		const keep = Object.fromEntries(check.conflicts.map((conflict) => [conflict.filepath, 'keep' as const]));
		const result = await restoreSessionTo(target.session.id, payload.restoreTo, keep);
		const done = payload.action === 'undo' ? REPLIES.undone(result.filesRestored) : REPLIES.branched(result.filesRestored);
		await channelRuntime.edit(link.account_id, link.conversation_id, row.platform_message_id, textCard(done));
	} catch (error) {
		await replyText(channel, message, error instanceof Error ? error.message : REPLIES.answerFailed);
		return;
	}
	const refreshed = sessionQueries.getById(target.session.id) ?? target.session;
	if (payload.action === 'undo') {
		channelLinkQueries.setActive(link.id, target.project.id, refreshed.id);
		return;
	}
	await sendPrompt(
		{ ...conversation, message: { ...message, platform_message_id: payload.platformMessageId } },
		{ project: target.project, session: refreshed },
		payload.text,
		attachments,
		{ platformMessageId: payload.platformMessageId }
	);
}

// ── The control catalog ─────────────────────────────────────────────────────

/** Menu choices handled by the chat itself rather than the catalog. */
const CHAT_ACTION_PREFIX = 'chat.';

/** A menu's buttons, and the target they act on. */
interface MenuPayload {
	choices: ControlChoice[];
	target?: ControlTarget;
	/** Set when the row asked for typed words rather than offering buttons. */
	ask?: ControlResult['ask'];
}

async function sendMenu(conversation: Conversation, runs: TextRun[], payload: MenuPayload, extraButtons: Array<Array<{ label: string; url: string }>> = []): Promise<void> {
	const { channel, message, link } = conversation;
	const id = channelMessageQueries.create({ linkId: link.id, kind: 'menu', platformMessageId: 'pending', payload }).id;
	const card = menuCard(id, runs, payload.choices);
	const sent = await channelRuntime.send(channel.accountId, message.address.conversation_id, { ...card, buttons: [...(card.buttons ?? []), ...extraButtons] });
	if (sent.platform_message_id) channelMessageQueries.setPlatformMessage(id, sent.platform_message_id);
}

/** An action asked for words: send the question, and take the next message as its answer. */
async function sendAsk(conversation: Conversation, ask: NonNullable<ControlResult['ask']>, target: ControlTarget): Promise<void> {
	const { channel, message, link } = conversation;
	const id = channelMessageQueries.create({ linkId: link.id, kind: 'menu', platformMessageId: 'pending', payload: { choices: [], ask, target } }).id;
	const sent = await channelRuntime.send(channel.accountId, message.address.conversation_id, {
		runs: [{ text: `✏️ ${ask.question}`, bold: true }, { text: '\n' }, { text: 'Type it and send. Any command cancels.', italic: true }]
	});
	if (sent.platform_message_id) channelMessageQueries.setPlatformMessage(id, sent.platform_message_id);
	setAwaiting(link.id, { kind: 'ask', rowId: id });
}

/** Is this row an action waiting for typed words? */
export function isAsking(row: ChannelMessageRow): boolean {
	return row.kind === 'menu' && row.state === 'open' && Boolean(parsePayload<MenuPayload>(row).ask);
}

/** The words an action asked for arrived: run it with them, once. */
export async function answerAsk(conversation: Conversation, row: ChannelMessageRow, text: string): Promise<void> {
	const payload = parsePayload<MenuPayload>(row);
	if (!payload.ask || !channelMessageQueries.settle(row.id, 'answered')) {
		await replyText(conversation.channel, conversation.message, REPLIES.staleAction);
		return;
	}
	if (!(await requireControl(conversation))) return;
	const { action, args, key } = payload.ask;
	await runAction(conversation, action, { ...(args ?? {}), [key]: text.trim() }, payload.target);
}

/** Send the files a result carries, each as its own message. */
async function sendResultFiles(conversation: Conversation, result: ControlResult): Promise<void> {
	const { channel, message } = conversation;
	for (const file of result.files ?? []) {
		try {
			await channelRuntime.sendFile(channel.accountId, message.address.conversation_id, { data: readFileSync(file.path), filename: file.filename, mime: file.mime });
		} catch (error) {
			await replyText(channel, message, `⚠️ ${file.filename} could not be sent${error instanceof Error ? `: ${error.message}` : '.'}`);
		}
	}
}

/**
 * Show a catalog result: Markdown, then buttons for its choices and its link,
 * then any files. `ranAt` is where the action ran — the target its choices
 * act on unless the result moved the conversation.
 */
async function showResult(conversation: Conversation, result: ControlResult, ranAt: ControlTarget): Promise<void> {
	const { channel, message, link } = conversation;
	if (result.target) channelLinkQueries.setActive(link.id, result.target.projectId, result.target.sessionId);
	const runs: TextRun[] = markdownToRuns(result.text || ' ');
	const linkButtons = result.link ? [[{ label: result.link.label, url: result.link.url }]] : [];

	if (result.choices?.length) {
		await sendMenu(conversation, runs, { choices: result.choices, target: result.target ?? ranAt }, linkButtons);
	} else {
		await channelRuntime.sendLong(channel.accountId, message.address.conversation_id, runs, { buttons: linkButtons.length ? linkButtons : undefined });
	}
	await sendResultFiles(conversation, result);
	if (result.ask) await sendAsk(conversation, result.ask, result.target ?? ranAt);
	// An action that starts a turn (a skill) names what to send; it goes where
	// the action ran, exactly as if the user had typed it there.
	if (result.prompt) {
		const where = resolveTarget(conversation.user.id, result.target ?? ranAt);
		await sendPrompt(conversation, where, result.prompt, [], { platformMessageId: null });
	}
}

/** Does a skill by this name exist for the chat's active session? */
async function skillNamed(conversation: Conversation, name: string): Promise<boolean> {
	const { project, session } = activeTarget(reload(conversation.link), conversation.user);
	const ctx = createControlContext(conversation.user, { projectId: project.id, sessionId: session?.id ?? null });
	try {
		const { skills } = await ctx.call<{ skills: Array<{ slug: string }> }>('skills:available', { profileId: session?.profile_id ?? null, projectId: project.id });
		return skills.some((skill) => skill.slug === normaliseSkillName(name));
	} catch {
		return false;
	}
}

/**
 * Run a catalog action for this chat: access, arguments, a confirmation when
 * the action asks for one, then the action and its result. `at` pins the
 * target (a menu's own); without it the action runs on the active one.
 */
async function runAction(conversation: Conversation, actionId: string, rawArgs: Record<string, unknown>, at?: ControlTarget): Promise<void> {
	const { user } = conversation;
	const action = getControlAction(actionId);
	if (!action) {
		await replyText(conversation.channel, conversation.message, REPLIES.staleAction);
		return;
	}
	if (!canRun(action, user)) {
		await replyText(conversation.channel, conversation.message, REPLIES.adminOnly);
		return;
	}
	const target = at ?? activeControlTarget(conversation);
	const ctx = createControlContext(user, target);
	const args = checkArgs(action, rawArgs);
	const question = await confirmationFor(action, ctx, args);
	if (question) {
		await sendConfirmation(conversation, { kind: 'action', actionId, args, target }, { title: `⚠️ ${action.title}?`, detail: question, confirmLabel: action.title }, {});
		return;
	}
	await runConfirmed(conversation, actionId, args, target);
}

async function runConfirmed(conversation: Conversation, actionId: string, args: Record<string, unknown>, target: ControlTarget): Promise<void> {
	// This chat says "Stopped" itself; the turn ending must not say it twice.
	if (actionId === 'sessions.stop' && target.sessionId) {
		const found = accessibleSession(conversation.user.id, target.sessionId);
		if (found && isSessionBusy(found.session)) markStoppedByChat(found.session.id);
	}
	const ctx = createControlContext(conversation.user, target);
	await showResult(conversation, await runControlAction(ctx, actionId, args), target);
}

// ── The chat's own commands ─────────────────────────────────────────────────

/** A tap on one of the chat's own menus: act, and redraw the menu in place. */
async function handleChatChoice(conversation: Conversation, row: ChannelMessageRow, choice: ControlChoice): Promise<void> {
	const { link, user } = conversation;
	if ((choice.action === 'chat.approve' || choice.action === 'chat.reject') && typeof choice.args?.linkId === 'string') {
		if (user.role !== 'admin') {
			await replyText(conversation.channel, conversation.message, REPLIES.adminOnly);
			return;
		}
		const pending = channelLinkQueries.getById(choice.args.linkId);
		const owner = pending ? getUserById(pending.user_id) : null;
		const done = choice.action === 'chat.approve' ? await approveLink(choice.args.linkId) : await rejectLink(choice.args.linkId);
		channelMessageQueries.settle(row.id, 'closed');
		const note = !done
			? 'Already handled.'
			: choice.action === 'chat.approve'
				? `✅ Approved${owner ? ` ${owner.name}` : ''}.`
				: `✕ Rejected${owner ? ` ${owner.name}` : ''}.`;
		await channelRuntime.edit(link.account_id, link.conversation_id, row.platform_message_id, textCard(note));
		return;
	}
	await replyText(conversation.channel, conversation.message, REPLIES.staleAction);
}

/** Every command this chat answers to: its own, pairing's, and the catalog's. */
export function isKnownCommand(name: string): boolean {
	return name === 'start' || name === 'unlink' || CHAT_COMMANDS.some((entry) => entry.command === name) || controlActionForCommand(name) !== null;
}

/** A `/command` that is not pairing: one of the chat's own, or a catalog action. */
export async function handleControlCommand(conversation: Conversation, name: string, argument: string, rawText: string): Promise<void> {
	if (name === 'help') {
		await channelRuntime.sendLong(conversation.channel.accountId, conversation.message.address.conversation_id, markdownToRuns(`${REPLIES.helpIntro}\n\n${controlHelp(conversation.user, CHAT_COMMANDS)}`));
		return;
	}
	if (!(await requireControl(conversation))) return;
	if (name === 'retry') {
		await retryLast(conversation);
		return;
	}
	if (name === 'undo') {
		await undoLast(conversation);
		return;
	}
	const action = controlActionForCommand(name);
	if (!action) {
		// Skills are not bot commands; say how to run the one that was meant.
		if (await skillNamed(conversation, name)) {
			await replyText(conversation.channel, conversation.message, REPLIES.skillNotACommand(name));
			return;
		}
		// "/tmp/build.log is empty, why?" is a message, not a typo'd command: let the user say which.
		await sendConfirmation(
			conversation,
			{ kind: 'send', text: rawText },
			{ title: REPLIES.unknownCommand(name), detail: REPLIES.sendAsMessage, confirmLabel: 'Send as message' },
			{}
		);
		return;
	}
	await runAction(conversation, action.id, parseCommandArgument(action, argument));
}

/** A tap on a menu or a confirmation. */
export async function handleControlButton(conversation: Conversation, row: ChannelMessageRow, action: ButtonAction): Promise<void> {
	const { channel, message, link } = conversation;

	if (row.kind === 'menu' && action.type === 'option') {
		const payload = parsePayload<MenuPayload>(row);
		const choice = payload.choices?.[action.index];
		if (!choice) {
			await replyText(channel, message, REPLIES.staleAction);
			return;
		}
		if (choice.action.startsWith(CHAT_ACTION_PREFIX)) {
			await handleChatChoice(conversation, row, choice);
			return;
		}
		if (!(await requireControl(conversation))) return;
		await runAction(conversation, choice.action, choice.args ?? {}, payload.target);
		return;
	}

	if (row.kind === 'confirm' && (action.type === 'confirm' || action.type === 'cancel')) {
		if (!(await requireControl(conversation))) return;
		if (!channelMessageQueries.settle(row.id, action.type === 'confirm' ? 'answered' : 'closed')) {
			await replyText(channel, message, REPLIES.staleAction);
			return;
		}
		if (action.type === 'cancel') {
			takeAttachments(row.id);
			await channelRuntime.edit(link.account_id, link.conversation_id, row.platform_message_id, textCard(REPLIES.cancelled));
			return;
		}
		const payload = parsePayload<ConfirmPayload>(row);
		if (payload.kind === 'action') {
			await channelRuntime.edit(link.account_id, link.conversation_id, row.platform_message_id, textCard('✅ Confirmed.'));
			await runConfirmed(conversation, payload.actionId, payload.args, payload.target ?? activeControlTarget(conversation));
			return;
		}
		if (payload.kind === 'send') {
			await channelRuntime.edit(link.account_id, link.conversation_id, row.platform_message_id, textCard('📨 Sent as a message.'));
			const target = activeTarget(reload(link), conversation.user);
			await sendPrompt(conversation, target, payload.text, takeAttachments(row.id), { platformMessageId: null });
			return;
		}
		await performRewind(conversation, row, payload);
	}
}
