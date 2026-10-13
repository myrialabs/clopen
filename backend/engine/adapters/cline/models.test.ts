import { describe, expect, test } from 'bun:test';
import { buildClineReasoningControl, isClineChatModel, resolveClineReasoning, type CatalogModel } from './models';

type Options = CatalogModel['reasoningOptions'];

// Shapes taken from the @cline/llms catalog.
const EFFORT_ONLY: Options = [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }];
const TOGGLE_AND_EFFORT: Options = [{ type: 'toggle' }, { type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }];
const EFFORT_WITH_NONE: Options = [{ type: 'effort', values: ['none', 'low', 'medium', 'high'] }];
const TOGGLE_ONLY: Options = [{ type: 'toggle' }];
const BUDGET_ONLY: Options = [{ type: 'budget_tokens', min: 1024 }];

const levelsOf = (options: Options) => buildClineReasoningControl(options)?.levels.map(l => l.value);

describe('isClineChatModel', () => {
	test('a language model that reads and writes text is chat', () => {
		expect(isClineChatModel({ operation: 'language', modalities: { input: ['text', 'image'], output: ['text'] } })).toBe(true);
	});

	test('entries without operation or modalities stay chat', () => {
		expect(isClineChatModel({})).toBe(true);
	});

	test('transcription and media-generation models are not chat', () => {
		expect(isClineChatModel({ operation: 'transcription', modalities: { input: ['audio'], output: ['text'] } })).toBe(false);
		expect(isClineChatModel({ operation: 'image-generation' })).toBe(false);
		expect(isClineChatModel({ modalities: { input: ['text'], output: ['image'] } })).toBe(false);
	});
});

describe('Cline reasoning levels', () => {
	test('effort tiers without a way to turn thinking off offer no Off', () => {
		expect(levelsOf(EFFORT_ONLY)).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
	});

	test('a toggle or a none effort adds Off', () => {
		expect(levelsOf(TOGGLE_AND_EFFORT)).toEqual(['off', 'auto', 'low', 'medium', 'high', 'xhigh', 'max']);
		expect(levelsOf(EFFORT_WITH_NONE)).toEqual(['off', 'auto', 'low', 'medium', 'high']);
	});

	test('a toggle-only model offers Off / Auto / On', () => {
		expect(levelsOf(TOGGLE_ONLY)).toEqual(['off', 'auto', 'on']);
	});

	test('budget-only and option-less models get no selector', () => {
		expect(buildClineReasoningControl(BUDGET_ONLY)).toBeUndefined();
		expect(buildClineReasoningControl([])).toBeUndefined();
		expect(buildClineReasoningControl(undefined)).toBeUndefined();
	});

	test('the default is always Auto, one of the levels', () => {
		for (const options of [EFFORT_ONLY, TOGGLE_AND_EFFORT, EFFORT_WITH_NONE, TOGGLE_ONLY]) {
			const control = buildClineReasoningControl(options);
			expect(control?.default).toBe('auto');
			expect(control?.levels.some(l => l.value === 'auto')).toBe(true);
		}
	});
});

describe('resolveClineReasoning', () => {
	test('an offered effort becomes reasoningEffort', () => {
		expect(resolveClineReasoning('xhigh', EFFORT_ONLY)).toEqual({ reasoningEffort: 'xhigh' });
	});

	test('off and on drive the thinking flag', () => {
		expect(resolveClineReasoning('off', TOGGLE_AND_EFFORT)).toEqual({ thinking: false });
		expect(resolveClineReasoning('on', TOGGLE_ONLY)).toEqual({ thinking: true });
	});

	test('auto, unknown and no longer offered levels send nothing', () => {
		expect(resolveClineReasoning('auto', EFFORT_ONLY)).toEqual({});
		expect(resolveClineReasoning(undefined, EFFORT_ONLY)).toEqual({});
		expect(resolveClineReasoning('off', EFFORT_ONLY)).toEqual({});
		expect(resolveClineReasoning('max', EFFORT_WITH_NONE)).toEqual({});
		expect(resolveClineReasoning('high', BUDGET_ONLY)).toEqual({});
	});
});
