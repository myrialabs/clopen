/**
 * Replays of real event orders against the streaming placeholders. The Claude
 * order below was recorded from the SDK: the saved assistant message arrives
 * BEFORE `content_block_stop` / `message_stop`, and the server re-sends the
 * last message once its stop reason is known. That combination used to leave
 * the final reply on screen twice until a refresh.
 */

import { describe, it, expect } from 'bun:test';
import type { UnifiedMessage } from '$shared/types/unified';
import type { FrontendMessage } from '$frontend/stores/core/sessions.svelte';
import { applyPartial, applySnapshot, placeSavedMessage, type SettledMap } from './stream-placeholders';

const P = 'proc-1';

function assistant(messageId: string, text: string, extra: Record<string, unknown> = {}): UnifiedMessage {
	return {
		type: 'assistant',
		messageId,
		createdAt: '',
		sessionId: 's',
		parent: { messageId: null, sessionId: null, toolUseId: null },
		engine: {},
		content: [{ type: 'text', text }],
		stopReason: null,
		usage: null,
		...extra
	} as unknown as UnifiedMessage;
}

function reasoning(messageId: string, text: string): UnifiedMessage {
	return {
		type: 'reasoning',
		messageId,
		createdAt: '',
		sessionId: 's',
		parent: { messageId: null, sessionId: null, toolUseId: null },
		engine: {},
		text
	} as unknown as UnifiedMessage;
}

const start = (block: number, reasoningBlock = false) => ({ processId: P, eventType: 'start' as const, block, offset: 0, deltaText: '', ...(reasoningBlock && { reasoning: true }) });
const update = (block: number, offset: number, deltaText: string, reasoningBlock = false) => ({ processId: P, eventType: 'update' as const, block, offset, deltaText, ...(reasoningBlock && { reasoning: true }) });
const end = (block: number, partialText: string, reasoningBlock = false) => ({ processId: P, eventType: 'end' as const, block, partialText, deltaText: '', ...(reasoningBlock && { reasoning: true }) });

/** Apply a saved message the way chat.service does: place it, else append. */
function save(messages: FrontendMessage[], settled: SettledMap, message: UnifiedMessage) {
	if (placeSavedMessage(messages, settled, message) === 'none') messages.push(message as FrontendMessage);
}

const kinds = (messages: FrontendMessage[]) => messages.map((m) => (m.type === 'stream_event' ? `stream:${(m as { text: string }).text}` : `${m.type}:${(m as { messageId: string }).messageId}`));

describe('final reply of a Claude turn', () => {
	it('shows once, whatever arrives after the saved message', () => {
		const messages: FrontendMessage[] = [];
		const settled: SettledMap = new Map();

		applyPartial(messages, settled, start(1)); // message_start
		applyPartial(messages, settled, start(1, true)); // thinking block
		applyPartial(messages, settled, update(1, 0, 'Let me think', true));
		save(messages, settled, reasoning('r1', 'Let me think'));
		applyPartial(messages, settled, end(1, '')); // old server: thinking stop sent as a TEXT end
		applyPartial(messages, settled, start(2)); // text block
		applyPartial(messages, settled, update(2, 0, 'Xcode is '));
		applyPartial(messages, settled, update(2, 9, 'open.'));
		save(messages, settled, assistant('m1', 'Xcode is open.')); // arrives before the block stops
		applyPartial(messages, settled, end(2, '')); // content_block_stop
		applyPartial(messages, settled, end(2, '')); // message_stop
		save(messages, settled, assistant('m1', 'Xcode is open.', { stopReason: 'end_turn' })); // stop-reason re-send

		expect(kinds(messages)).toEqual(['reasoning:r1', 'assistant:m1']);
		expect((messages[1] as { stopReason: string }).stopReason).toBe('end_turn');
	});

	it('does not bring the reply back from a late end carrying its full text', () => {
		const messages: FrontendMessage[] = [];
		const settled: SettledMap = new Map();
		applyPartial(messages, settled, start(1));
		applyPartial(messages, settled, update(1, 0, 'done'));
		save(messages, settled, assistant('m1', 'done'));
		applyPartial(messages, settled, end(1, 'done'));
		expect(kinds(messages)).toEqual(['assistant:m1']);
	});

	it('keeps streaming the next block after a tool call settled the previous one', () => {
		const messages: FrontendMessage[] = [];
		const settled: SettledMap = new Map();
		applyPartial(messages, settled, start(1));
		save(messages, settled, assistant('tool-call', '')); // a tool_use message claims the empty placeholder
		applyPartial(messages, settled, end(1, ''));
		messages.push({ type: 'user', messageId: 'tool-result' } as unknown as FrontendMessage);
		applyPartial(messages, settled, start(2));
		applyPartial(messages, settled, update(2, 0, 'Next answer'));
		expect(kinds(messages)).toEqual(['assistant:tool-call', 'user:tool-result', 'stream:Next answer']);
		save(messages, settled, assistant('m2', 'Next answer'));
		expect(kinds(messages)).toEqual(['assistant:tool-call', 'user:tool-result', 'assistant:m2']);
	});
});

describe('catch-up snapshots', () => {
	it('never recreate a placeholder for a block a saved message settled', () => {
		const messages: FrontendMessage[] = [];
		const settled: SettledMap = new Map();
		applyPartial(messages, settled, start(1));
		applyPartial(messages, settled, update(1, 0, 'answer'));
		save(messages, settled, assistant('m1', 'answer'));
		// A snapshot taken before the message went out, answered after it.
		applySnapshot(messages, settled, { processId: P, currentPartialText: 'answer', partialBlock: 1 });
		expect(kinds(messages)).toEqual(['assistant:m1']);
	});

	it('a stale snapshot only extends a placeholder that still exists', () => {
		const settled: SettledMap = new Map();
		const empty: FrontendMessage[] = [];
		applySnapshot(empty, settled, { processId: P, currentPartialText: 'partial', partialBlock: 3 }, true);
		expect(empty).toHaveLength(0);

		const live: FrontendMessage[] = [];
		applyPartial(live, settled, start(3));
		applyPartial(live, settled, update(3, 0, 'par'));
		applySnapshot(live, settled, { processId: P, currentPartialText: 'partial', partialBlock: 3 }, true);
		expect(kinds(live)).toEqual(['stream:partial']);
	});

	it('a fresh snapshot lets a late joiner see the text being written', () => {
		const messages: FrontendMessage[] = [{ type: 'assistant', messageId: 'older' } as unknown as FrontendMessage];
		applySnapshot(messages, new Map(), { processId: P, currentPartialText: 'writing…', partialBlock: 4 });
		expect(kinds(messages)).toEqual(['assistant:older', 'stream:writing…']);
	});
});

describe('placement rules', () => {
	it('a sub-agent message never claims the root placeholder', () => {
		const messages: FrontendMessage[] = [];
		const settled: SettledMap = new Map();
		applyPartial(messages, settled, start(1));
		applyPartial(messages, settled, update(1, 0, 'root text'));
		const child = assistant('child', 'from a sub-agent', { parent: { messageId: null, sessionId: null, toolUseId: 'toolu_1' } });
		save(messages, settled, child);
		expect(kinds(messages)).toEqual(['stream:root text', 'assistant:child']);
	});

	it('a delta past the end of the held text is reported as a gap', () => {
		const messages: FrontendMessage[] = [];
		const settled: SettledMap = new Map();
		applyPartial(messages, settled, start(1));
		applyPartial(messages, settled, update(1, 0, 'abc'));
		expect(applyPartial(messages, settled, update(1, 10, 'xyz'))).toBe('gap');
		expect(kinds(messages)).toEqual(['stream:abc']);
	});

	it('an end never creates a placeholder', () => {
		const messages: FrontendMessage[] = [];
		applyPartial(messages, new Map(), end(7, 'orphan text'));
		expect(messages).toHaveLength(0);
	});
});
