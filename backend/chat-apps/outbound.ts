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
import { isHomeProject, HOME_PROJECT_NAME } from '$shared/utils/home-project';
import { debug } from '$shared/utils/logger';
import { channelRuntime } from './runtime';
import { lastTurnAnswer } from '$backend/chat/turn-answer';
import { endLiveTurn, liveTurn, takeStoppedByChat } from './turns';
import { answerImages } from './media';
import { resolveSessionPath } from '$backend/worktrees';
import {
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
		projectName: project ? (isHomeProject(project) ? HOME_PROJECT_NAME : project.name) : undefined,
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
	input: { status: 'completed' | 'error' | 'cancelled'; projectId: string; chatSessionId: string; replyTo: string | null; reason?: string }
): Promise<void> {
	const { status, projectId, chatSessionId } = input;
	const context = resolveContext(projectId, chatSessionId);
	// Inside the conversation the chat is already in, a header on every reply is
	// noise; it is shown only when the answer is about some other session.
	const showHeader = link.active_session_id !== chatSessionId;
	const answer = lastTurnAnswer(chatSessionId);

	// Pictures the answer shows go out after its text, and their paths leave it.
	const project = projectQueries.getById(projectId);
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
		runs = answerRuns({ markdown, context, showHeader });
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
	if (reason === 'session-deleted' || !origin) return;
	const link = channelLinkQueries.getById(origin.linkId);
	if (link && channelLinkQueries.isActive(link) && channelRuntime.get(link.account_id)) {
		await deliverAnswer(link, { status, projectId, chatSessionId, replyTo: origin.platformMessageId, reason });
	}
}

/** A deleted session leaves nothing to reply to, and nothing to continue. */
export function forgetSession(chatSessionId: string): void {
	endLiveTurn(chatSessionId);
	channelMessageQueries.deleteForSession(chatSessionId);
	channelLinkQueries.clearActiveSession(chatSessionId);
}
