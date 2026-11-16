/**
 * Recipes: the text form round-trips, forgiving JSON is understood, checks on
 * results are decided without a model, and "when" reads plain English.
 */

import { describe, expect, it } from 'bun:test';
import { normaliseRecipe, parseRecipeText, recipeToText, walkSteps } from '$shared/utils/recipe-text';
import { evaluateCheck, interpolate, toItems } from './refs';
import { parseWhen } from '../jobs/when';

const TEXT = `# Morning email
1. Use gmail.search_unread: {"max": 20} → $mail
2. Do: summarise $mail in at most 5 points (as Writer in inbox-tools) → $summary
3. If: $summary contains "urgent"
   1. Tell: Urgent — $summary
   Else:
   1. Tell: $summary
4. Choose: $mail
   Case invoice:
   1. Run: save-invoice $item
   Otherwise:
   1. Wait: 5 min
5. Repeat until: $review.passed
   1. Review $summary by Editor, Busy parent: short and clear → $review
6. In parallel:
   Branch:
   1. HTTP GET https://example.com/a → $a
   Branch:
   1. HTTP GET https://example.com/b → $b
7. Ask: Send it? [yes | no]
8. Approve: Post it publicly`;

describe('recipe text', () => {
	it('parses every verb, nesting and names', () => {
		const recipe = parseRecipeText(TEXT);
		expect(recipe.title).toBe('Morning email');
		expect(recipe.steps.map((step) => step.kind)).toEqual(['use', 'do', 'if', 'choose', 'repeat', 'parallel', 'ask', 'approve']);
		const doStep = recipe.steps[1];
		expect(doStep).toMatchObject({ kind: 'do', role: 'Writer', project: 'inbox-tools', name: 'summary' });
		const ifStep = recipe.steps[2];
		expect(ifStep.kind === 'if' && ifStep.else?.length).toBe(1);
		const choose = recipe.steps[3];
		expect(choose.kind === 'choose' && choose.cases[0].label).toBe('invoice');
		expect(recipe.steps[5].kind === 'parallel' && recipe.steps[5].branches.length).toBe(2);
		expect(recipe.steps[6]).toMatchObject({ kind: 'ask', options: ['yes', 'no'] });
	});

	it('round-trips through text', () => {
		const recipe = parseRecipeText(TEXT);
		expect(parseRecipeText(recipeToText(recipe))).toEqual(recipe);
	});

	it('reports the line it cannot read', () => {
		expect(() => parseRecipeText('1. Do: x\n2. Frobnicate the thing')).toThrow(/Line 2/);
	});

	it('understands loosely shaped JSON', () => {
		const recipe = normaliseRecipe({
			name: 'Prices',
			steps: [
				{ type: 'fetch', url: 'https://example.com' },
				{ type: 'prompt', prompt: 'summarise $s1' },
				{ type: 'condition', condition: '$s2 is empty', then: ['Tell: nothing'], else: [{ type: 'notify', text: '$s2' }] }
			]
		});
		expect(recipe.title).toBe('Prices');
		expect(recipe.steps.map((step) => step.kind)).toEqual(['http', 'do', 'if']);
		expect(walkSteps(recipe.steps).length).toBe(5);
	});
});

describe('branches written the way models write them', () => {
	const shape = (text: string) => JSON.parse(JSON.stringify(parseRecipeText(text).steps));

	it('reads Else level with its If, like code', () => {
		const steps = shape(`1. Do: check today's email → $mail
2. If: $mail has new messages
   1. Tell: $mail
Else:
   1. Use discord.send_message: {"text": "No email today"}`);
		expect(steps).toHaveLength(2);
		expect(steps[1].then.map((step: { kind: string }) => step.kind)).toEqual(['tell']);
		expect(steps[1].else.map((step: { kind: string }) => step.kind)).toEqual(['use']);
	});

	it('reads a numbered Else and steps after the branch', () => {
		const steps = shape(`1. If: $x is empty
   1. Tell: empty
2. Else:
   1. Tell: $x
3. Tell: done`);
		expect(steps.map((step: { kind: string }) => step.kind)).toEqual(['if', 'tell']);
		expect(steps[0].else).toHaveLength(1);
	});

	it('reads Else-if chains as nested Ifs, in either position', () => {
		for (const text of [
			`1. If: $t > 30
   1. Tell: hot
Else if: $t > 20
   1. Tell: warm
Else:
   1. Tell: cold`,
			`1. If: $t > 30
   1. Tell: hot
   Else if $t > 20:
   1. Tell: warm
   Else:
   1. Tell: cold`
		]) {
			const [step] = shape(text);
			expect(step.when).toBe('$t > 30');
			expect(step.then[0].text).toBe('hot');
			expect(step.else[0].kind).toBe('if');
			expect(step.else[0].when).toBe('$t > 20');
			expect(step.else[0].then[0].text).toBe('warm');
			expect(step.else[0].else[0].text).toBe('cold');
		}
	});

	it('reads Case and Branch markers level with their step', () => {
		const [choose, parallel] = shape(`1. Choose: $mail
Case invoice:
   1. Tell: invoice
Case newsletter:
   1. Tell: newsletter
Otherwise:
   1. Tell: other
2. In parallel:
Branch:
   1. Tell: a
Branch:
   1. Tell: b`);
		expect(choose.cases.map((entry: { label: string }) => entry.label)).toEqual(['invoice', 'newsletter']);
		expect(choose.otherwise).toHaveLength(1);
		expect(parallel.branches).toHaveLength(2);
	});

	it('keeps nested branches inside loops', () => {
		const [each] = shape(`1. For each $orders
   1. If: $item.paid
      1. Tell: paid $item
   Else:
      1. Tell: unpaid $item`);
		expect(each.steps[0].then).toHaveLength(1);
		expect(each.steps[0].else).toHaveLength(1);
	});
});

describe('checks on results', () => {
	const vars = new Map<string, unknown>([
		['price', '18,132.17'],
		['mail', 'Your invoice is ready'],
		['list', []],
		['review', { passed: false, issues: ['too long'] }]
	]);

	it('decides plain checks without a model', () => {
		expect(evaluateCheck('$price > 18000', vars)).toBe(true);
		expect(evaluateCheck('$mail contains "invoice"', vars)).toBe(true);
		expect(evaluateCheck('$list is empty', vars)).toBe(true);
		expect(evaluateCheck('$review.passed', vars)).toBe(false);
		expect(evaluateCheck('not $review.passed', vars)).toBe(true);
		expect(evaluateCheck('$price > 18000 and $list is not empty', vars)).toBe(false);
	});

	it('leaves real questions to a model', () => {
		expect(evaluateCheck('the email sounds angry', vars)).toBeNull();
	});

	it('interpolates and splits', () => {
		expect(interpolate('Issues: $review.issues', vars)).toContain('too long');
		expect(toItems('- a\n- b\n\n3. c')).toEqual(['a', 'b', 'c']);
	});
});

describe('when', () => {
	const now = new Date('2026-11-09T10:00:00');
	it('reads schedules', () => {
		expect(parseWhen('every 5 minutes', now)).toMatchObject({ kind: 'cron', cron: '*/5 * * * *' });
		expect(parseWhen('weekdays at 09:00', now)).toMatchObject({ kind: 'cron', cron: '0 9 * * 1-5' });
		expect(parseWhen('every monday and thursday at 8:15', now)).toMatchObject({ kind: 'cron', cron: '15 8 * * 1,4' });
		expect(parseWhen('0 7 * * *', now)).toMatchObject({ kind: 'cron', cron: '0 7 * * *' });
	});
	it('reads one-off times', () => {
		const inTen = parseWhen('in 10 minutes', now);
		expect(inTen.kind === 'once' && inTen.at.getTime() - now.getTime()).toBe(600_000);
		const tomorrow = parseWhen('tomorrow at 07:00', now);
		expect(tomorrow.kind === 'once' && tomorrow.at.getDate()).toBe(10);
	});
	it('explains what it accepts', () => {
		expect(() => parseWhen('setiap pagi', now)).toThrow(/in English/);
	});
});
