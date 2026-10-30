import { describe, expect, test } from 'bun:test';
import type { EngineOutput } from '$shared/types/unified';
import { scopeToParentTool } from './parent-scope';

const engine = { type: 'claude-code', provider: 'anthropic', model: { id: '', name: '' }, account: { id: 0, name: '' } } as const;
const base = { createdAt: '', messageId: 'm', sessionId: 's', engine, parent: { messageId: null, sessionId: null, toolUseId: null } };

describe('scopeToParentTool', () => {
	test('tags every persisted message kind with the parent tool', () => {
		const messages: EngineOutput[] = [
			{ ...base, type: 'reasoning', text: 'thinking' },
			{ ...base, type: 'assistant', content: [{ type: 'text', text: 'hi' }], stopReason: null, usage: null },
			{ ...base, type: 'user', content: [{ type: 'text', text: 'hi' }], synthetic: true },
			{ ...base, type: 'compact_boundary', trigger: 'auto', preTokens: 0 },
		];
		for (const message of messages) {
			expect(scopeToParentTool(message, 'agent-1')).toMatchObject({ type: message.type, parent: { toolUseId: 'agent-1' } });
		}
	});

	test('keeps the closer parent of a nested sub-agent and does not mutate', () => {
		const nested: EngineOutput = { ...base, type: 'reasoning', text: 't', parent: { ...base.parent, toolUseId: 'inner' } };
		expect(scopeToParentTool(nested, 'outer')).toBe(nested);

		const root: EngineOutput = { ...base, type: 'reasoning', text: 't' };
		scopeToParentTool(root, 'agent-1');
		expect(root.parent.toolUseId).toBeNull();
	});

	test('drops turn-level output a child must never drive', () => {
		const transient: EngineOutput[] = [
			{ type: 'stream_event', event: 'delta', sessionId: 's', text: 'x', reasoning: true },
			{ type: 'stream_event', event: 'start', sessionId: 's', reasoning: false },
			{ type: 'result', subtype: 'success', sessionId: 's', numTurns: 1, totalCostUsd: 0, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, stopReason: null },
		];
		for (const output of transient) expect(scopeToParentTool(output, 'agent-1')).toBeNull();
	});
});
