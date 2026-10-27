/**
 * Turns a chat started — the live half of a conversation in a chat app.
 *
 * When a message from a chat becomes a turn, three things must follow it that
 * a turn started in the web UI does not need:
 *
 *   - its Clopen user message must be mapped back to the chat message that
 *     sent it, so editing that message later can act like Edit Message;
 *   - the chat must see that something is happening: "typing…" for as long as
 *     the turn runs, and once it has taken a while, one progress line —
 *     edited in place, at most every 10 seconds — naming what it is doing;
 *   - when it ends, the answer goes back to THAT chat as a reply: it asked.
 *
 * A turn may wait in the composer queue behind another, so a prompt is first
 * EXPECTED and only becomes live when its user message is actually saved —
 * matched by the prompt's own message id, so a message typed in the web UI in
 * between is never mistaken for it, and a photo with no caption is matched as
 * surely as text. In memory: a restart drops the mapping for turns in flight,
 * and their end is then announced like any other run.
 */

import { channelMessageQueries } from '$backend/database/queries';
import { debug } from '$shared/utils/logger';
import { channelRuntime } from './runtime';
import { progressCard } from './messages';

export interface ExpectedPrompt {
	linkId: string;
	accountId: string;
	conversationId: string;
	projectId: string;
	/** The chat message that sent it — null for /retry, which has no new message. */
	platformMessageId: string | null;
	/** The prompt's message id — what its saved user message carries. */
	promptMessageId: string;
	/** Its place in the composer queue, while it waits there. */
	queueId?: string;
}

export interface LiveTurn extends ExpectedPrompt {
	startedAt: number;
	steps: number;
	activity: string | null;
	progressMessageId: string | null;
	lastProgressAt: number;
	timer: ReturnType<typeof setInterval>;
}

/** Typing lasts about 5 seconds on Telegram; refresh a little sooner. */
const TICK_MS = 4500;
/** A turn this short needs no progress line — the answer is the progress. */
const PROGRESS_AFTER_MS = 15_000;
/** The progress line is edited at most this often, to stay inside rate limits. */
const PROGRESS_EVERY_MS = 10_000;
/** An expected prompt that never started (a queue that was cleared) is forgotten. */
const EXPECT_TTL_MS = 6 * 60 * 60 * 1000;

const expected = new Map<string, Array<ExpectedPrompt & { at: number }>>();
const live = new Map<string, LiveTurn>();

/** Sessions whose running turn this chat asked to stop — its "Stopped" was already said. */
const stopped = new Set<string>();

/** A prompt from a chat is about to run (or queue) in `chatSessionId`. */
export function expectTurn(chatSessionId: string, prompt: ExpectedPrompt): void {
	const now = Date.now();
	const list = (expected.get(chatSessionId) ?? []).filter((entry) => now - entry.at < EXPECT_TTL_MS);
	list.push({ ...prompt, at: now });
	expected.set(chatSessionId, list);
}

/** Forget an expectation that will not run (submitting it failed). */
export function forgetExpectedTurn(chatSessionId: string, promptMessageId: string): void {
	const list = expected.get(chatSessionId);
	if (!list) return;
	const index = list.findIndex((entry) => entry.promptMessageId === promptMessageId);
	if (index !== -1) list.splice(index, 1);
	if (list.length === 0) expected.delete(chatSessionId);
}

/** Remember where an expected prompt sits in the queue, so editing it can change it there. */
export function setExpectedQueueId(chatSessionId: string, promptMessageId: string, queueId: string): void {
	const entry = expected.get(chatSessionId)?.find((item) => item.promptMessageId === promptMessageId);
	if (entry) entry.queueId = queueId;
}

/** A prompt this chat sent that is still waiting in the queue, by the chat message that sent it. */
export function queuedPromptFor(linkId: string, platformMessageId: string): { chatSessionId: string; prompt: ExpectedPrompt } | null {
	for (const [chatSessionId, list] of expected) {
		const prompt = list.find((entry) => entry.linkId === linkId && entry.platformMessageId === platformMessageId && entry.queueId);
		if (prompt) return { chatSessionId, prompt };
	}
	return null;
}

/**
 * A user message was saved. If a chat expected it, map it and start the
 * turn's live feedback. Returns the turn, or null for a message typed in Clopen.
 */
export function onUserMessage(chatSessionId: string, clopenMessageId: string, promptMessageId: string): LiveTurn | null {
	const list = expected.get(chatSessionId);
	if (!list?.length) return null;
	const index = list.findIndex((entry) => entry.promptMessageId === promptMessageId);
	if (index === -1) return null;
	const [prompt] = list.splice(index, 1);
	if (list.length === 0) expected.delete(chatSessionId);

	if (prompt.platformMessageId) {
		try {
			channelMessageQueries.create({
				linkId: prompt.linkId,
				kind: 'user',
				projectId: prompt.projectId,
				chatSessionId,
				clopenMessageId,
				platformMessageId: prompt.platformMessageId,
				state: 'closed'
			});
		} catch (error) {
			debug.warn('chat-apps', 'Mapping a chat message to its Clopen message failed:', error);
		}
	}

	endLiveTurn(chatSessionId);
	const turn: LiveTurn = {
		...prompt,
		startedAt: Date.now(),
		steps: 0,
		activity: null,
		progressMessageId: null,
		lastProgressAt: 0,
		timer: setInterval(() => void tick(chatSessionId), TICK_MS)
	};
	turn.timer.unref?.();
	live.set(chatSessionId, turn);
	void channelRuntime.setTyping(turn.accountId, turn.conversationId).catch(() => {});
	return turn;
}

/** The turn is calling a tool — what the progress line names. */
export function onToolActivity(chatSessionId: string, activity: string): void {
	const turn = live.get(chatSessionId);
	if (!turn) return;
	turn.steps += 1;
	turn.activity = activity;
}

async function tick(chatSessionId: string): Promise<void> {
	const turn = live.get(chatSessionId);
	if (!turn) return;
	// Waiting on the user's answer is not "typing…": the bot is not busy, the user is.
	if (channelMessageQueries.openQuestionsForSession(chatSessionId).length > 0) return;
	await channelRuntime.setTyping(turn.accountId, turn.conversationId).catch(() => {});

	const now = Date.now();
	const elapsed = now - turn.startedAt;
	if (elapsed < PROGRESS_AFTER_MS || now - turn.lastProgressAt < PROGRESS_EVERY_MS) return;
	turn.lastProgressAt = now;
	const card = progressCard({ elapsedMs: elapsed, activity: turn.activity, steps: turn.steps });
	try {
		if (turn.progressMessageId) {
			await channelRuntime.edit(turn.accountId, turn.conversationId, turn.progressMessageId, card);
		} else {
			const sent = await channelRuntime.send(turn.accountId, turn.conversationId, card);
			// The turn may have ended while this was in flight; its line must not linger.
			if (live.get(chatSessionId) !== turn && sent.platform_message_id) {
				await channelRuntime.deleteMessage(turn.accountId, turn.conversationId, sent.platform_message_id);
				return;
			}
			turn.progressMessageId = sent.platform_message_id;
		}
	} catch (error) {
		debug.log('chat-apps', 'Progress update skipped:', error);
	}
}

/** Stop a turn's feedback. Returns it so the caller can deliver its answer. */
export function endLiveTurn(chatSessionId: string): LiveTurn | null {
	const turn = live.get(chatSessionId);
	if (!turn) return null;
	clearInterval(turn.timer);
	live.delete(chatSessionId);
	if (turn.progressMessageId) void channelRuntime.deleteMessage(turn.accountId, turn.conversationId, turn.progressMessageId);
	return turn;
}

export function liveTurn(chatSessionId: string): LiveTurn | null {
	return live.get(chatSessionId) ?? null;
}

/** This chat stopped the session's turn itself and has already said so. */
export function markStoppedByChat(chatSessionId: string): void {
	stopped.add(chatSessionId);
	setTimeout(() => stopped.delete(chatSessionId), 60_000).unref?.();
}

/** Did this chat stop the turn? Asking forgets it. */
export function takeStoppedByChat(chatSessionId: string): boolean {
	return stopped.delete(chatSessionId);
}

/** Tests and shutdown. */
export function resetTurns(): void {
	for (const turn of live.values()) clearInterval(turn.timer);
	live.clear();
	expected.clear();
	stopped.clear();
}
