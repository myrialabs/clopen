/**
 * A plan's cards say what is running from what the run reports — not from a
 * guess. A step that takes minutes shows as running, not as waiting.
 */

import { describe, expect, it } from 'bun:test';
import type { Recipe, RecipeTraceEntry } from '$shared/types/recipe';
import { buildPlanGraph } from './plan-graph';

const recipe: Recipe = {
	title: 'Notes app',
	steps: [
		{ kind: 'do', goal: 'Plan it' },
		{ kind: 'repeat', until: 'it passes', max: 3, steps: [{ kind: 'do', goal: 'Build it' }, { kind: 'do', goal: 'Check it' }] },
		{ kind: 'do', goal: 'Report' }
	]
} as Recipe;

const done = (path: string): RecipeTraceEntry => ({ path, kind: 'do', label: path, status: 'ok', startedAt: '2026-01-01T00:00:00.000Z', ms: 1 });

function statuses(trace: RecipeTraceEntry[], runningSteps: string[], running = true): Record<string, string> {
	const graph = buildPlanGraph({ recipe, trace, runningSteps, running, vertical: false, selected: null });
	return Object.fromEntries(graph.nodes.map((node) => [node.id, node.data.status]));
}

describe('buildPlanGraph running steps', () => {
	it('marks the step the run is on, in the round it is in', () => {
		const shown = statuses([done('1'), done('2.r1.1'), done('2.r1.2')], ['2', '2.r2.1']);
		expect(shown['2.r1.1']).toBe('running');
		expect(shown['3']).toBe('waiting');
	});

	it('shows nothing running once the task is not running', () => {
		const shown = statuses([done('1')], ['2.r1.1'], false);
		expect(Object.values(shown)).not.toContain('running');
	});

	it('between two steps, the next one is shown as next', () => {
		const shown = statuses([done('1')], []);
		expect(shown['2.r1.1']).toBe('running');
	});
});
