import { describe, expect, test } from 'bun:test';
import { CLAUDE_CODE_MODELS, resolveClaudeReasoning } from './models';

const levelsOf = (id: string) =>
	CLAUDE_CODE_MODELS.find(m => m.engine.model.id === id)?.capabilities.reasoningControl?.levels.map(l => l.value);

describe('Claude reasoning levels', () => {
	test('models that reject disabled thinking offer no Off', () => {
		for (const id of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5']) {
			expect(levelsOf(id)).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
		}
	});

	test('xhigh starts at Opus 4.7; the 4.6 models stop at max without it', () => {
		expect(levelsOf('claude-opus-4-7')).toContain('xhigh');
		expect(levelsOf('claude-opus-4-6')).toEqual(['off', 'auto', 'low', 'medium', 'high', 'max']);
		expect(levelsOf('claude-sonnet-4-6')).toEqual(['off', 'auto', 'low', 'medium', 'high', 'max']);
	});

	test('a model without effort offers only the thinking toggle', () => {
		expect(levelsOf('claude-opus-4-5')).toEqual(['off', 'auto']);
	});

	test('every catalog default is one of its own levels', () => {
		for (const model of CLAUDE_CODE_MODELS) {
			const control = model.capabilities.reasoningControl;
			expect(control?.levels.some(l => l.value === control.default)).toBe(true);
		}
	});
});

describe('resolveClaudeReasoning', () => {
	test('a level the model offers passes through', () => {
		expect(resolveClaudeReasoning('claude-opus-5', 'off')).toBe('off');
		expect(resolveClaudeReasoning('claude-opus-5-5', 'xhigh')).toBe('xhigh');
	});

	test('a stored level the model no longer offers falls back to its default', () => {
		expect(resolveClaudeReasoning('claude-opus-5-5', 'off')).toBe('auto');
		expect(resolveClaudeReasoning('claude-opus-4-6', 'xhigh')).toBe('auto');
		expect(resolveClaudeReasoning('claude-opus-4-5', 'high')).toBe('auto');
	});

	test('no request, or a model outside the catalog, passes through unchanged', () => {
		expect(resolveClaudeReasoning('claude-opus-5-5', undefined)).toBeUndefined();
		expect(resolveClaudeReasoning('haiku', 'off')).toBe('off');
		expect(resolveClaudeReasoning(undefined, 'high')).toBe('high');
	});
});
