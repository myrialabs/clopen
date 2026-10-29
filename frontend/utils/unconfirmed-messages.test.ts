/**
 * Settling optimistic user bubbles against what the server saved, and what of
 * a lost one goes back into the composer.
 */

import { describe, it, expect } from 'bun:test';
import type { UnifiedMessage } from '$shared/types/unified';
import type { FrontendMessage, OptimisticUserMessage } from '$frontend/stores/core/sessions.svelte';
import { isUnconfirmedMessage, settleUnconfirmedBubbles, bubbleToComposer } from './unconfirmed-messages';

const engine = { type: 'claude-code', provider: '', model: { id: '', name: '' }, account: { id: 0, name: '' } };
const parent = { messageId: null, sessionId: null, toolUseId: null };

function saved(id: string, text = id): UnifiedMessage {
	return { type: 'user', createdAt: '', messageId: id, sessionId: null, parent, engine, content: [{ type: 'text', text }] } as unknown as UnifiedMessage;
}

function assistant(id: string): UnifiedMessage {
	return { type: 'assistant', createdAt: '', messageId: id, sessionId: null, parent, engine, content: [{ type: 'text', text: 'ok' }], stopReason: null, usage: null } as unknown as UnifiedMessage;
}

function bubble(id: string, content: unknown[] = [{ type: 'text', text: id }]): OptimisticUserMessage {
	return { type: 'user', createdAt: '', messageId: id, sessionId: null, parent, engine, content, optimistic: true, optimisticId: id } as unknown as OptimisticUserMessage;
}

const ids = (messages: FrontendMessage[]) =>
	messages.map((m) => `${isUnconfirmedMessage(m) ? '~' : ''}${'messageId' in m ? m.messageId : m.type}`);

const savedMap = (...messages: UnifiedMessage[]) => new Map(messages.map((m) => [m.messageId, m]));

describe('isUnconfirmedMessage', () => {
	it('is only true for a bubble flagged optimistic', () => {
		expect(isUnconfirmedMessage(bubble('a'))).toBe(true);
		expect(isUnconfirmedMessage(saved('a'))).toBe(false);
		expect(isUnconfirmedMessage({ ...saved('a'), optimistic: false } as unknown as FrontendMessage)).toBe(false);
		expect(isUnconfirmedMessage({ ...saved('a'), optimistic: 'true' } as unknown as FrontendMessage)).toBe(false);
		expect(isUnconfirmedMessage({ type: 'stream_event', processId: 'p', text: '', createdAt: '' } as FrontendMessage)).toBe(false);
	});
});

describe('settleUnconfirmedBubbles', () => {
	it('replaces a saved bubble in place, keeping its position', () => {
		const messages: FrontendMessage[] = [saved('1'), bubble('2'), assistant('3')];
		const lost = settleUnconfirmedBubbles(messages, new Set(['2']), savedMap(saved('2', 'from db')), true);
		expect(lost).toEqual([]);
		expect(ids(messages)).toEqual(['1', '2', '3']);
		expect((messages[1] as { content: { text: string }[] }).content[0].text).toBe('from db');
	});

	it('drops the bubble instead when its echo is already in the transcript', () => {
		const messages: FrontendMessage[] = [bubble('2'), saved('2'), assistant('3')];
		settleUnconfirmedBubbles(messages, new Set(['2']), savedMap(saved('2')), false);
		expect(ids(messages)).toEqual(['2', '3']);
	});

	it('keeps a missing bubble while the send is not settled', () => {
		const messages: FrontendMessage[] = [saved('1'), bubble('2')];
		const lost = settleUnconfirmedBubbles(messages, new Set(['2']), new Map(), false);
		expect(lost).toEqual([]);
		expect(ids(messages)).toEqual(['1', '~2']);
	});

	it('removes and returns a missing bubble once settled', () => {
		const lostBubble = bubble('2');
		const messages: FrontendMessage[] = [saved('1'), lostBubble, assistant('3')];
		const lost = settleUnconfirmedBubbles(messages, new Set(['2']), new Map(), true);
		expect(lost).toEqual([lostBubble]);
		expect(ids(messages)).toEqual(['1', '3']);
	});

	it('never touches a bubble nobody asked about, even when settled', () => {
		const messages: FrontendMessage[] = [bubble('old'), bubble('new')];
		const lost = settleUnconfirmedBubbles(messages, new Set(['old']), new Map(), true);
		expect(lost.map((b) => b.optimisticId)).toEqual(['old']);
		expect(ids(messages)).toEqual(['~new']);
	});

	it('settles several at once — saved, echoed and lost — returning the lost oldest first', () => {
		const messages: FrontendMessage[] = [
			bubble('a'), saved('x'), bubble('b'), bubble('c'), saved('c'), bubble('d'), bubble('e')
		];
		const lost = settleUnconfirmedBubbles(messages, new Set(['a', 'b', 'c', 'd', 'e']), savedMap(saved('b'), saved('c')), true);
		expect(lost.map((b) => b.optimisticId)).toEqual(['a', 'd', 'e']);
		expect(ids(messages)).toEqual(['x', 'b', 'c']);
	});

	it('leaves confirmed messages alone even if their ids are asked about', () => {
		const messages: FrontendMessage[] = [saved('1'), assistant('2')];
		const lost = settleUnconfirmedBubbles(messages, new Set(['1', '2']), new Map(), true);
		expect(lost).toEqual([]);
		expect(ids(messages)).toEqual(['1', '2']);
	});

	it('does nothing to an empty transcript', () => {
		const messages: FrontendMessage[] = [];
		expect(settleUnconfirmedBubbles(messages, new Set(['a']), savedMap(saved('a')), true)).toEqual([]);
		expect(messages).toEqual([]);
	});

	it('handles duplicated bubbles of one id without losing or doubling it', () => {
		const messages: FrontendMessage[] = [bubble('a'), bubble('a')];
		settleUnconfirmedBubbles(messages, new Set(['a']), savedMap(saved('a')), true);
		expect(ids(messages)).toEqual(['a']);
	});
});

describe('bubbleToComposer', () => {
	it('joins text blocks with a blank line and keeps attachments in order', () => {
		const content = [
			{ type: 'image', mediaType: 'image/jpeg', data: 'AAA', title: 'photo.jpg' },
			{ type: 'document', mediaType: 'application/pdf', data: 'BBB' },
			{ type: 'text', text: 'first' },
			{ type: 'text', text: 'second' }
		];
		expect(bubbleToComposer(bubble('a', content))).toEqual({
			text: 'first\n\nsecond',
			attachments: [
				{ fileName: 'photo.jpg', mediaType: 'image/jpeg', data: 'AAA' },
				{ fileName: 'document-2.pdf', mediaType: 'application/pdf', data: 'BBB' }
			]
		});
	});

	it('fills in a media type and name when the block has none', () => {
		const { attachments } = bubbleToComposer(bubble('a', [{ type: 'image', data: 'AAA' }, { type: 'document', data: 'BBB', mediaType: '' }]));
		expect(attachments).toEqual([
			{ fileName: 'image-1.png', mediaType: 'image/png', data: 'AAA' },
			{ fileName: 'document-2.pdf', mediaType: 'application/pdf', data: 'BBB' }
		]);
	});

	it('keeps text exactly as written — markdown, code, emoji, other scripts, whitespace', () => {
		const text = '  ```ts\nconst a = 1;\n```\n\n**bold** <script>x</script> 💥 日本語 العربية\t\n';
		expect(bubbleToComposer(bubble('a', [{ type: 'text', text }])).text).toBe(text);
	});

	it('skips what it cannot carry back instead of failing', () => {
		const content = [
			null,
			undefined,
			'text',
			42,
			{},
			{ type: 'text' },
			{ type: 'text', text: 7 },
			{ type: 'text', text: '' },
			{ type: 'image' },
			{ type: 'image', data: '' },
			{ type: 'image', data: 123 },
			{ type: 'tool_result', content: 'x' },
			{ type: 'text', text: 'kept' }
		];
		expect(bubbleToComposer(bubble('a', content))).toEqual({ text: 'kept', attachments: [] });
	});

	it('returns nothing for an empty bubble', () => {
		expect(bubbleToComposer(bubble('a', []))).toEqual({ text: '', attachments: [] });
	});
});
