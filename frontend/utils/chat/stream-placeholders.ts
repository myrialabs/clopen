/**
 * The live streaming placeholders of a chat transcript, and how stream events
 * and saved messages land on them.
 *
 * A streamed block (one run of text or reasoning) is shown as a `stream_event`
 * placeholder until the saved message carrying the same content replaces it.
 * Events about a block can arrive AFTER that replacement — Claude sends the
 * assistant message before `content_block_stop` and `message_stop`, a catch-up
 * snapshot can be answered after newer events, and the server re-sends a
 * message once its stop reason is known. Anything that recreated or reclaimed a
 * placeholder at that point showed the reply twice until a refresh.
 *
 * So a block is SETTLED once a saved message has replaced its placeholder, and
 * nothing about a settled block (or an older one) may touch the transcript
 * again. A saved message that is already in the transcript is updated in place
 * by id before it may claim any placeholder.
 *
 * Kept free of stores so the exact event order of a real turn can be replayed
 * in tests; `chat.service` owns the state and calls in.
 */

import type { UnifiedMessage } from '$shared/types/unified';
import type { FrontendMessage, StreamingMessage } from '$frontend/stores/core/sessions.svelte';
import { placeDelta } from '$frontend/utils/stream-delta';

/** The newest settled block per kind, per stream process. */
export interface SettledBlocks {
	text?: number;
	reasoning?: number;
}

export type SettledMap = Map<string, SettledBlocks>;

/** Whether `block` of this kind is at or below the newest settled one. */
export function isSettled(settled: SettledMap, processId: string, reasoning: boolean, block: number | undefined): boolean {
	if (block === undefined) return false;
	const newest = settled.get(processId)?.[reasoning ? 'reasoning' : 'text'];
	return newest !== undefined && block <= newest;
}

/** Record that a saved message replaced the placeholder of `block`. */
export function settle(settled: SettledMap, processId: string, reasoning: boolean, block: number | undefined): void {
	if (block === undefined) return;
	const entry = settled.get(processId) ?? {};
	const key = reasoning ? 'reasoning' : 'text';
	if (entry[key] === undefined || block > entry[key]!) entry[key] = block;
	settled.set(processId, entry);
}

function isPlaceholder(message: FrontendMessage): message is StreamingMessage {
	return message.type === 'stream_event';
}

/** The streaming placeholder for one (process, reasoning) pair, if any. */
export function findStreamPlaceholder(messages: FrontendMessage[], processId: string, reasoning: boolean): StreamingMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (isPlaceholder(msg) && msg.processId === processId && !!msg.reasoning === reasoning) return msg;
	}
	return undefined;
}

/**
 * Insert an empty streaming placeholder.
 *
 * A reasoning placeholder goes BEFORE any existing non-reasoning stream_event
 * so the on-screen order stays reasoning → text within a turn. Without this,
 * engines that emit a preliminary non-reasoning stream_start at turn
 * boundaries (e.g. OpenCode) leave a stale empty text placeholder ahead of the
 * reasoning block, which then gets claimed by the next tool message and
 * visually swaps reasoning behind the tool.
 */
export function insertStreamPlaceholder(
	messages: FrontendMessage[],
	processId: string,
	reasoning: boolean,
	block: number | undefined,
	text = '',
	createdAt = new Date().toISOString()
): StreamingMessage {
	const placeholder: StreamingMessage = { type: 'stream_event', processId, text, createdAt, reasoning, block };
	if (reasoning) {
		const textIdx = messages.findIndex((m) => isPlaceholder(m) && !m.reasoning);
		if (textIdx !== -1) {
			messages.splice(textIdx, 0, placeholder);
			return messages[textIdx] as StreamingMessage;
		}
	}
	messages.push(placeholder);
	return messages[messages.length - 1] as StreamingMessage;
}

export interface PartialEvent {
	processId: string;
	eventType: 'start' | 'update' | 'end';
	block?: number;
	offset?: number;
	deltaText?: string;
	partialText?: string;
	reasoning?: boolean;
	timestamp?: string;
}

/**
 * Apply one `chat:partial` event. An `update` carries only its delta and where
 * it starts (`offset`): a delta already covered is ignored, one that overlaps
 * adds only its new tail, and one that starts past the end of what we hold is
 * a gap the caller must repair from the server (returns `'gap'`). `end` carries
 * the full text and only ever corrects a placeholder that still exists.
 */
export function applyPartial(messages: FrontendMessage[], settled: SettledMap, data: PartialEvent): 'ok' | 'gap' {
	const reasoning = data.reasoning === true;
	const block = typeof data.block === 'number' ? data.block : undefined;
	if (isSettled(settled, data.processId, reasoning, block)) return 'ok';

	let placeholder = findStreamPlaceholder(messages, data.processId, reasoning);

	// A newer block replaces the text; a stale block's frames are dropped.
	if (placeholder && block !== undefined && placeholder.block !== undefined && placeholder.block !== block) {
		if (block < placeholder.block) return 'ok';
		placeholder.text = '';
		placeholder.block = block;
	}

	if (data.eventType === 'start') {
		if (placeholder) {
			placeholder.text = '';
			placeholder.block = block;
		} else {
			insertStreamPlaceholder(messages, data.processId, reasoning, block, '', data.timestamp);
		}
		return 'ok';
	}

	if (data.eventType === 'end') {
		if (placeholder && typeof data.partialText === 'string') {
			placeholder.text = data.partialText;
			placeholder.block = block;
		}
		return 'ok';
	}

	if (data.eventType !== 'update') return 'ok';
	if (!placeholder) {
		// Missed the start (or joined mid-block): begin empty and let the offset
		// check below decide whether this delta can be placed.
		placeholder = insertStreamPlaceholder(messages, data.processId, reasoning, block, '', data.timestamp);
	}
	if (placeholder.block === undefined) placeholder.block = block;

	const delta = data.deltaText || '';
	const offset = typeof data.offset === 'number' ? data.offset : placeholder.text.length;
	const placed = placeDelta(placeholder.text, offset, delta);
	if (placed.kind === 'extended') placeholder.text = placed.text;
	return placed.kind === 'gap' ? 'gap' : 'ok';
}

export interface StreamSnapshot {
	processId: string;
	currentPartialText?: string;
	currentReasoningText?: string;
	partialBlock?: number;
	reasoningBlock?: number;
}

/**
 * Bring the placeholders up to a server snapshot (`chat:stream-state`): used to
 * catch up when joining a running stream and to repair a gap. A snapshot only
 * ever moves text forward, never touches a settled block, and never shortens
 * text that live frames have already extended. A snapshot older than events
 * already applied (`stale`) may only extend a placeholder that still exists.
 */
export function applySnapshot(messages: FrontendMessage[], settled: SettledMap, snapshot: StreamSnapshot, stale = false): void {
	const apply = (reasoning: boolean, text: string | undefined, block: number | undefined) => {
		if (!text) return;
		if (isSettled(settled, snapshot.processId, reasoning, block)) return;
		const placeholder = findStreamPlaceholder(messages, snapshot.processId, reasoning);
		if (!placeholder) {
			if (!stale) insertStreamPlaceholder(messages, snapshot.processId, reasoning, block, text);
			return;
		}
		if (block !== undefined && placeholder.block !== undefined && block < placeholder.block) return;
		if (block === placeholder.block && placeholder.text.length > text.length && placeholder.text.startsWith(text)) return;
		if (stale && (block !== placeholder.block || !text.startsWith(placeholder.text))) return;
		placeholder.text = text;
		placeholder.block = block;
	};

	// Reasoning before text, so the display order matches live emission.
	apply(true, snapshot.currentReasoningText, snapshot.reasoningBlock);
	apply(false, snapshot.currentPartialText, snapshot.partialBlock);

	// Nothing streamed yet: an empty text placeholder keeps the loading indicator visible.
	if (!stale && !snapshot.currentPartialText && !snapshot.currentReasoningText) {
		const hasAnyStream = messages.some((m) => isPlaceholder(m) && m.processId === snapshot.processId);
		if (!hasAnyStream) insertStreamPlaceholder(messages, snapshot.processId, false, snapshot.partialBlock);
	}
}

/**
 * Put a saved root assistant or reasoning message into the transcript.
 *
 * Returns `'updated'` when a message with the same id was already there (it is
 * replaced in place — the stop-reason re-send, a duplicate delivery), `'claimed'`
 * when it replaced its streaming placeholder (whose block is then settled), and
 * `'none'` when the caller should append it. Sub-agent messages (with
 * `parent.toolUseId`) never claim a root placeholder; they only dedupe by id.
 */
export function placeSavedMessage(messages: FrontendMessage[], settled: SettledMap, message: UnifiedMessage): 'updated' | 'claimed' | 'inserted' | 'none' {
	const id = (message as { messageId?: string }).messageId;
	if (id) {
		const existing = messages.findIndex(
			(m) => !isPlaceholder(m) && (m as { messageId?: string }).messageId === id && !('optimistic' in m && m.optimistic)
		);
		if (existing !== -1) {
			messages[existing] = message;
			return 'updated';
		}
	}

	const isRoot = !message.parent?.toolUseId;
	if (!isRoot || (message.type !== 'assistant' && message.type !== 'reasoning')) return 'none';

	const reasoning = message.type === 'reasoning';
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (isPlaceholder(msg) && !!msg.reasoning === reasoning) {
			settle(settled, msg.processId, reasoning, msg.block);
			messages[i] = message;
			return 'claimed';
		}
	}

	// A reasoning message with no placeholder of its own still goes before the
	// text being streamed, so the order stays reasoning → text.
	if (reasoning) {
		const textIdx = messages.findIndex((m) => isPlaceholder(m) && !m.reasoning);
		if (textIdx !== -1) {
			messages.splice(textIdx, 0, message);
			return 'inserted';
		}
	}
	return 'none';
}
