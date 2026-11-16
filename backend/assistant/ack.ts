/**
 * A quick word first, the result after.
 *
 * When a message to Clopen needs real work (looking things up, a tool, a
 * task), the answer can take a while — and silence reads as "not listening".
 * If the turn has not finished after a few seconds, a fast model writes one
 * short line that fits what was asked ("Oke, kucek harga BTC hari ini dulu")
 * in the owner's language. It is a line of the chat like any other — a
 * timeline row (`ack:<message id>`) that the web shows and the owner's
 * Telegram receives as a reply to the message it answers; the real answer
 * follows as usual. A turn that finishes quickly never gets one, and a
 * message never gets two.
 */

import { streamManager } from '$backend/chat/stream-manager';
import { isAssistantProjectId } from './manager-policy';
import { think } from './think';

/** How long a turn may run before the owner hears a first word. */
const ACK_AFTER_MS = 3500;

const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; cancelled: boolean }>();

function cancel(sessionId: string): void {
	const entry = pending.get(sessionId);
	if (!entry) return;
	entry.cancelled = true;
	clearTimeout(entry.timer);
	pending.delete(sessionId);
}

async function acknowledge(sessionId: string, said: string, messageId: string, entry: { cancelled: boolean }, waiting = false): Promise<void> {
	const { hasLine, sayLine } = await import('./timeline');
	if (hasLine(`ack:${messageId}`)) return;
	const result = await think<{ text: string }>(
		[
			waiting
				? 'The owner just sent the message below to their assistant while it is still busy with their previous message; it takes this one right after. Write the assistant\'s immediate reply: one short, natural line (at most 10 words) in the language of the message, showing it got it — e.g. that it will change what it is doing, or do this next. No promises of time, no questions, no emoji.'
				: 'The owner just sent the message below to their assistant, which is now working on it. Write the assistant\'s first, immediate reply: one short, natural line (at most 12 words) in the language of the message, saying what it is about to do. No promises of time, no questions, no emoji. If the message is small talk that needs no work, return an empty string.',
			`Message: ${said.slice(0, 800)}`
		].join('\n'),
		{ type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] }
	).catch(() => ({ text: '' }));
	const text = result.text.trim();
	if (!text || entry.cancelled) return;
	if (pending.get(sessionId) === entry) pending.delete(sessionId);
	await sayLine({ id: `ack:${messageId}`, sessionId, text, answers: messageId });
}

/**
 * A message that waits behind a busy turn gets its quick word right away —
 * instead of a canned "your message is queued" — and keeps it when the busy
 * turn ends.
 */
export async function ackNow(sessionId: string, said: string, messageId: string): Promise<void> {
	if (!said.trim() || said.startsWith('[Clopen')) return;
	await acknowledge(sessionId, said, messageId, { cancelled: false }, true);
}

export function initAck(): void {
	streamManager.on('stream:message', (payload: { event: { data?: { message?: { type?: string; content?: unknown; parent?: { toolUseId?: string | null } | null }; message_id?: string } }; projectId?: string; chatSessionId: string }) => {
		if (!payload.projectId || !isAssistantProjectId(payload.projectId)) return;
		const message = payload.event.data?.message;
		const messageId = payload.event.data?.message_id;
		if (message?.type !== 'user' || message.parent?.toolUseId || !messageId) return;
		const said = (Array.isArray(message.content) ? message.content : [])
			.filter((block: { type?: string }) => block?.type === 'text')
			.map((block: { text?: string }) => block.text ?? '')
			.join(' ')
			.trim();
		// Clopen's own notes to itself ("[Clopen · connected]") are not the owner talking.
		if (!said || said.startsWith('[Clopen') || said.startsWith('<')) return;
		cancel(payload.chatSessionId);
		const entry = { timer: setTimeout(() => void acknowledge(payload.chatSessionId, said, messageId, entry), ACK_AFTER_MS), cancelled: false };
		entry.timer.unref?.();
		pending.set(payload.chatSessionId, entry);
	});
	streamManager.on('stream:lifecycle', (event: { chatSessionId?: string }) => {
		if (event.chatSessionId) cancel(event.chatSessionId);
	});
}
