/**
 * Slimming keeps every message and its words, and cuts only what is heavy.
 */

import { describe, expect, it } from 'bun:test';
import type { UnifiedMessage } from '$shared/types/unified';
import { SLIM_KEEP_CHARS, slimMessage } from './chats';

const base = {
	createdAt: '',
	messageId: 'm',
	sessionId: 's',
	parent: { messageId: null, sessionId: null, toolUseId: null },
	engine: { type: 'claude-code', provider: '', model: { id: '', name: '' }, account: { id: 0, name: '' } }
};

const long = 'x'.repeat(20_000);

describe('slimMessage', () => {
	it('leaves a message with nothing heavy untouched', () => {
		const message = { ...base, type: 'user', synthetic: false, content: [{ type: 'text', text: long }] } as unknown as UnifiedMessage;
		expect(slimMessage(message)).toBeNull();
	});

	it('cuts long tool results to their head and says how much went', () => {
		const message = {
			...base, type: 'user', synthetic: false,
			content: [{ type: 'tool_result', toolUseId: 't', content: long, isError: false }, { type: 'text', text: 'keep me' }]
		} as unknown as UnifiedMessage;
		const slim = slimMessage(message) as Extract<UnifiedMessage, { type: 'user' }>;
		const result = slim.content[0] as { content: string };
		expect(result.content.startsWith('x'.repeat(SLIM_KEEP_CHARS))).toBe(true);
		expect(result.content).toContain('removed by Storage cleanup');
		expect(result.content.length).toBeLessThan(SLIM_KEEP_CHARS + 100);
		expect(slim.content[1]).toEqual({ type: 'text', text: 'keep me' });
	});

	it('turns attachments into a note naming them', () => {
		const message = {
			...base, type: 'user', synthetic: false,
			content: [{ type: 'image', mediaType: 'image/png', data: long, title: 'shot.png' }]
		} as unknown as UnifiedMessage;
		const slim = slimMessage(message) as Extract<UnifiedMessage, { type: 'user' }>;
		expect(slim.content[0]).toEqual({ type: 'text', text: '[Image "shot.png" removed by Storage cleanup]' });
	});

	it('cuts long strings inside a tool input and keeps its shape', () => {
		const message = {
			...base, type: 'assistant', stopReason: null, usage: null,
			content: [{ type: 'tool_use', id: 't', name: 'Write', input: { file_path: '/a.ts', content: long } }]
		} as unknown as UnifiedMessage;
		const slim = slimMessage(message) as Extract<UnifiedMessage, { type: 'assistant' }>;
		const input = (slim.content[0] as unknown as { input: { file_path: string; content: string } }).input;
		expect(input.file_path).toBe('/a.ts');
		expect(input.content.length).toBeLessThan(SLIM_KEEP_CHARS + 100);
	});
});
