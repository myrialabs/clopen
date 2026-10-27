/**
 * Answering an AskUserQuestion from a chat.
 *
 * Each question of a tool use is its own message, laid out like the web form:
 * options as buttons (checkboxes when several apply) and "Other…" to type an
 * answer. A tap, Submit, a typed answer or a reply to the message answers one, and once every question of the tool
 * use has its answer they go to the engine together — through the same
 * `resolveUserAnswer` the web form calls, in the same shape, so the engine
 * cannot tell which side answered.
 */

import type { UniversalMessage } from '@myrialabs/chatkit';
import { channelMessageQueries, type ChannelMessageRow, type ChannelLinkRow } from '$backend/database/queries';
import { streamManager } from '$backend/chat/stream-manager';
import { channelRuntime, type ActiveChannel } from './runtime';
import { parsePayload } from './outbound';
import { clearAwaiting, isAwaiting, setAwaiting } from './awaiting';
import { REPLIES, answerFromSelection, questionAnsweredCard, questionCard, textCard, type ButtonAction, type QuestionPayload } from './messages';

export async function replyText(channel: ActiveChannel, message: UniversalMessage, text: string): Promise<void> {
	const replyTo = message.content.type !== 'postback' ? message.platform_message_id ?? null : null;
	await channelRuntime.send(channel.accountId, message.address.conversation_id, textCard(text), replyTo).catch(() => {});
}

/** A tap on a question's button. */
export async function handleQuestionButton(
	channel: ActiveChannel,
	message: UniversalMessage,
	link: ChannelLinkRow,
	row: ChannelMessageRow,
	action: ButtonAction
): Promise<void> {
	if (row.state !== 'open') {
		await replyText(channel, message, REPLIES.staleQuestion);
		return;
	}
	const payload = parsePayload<QuestionPayload>(row);

	const redraw = (typing = false) =>
		channelRuntime.edit(link.account_id, link.conversation_id, row.platform_message_id, questionCard(row.id, payload, { typing }));

	if (action.type === 'option' && payload.question.multiSelect) {
		if (action.index < 0 || action.index >= payload.question.options.length) return;
		const selected = new Set(payload.selected ?? []);
		if (selected.has(action.index)) selected.delete(action.index);
		else selected.add(action.index);
		payload.selected = [...selected].sort((a, b) => a - b);
		channelMessageQueries.setPayload(row.id, payload);
		await redraw(isAwaiting(link.id, row.id));
		return;
	}

	if (action.type === 'other') {
		// A ticked "Other" on a multi-select is unticked like any checkbox.
		if (payload.question.multiSelect && payload.custom) {
			payload.custom = undefined;
			channelMessageQueries.setPayload(row.id, payload);
			await redraw();
			return;
		}
		setAwaiting(link.id, { kind: 'question', rowId: row.id });
		await redraw(true);
		return;
	}

	if (action.type === 'option') await answerQuestion(channel, message, link, row, payload, [action.index]);
	else if (action.type === 'submit') await answerQuestion(channel, message, link, row, payload, payload.selected ?? [], payload.custom);
}

/**
 * A typed answer: after "Other…", as a reply to the question, or the one
 * question waiting. On a single-choice question it is the answer. On a
 * multi-select one it becomes the ticked "Other" next to the ticked options,
 * sent with Submit, as in the web form.
 */
export async function answerQuestionWithText(
	channel: ActiveChannel,
	message: UniversalMessage,
	link: ChannelLinkRow,
	row: ChannelMessageRow,
	text: string
): Promise<void> {
	if (row.state !== 'open') {
		await replyText(channel, message, REPLIES.staleQuestion);
		return;
	}
	clearAwaiting(link.id);
	const payload = parsePayload<QuestionPayload>(row);
	if (payload.question.multiSelect) {
		payload.custom = text.trim();
		channelMessageQueries.setPayload(row.id, payload);
		await channelRuntime.edit(link.account_id, link.conversation_id, row.platform_message_id, questionCard(row.id, payload));
		await replyText(channel, message, REPLIES.otherAdded);
		return;
	}
	await answerQuestion(channel, message, link, row, payload, [], text);
}

async function answerQuestion(
	channel: ActiveChannel,
	message: UniversalMessage,
	link: ChannelLinkRow,
	row: ChannelMessageRow,
	payload: QuestionPayload,
	selection: number[],
	custom?: string
): Promise<void> {
	const answer = answerFromSelection(payload.question, selection, custom);
	// Settle first: a tap and a web-UI answer racing for one question must not
	// both reach the engine. Whoever settles it wins; the other stands down.
	if (!channelMessageQueries.settle(row.id, 'answered')) {
		await replyText(channel, message, REPLIES.staleQuestion);
		return;
	}
	if (isAwaiting(link.id, row.id)) clearAwaiting(link.id);
	payload.answer = answer;
	payload.selected = selection;
	channelMessageQueries.setPayload(row.id, payload);

	const siblings = channelMessageQueries.forToolUse(row.tool_use_id ?? '').filter((sibling) => sibling.link_id === link.id);
	const pending = siblings.filter((sibling) => sibling.id !== row.id && sibling.state === 'open').length;
	await channelRuntime.edit(link.account_id, link.conversation_id, row.platform_message_id, questionAnsweredCard(payload, answer, pending));
	if (pending > 0 || !row.tool_use_id || !row.chat_session_id) return;

	const answers: Record<string, string> = {};
	for (const sibling of siblings) {
		const siblingPayload = sibling.id === row.id ? payload : parsePayload<QuestionPayload>(sibling);
		answers[siblingPayload.question.question] = siblingPayload.answer ?? '';
	}

	const handled = streamManager.resolveUserAnswer(row.chat_session_id, row.project_id ?? undefined, row.tool_use_id, answers);
	if (!handled) await replyText(channel, message, REPLIES.answerFailed);
}
