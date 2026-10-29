/**
 * Settling the user messages the composer shows before the server confirmed
 * them (optimistic bubbles) against what the server actually saved.
 *
 * The server saves a sent message under its bubble's own id, so a bubble is
 * settled by asking which of those ids exist: a saved one replaces its bubble,
 * a missing one is given up on only once nothing of the send can still be on
 * its way — and then its content goes back to the composer, never lost.
 */

import type { UnifiedMessage } from '$shared/types/unified';
import type { FrontendMessage, OptimisticUserMessage } from '$frontend/stores/core/sessions.svelte';

/** A message's content as the composer takes it back. */
export interface ComposerContent {
	text: string;
	attachments: { fileName: string; mediaType: string; data: string }[];
}

/**
 * Shown before the server confirmed it saved the message. Nothing may act on
 * it by id yet (edit, undo): the server may not have it, and may never.
 */
export function isUnconfirmedMessage(message: FrontendMessage): message is OptimisticUserMessage {
	return 'optimistic' in message && message.optimistic === true;
}

/**
 * Settle the unconfirmed bubbles in `messages` whose ids were `asked` about,
 * in place (the array is the live transcript, which renders per item). A
 * bubble whose id is in `saved` becomes that message — or is dropped when its
 * echo already sits elsewhere in the transcript, so the message is never shown
 * twice. A bubble missing from `saved` is removed only when `settled`; the
 * removed ones are returned. Bubbles nobody asked about (sent meanwhile) are
 * left alone: their absence from `saved` says nothing.
 */
export function settleUnconfirmedBubbles(
	messages: FrontendMessage[],
	asked: ReadonlySet<string>,
	saved: ReadonlyMap<string, UnifiedMessage>,
	settled: boolean
): OptimisticUserMessage[] {
	const lost: OptimisticUserMessage[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const bubble = messages[index];
		if (!isUnconfirmedMessage(bubble) || !asked.has(bubble.optimisticId)) continue;

		const message = saved.get(bubble.optimisticId);
		if (message) {
			const echoed = messages.some(
				(m, i) => i !== index && !isUnconfirmedMessage(m) && 'messageId' in m && m.messageId === message.messageId
			);
			if (echoed) messages.splice(index, 1);
			else messages[index] = message;
		} else if (settled) {
			messages.splice(index, 1);
			lost.unshift(bubble);
		}
	}
	return lost;
}

/** What of a bubble goes back into the composer: its text and attachments. */
export function bubbleToComposer(bubble: OptimisticUserMessage): ComposerContent {
	const text: string[] = [];
	const attachments: ComposerContent['attachments'] = [];
	for (const block of bubble.content as unknown[]) {
		if (!block || typeof block !== 'object') continue;
		const item = block as { type?: unknown; text?: unknown; data?: unknown; mediaType?: unknown; title?: unknown };
		if (item.type === 'text' && typeof item.text === 'string') {
			if (item.text) text.push(item.text);
		} else if ((item.type === 'image' || item.type === 'document') && typeof item.data === 'string' && item.data) {
			const mediaType =
				typeof item.mediaType === 'string' && item.mediaType
					? item.mediaType
					: item.type === 'image' ? 'image/png' : 'application/pdf';
			const fileName =
				typeof item.title === 'string' && item.title
					? item.title
					: `${item.type}-${attachments.length + 1}.${mediaType.split('/')[1] || 'bin'}`;
			attachments.push({ fileName, mediaType, data: item.data });
		}
	}
	return { text: text.join('\n\n'), attachments };
}
