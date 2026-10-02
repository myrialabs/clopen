import { describe, expect, test } from 'bun:test';
import { buildQwenReasoningControl } from './models';

describe('buildQwenReasoningControl', () => {
	test('a model whose endpoint lists reasoning_effort gets the effort tiers', () => {
		const control = buildQwenReasoningControl({
			id: 'qwen/qwen3.8-max',
			supported_parameters: ['max_tokens', 'reasoning', 'reasoning_effort', 'tools'],
		});
		expect(control?.levels.map(l => l.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
		expect(control?.default).toBe('medium');
	});

	test('toggle-only reasoning offers no effort selector', () => {
		expect(buildQwenReasoningControl({
			id: 'qwen/qwen3.8-omni-flash',
			supported_parameters: ['reasoning', 'include_reasoning', 'tools'],
		})).toBeUndefined();
	});

	test('endpoints without capability data (DashScope, Fireworks) offer no selector', () => {
		expect(buildQwenReasoningControl({ id: 'qwen3-coder-plus' })).toBeUndefined();
		expect(buildQwenReasoningControl({ id: 'qwen3-coder-plus', supported_parameters: 'reasoning_effort' })).toBeUndefined();
	});
});
