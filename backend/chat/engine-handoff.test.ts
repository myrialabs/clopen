import { describe, expect, test } from 'bun:test';

import { renderHandoff, withHandoff } from './engine-handoff';
import type {
	AssistantMessage,
	MessageEngine,
	ReasoningMessage,
	UnifiedMessage,
	UserMessage,
} from '$shared/types/unified';

// The handoff is the only thing standing between "switch engine" and "the new
// engine has no idea what we were doing", and it runs invisibly — a user never
// sees the transcript, so a regression here is silent. Each case below is a
// property the design depends on rather than an incidental detail of the
// current wording.

const ALL: { image: boolean; document: boolean } = { image: true, document: true };
const TEXT_ONLY: { image: boolean; document: boolean } = { image: false, document: false };

function engine(type: MessageEngine['type'] = 'claude-code'): MessageEngine {
	return { type, provider: 'anthropic', model: { id: 'm', name: 'M' }, account: { id: 0, name: '' } };
}

function base(id: string) {
	return {
		createdAt: '2026-01-01T00:00:00.000Z',
		messageId: id,
		sessionId: 'sdk-1',
		parent: { messageId: null, sessionId: null, toolUseId: null },
		engine: engine(),
	};
}

function user(id: string, text: string, extra: Partial<UserMessage> = {}): UserMessage {
	return {
		...base(id),
		type: 'user',
		sender: { id: 'u', name: 'U' },
		content: [{ type: 'text', text }],
		synthetic: false,
		...extra,
	};
}

function assistant(id: string, text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		...base(id),
		type: 'assistant',
		content: [{ type: 'text', text }],
		stopReason: null,
		usage: null,
		...extra,
	};
}

function toolCall(id: string, toolUseId: string, name: string, input: unknown): AssistantMessage {
	return {
		...base(id),
		type: 'assistant',
		content: [{
			type: 'tool_use',
			id: toolUseId,
			name,
			input,
			result: null,
			subActivities: [],
			skillPrompt: null,
			interrupted: false,
		} as AssistantMessage['content'][number]],
		stopReason: 'tool_use',
		usage: null,
	};
}

function toolResult(id: string, toolUseId: string, content: string): UserMessage {
	return {
		...base(id),
		type: 'user',
		sender: { id: '', name: '' },
		content: [{ type: 'tool_result', toolUseId, content, isError: false }],
		synthetic: true,
	};
}

/** The single text block of a handoff result. */
function transcriptOf(messages: UnifiedMessage[], support = ALL, previous: MessageEngine['type'] | null = 'claude-code') {
	const result = renderHandoff(messages, support, previous);
	expect(result).not.toBeNull();
	const first = result!.blocks[0];
	expect(first.type).toBe('text');
	return { text: (first as { type: 'text'; text: string }).text, result: result! };
}

describe('renderHandoff', () => {
	test('returns null when there is nothing to replay', () => {
		expect(renderHandoff([], ALL, null)).toBeNull();
	});

	test('replays the conversation in order and names the previous engine', () => {
		const { text } = transcriptOf([
			user('1', 'add a login page'),
			assistant('2', 'done, added Login.svelte'),
		]);

		expect(text).toContain('claude-code');
		expect(text.indexOf('add a login page')).toBeLessThan(text.indexOf('done, added Login.svelte'));
	});

	test('carries tool calls with their inputs and results verbatim under the trigger', () => {
		const { text, result } = transcriptOf([
			user('1', 'what is in config.ts?'),
			toolCall('2', 't1', 'Read', { filePath: '/app/config.ts' }),
			toolResult('3', 't1', 'export const PORT = 3000'),
		]);

		expect(text).toContain('Read');
		expect(text).toContain('/app/config.ts');
		expect(text).toContain('export const PORT = 3000');
		expect(result.stats.clearedToolResults).toBe(0);
	});

	test('keeps reasoning blocks', () => {
		const reasoning: ReasoningMessage = { ...base('2'), type: 'reasoning', text: 'the user wants X' };
		const { text } = transcriptOf([user('1', 'hi'), reasoning]);
		expect(text).toContain('the user wants X');
	});

	// Sub-agent traffic is already summarised by its parent tool result; replaying
	// it would duplicate the same work far more verbosely.
	test('drops sub-agent messages but keeps root-level ones', () => {
		const nested = assistant('2', 'inner sub-agent chatter');
		nested.parent = { messageId: null, sessionId: null, toolUseId: 't1' };

		const { text } = transcriptOf([user('1', 'root question'), nested, assistant('3', 'root answer')]);

		expect(text).toContain('root question');
		expect(text).toContain('root answer');
		expect(text).not.toContain('inner sub-agent chatter');
	});

	// The compaction summary is the previous engine's own compression of
	// everything before it — the single most valuable message to carry over.
	test('keeps the synthetic post-compaction summary', () => {
		const summary = user('2', 'Summary: we refactored the auth module', { synthetic: true });
		const { text } = transcriptOf([user('1', 'start'), summary]);
		expect(text).toContain('we refactored the auth module');
	});

	describe('tool-result clearing past the trigger', () => {
		// >100k estimated tokens means >400k characters at 4 chars/token.
		const HUGE = 'x'.repeat(120_000);

		const longRun: UnifiedMessage[] = [
			user('1', 'go'),
			toolCall('2', 't1', 'Read', { filePath: '/a' }),
			toolResult('3', 't1', `oldest ${HUGE}`),
			toolCall('4', 't2', 'Read', { filePath: '/b' }),
			toolResult('5', 't2', `second ${HUGE}`),
			toolCall('6', 't3', 'Read', { filePath: '/c' }),
			toolResult('7', 't3', `third ${HUGE}`),
			toolCall('8', 't4', 'Read', { filePath: '/d' }),
			toolResult('9', 't4', `fourth ${HUGE}`),
			toolCall('10', 't5', 'Read', { filePath: '/e' }),
			toolResult('11', 't5', `newest ${HUGE}`),
		];

		test('clears the oldest results and keeps the last three', () => {
			const { text, result } = transcriptOf(longRun);

			// 5 tool uses, keep 3 → the 2 oldest results are cleared.
			expect(result.stats.clearedToolResults).toBe(2);
			expect(text).not.toContain('oldest x');
			expect(text).not.toContain('second x');
			expect(text).toContain('third x');
			expect(text).toContain('fourth x');
			expect(text).toContain('newest x');
		});

		test('keeps every tool input even when its result is cleared', () => {
			const { text } = transcriptOf(longRun);
			for (const path of ['/a', '/b', '/c', '/d', '/e']) {
				expect(text).toContain(path);
			}
		});

		test('marks cleared results so the engine knows to re-derive them', () => {
			const { text } = transcriptOf(longRun);
			expect(text).toContain('cleared');
		});
	});

	describe('attachments', () => {
		const withImage = user('1', 'look at this', {
			content: [
				{ type: 'text', text: 'look at this' },
				{ type: 'image', mediaType: 'image/png', data: 'BASE64DATA' },
			],
		});

		test('re-attaches images when the target supports them', () => {
			const result = renderHandoff([withImage], ALL, 'codex')!;
			const image = result.blocks.find(b => b.type === 'image');
			expect(image).toBeDefined();
			expect((image as { data: string }).data).toBe('BASE64DATA');
			expect(result.stats.droppedAttachments).toBe(0);
		});

		test('degrades to a placeholder when the target cannot take them', () => {
			const result = renderHandoff([withImage], TEXT_ONLY, 'codex')!;
			expect(result.blocks.some(b => b.type === 'image')).toBe(false);
			expect(result.stats.droppedAttachments).toBe(1);
			expect((result.blocks[0] as { text: string }).text).toContain('not supported');
		});
	});
});

describe('withHandoff', () => {
	test('prepends the blocks without mutating the original message', () => {
		const prompt = user('1', 'the real question');
		const merged = withHandoff(prompt, [{ type: 'text', text: 'CARRIED CONTEXT' }]);

		// The original is what gets persisted and rendered — it must stay clean.
		expect(prompt.content).toHaveLength(1);
		expect(merged.content).toHaveLength(2);
		expect((merged.content[0] as { text: string }).text).toBe('CARRIED CONTEXT');
		expect((merged.content[1] as { text: string }).text).toBe('the real question');
	});
});
