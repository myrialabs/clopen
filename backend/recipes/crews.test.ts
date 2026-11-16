/**
 * Crews are sized to the request, every stage works in a project, and a run
 * ends honestly: a loop that never passes is "unfinished", never "done".
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { closeDatabase, initializeDatabase } from '$backend/database';
import { crewKindOf, crewRecipe, crewResultVar, fallbackPlan, reviseRecipe, type CrewPlan } from './crews';
import { runRecipe } from './engine';
import { walkSteps } from '$shared/utils/recipe-text';
import type { RecipeStep } from '$shared/types/recipe';
import { buildPlanGraph, layoutPlan, NODE_HEIGHT, NODE_WIDTH } from '../../frontend/components/assistant/plan-graph';
import { projectAvatars } from '../../frontend/utils/project-avatar';

const plan = (patch: Partial<CrewPlan>): CrewPlan => ({ ...fallbackPlan('Build a calculator'), kind: 'build', ...patch });

function doSteps(steps: RecipeStep[]): Array<Extract<RecipeStep, { kind: 'do' }>> {
	return walkSteps(steps)
		.map((entry) => entry.step)
		.filter((step): step is Extract<RecipeStep, { kind: 'do' }> => step.kind === 'do');
}

beforeAll(async () => {
	await initializeDatabase();
});

afterAll(() => {
	closeDatabase();
});

describe('crews', () => {
	it('builds with a developer and a tester only, unless the request needs more', () => {
		const recipe = crewRecipe(plan({}), 'Build a calculator', undefined, 'p-1');
		const roles = [...new Set(doSteps(recipe.steps).map((step) => step.role))];
		expect(roles).toEqual(['Developer', 'Tester']);
		expect(crewResultVar(recipe)).toBe('release');
		const withResearch = crewRecipe(plan({ research: true, launch: true }), 'Build a PCOS meal plan', undefined, 'p-1');
		expect([...new Set(doSteps(withResearch.steps).map((step) => step.role))]).toEqual(['Researcher', 'Developer', 'Tester', 'Marketer']);
		expect(withResearch.steps.some((step) => step.kind === 'approve')).toBe(true);
	});

	it('keeps every stage in the project and gives it a human title', () => {
		for (const kind of ['build', 'document', 'general'] as const) {
			const recipe = crewRecipe(plan({ kind }), 'Do something', undefined, 'p-7');
			for (const step of doSteps(recipe.steps)) {
				expect(step.project).toBe('p-7');
				expect(step.title).toBeTruthy();
			}
		}
	});

	it('revises with the same crew, in the same project, and never asks the owner', () => {
		const build = crewRecipe(plan({}), 'Build a calculator', undefined, 'p-1');
		expect(crewKindOf(build)).toBe('build');
		const revised = reviseRecipe(build, 'Make it dark', 'A calculator at https://x.example', 'p-1');
		const roles = [...new Set(doSteps(revised.steps).map((step) => step.role))];
		expect(roles).toEqual(['Developer', 'Tester']);
		for (const step of doSteps(revised.steps)) expect(step.project).toBe('p-1');
		expect(doSteps(revised.steps)[0].goal).toContain('Make it dark');
		const doc = crewRecipe(plan({ kind: 'document' }), 'Write a CV', undefined, 'p-2');
		expect(crewKindOf(doc)).toBe('document');
		expect(doSteps(reviseRecipe(doc, 'Use English', '', 'p-2').steps)[0].role).toBe('Writer');
		for (const step of doSteps(doc.steps)) if (step.role !== 'Tester') expect(step.goal).toContain('Do not ask the owner');
	});

	it('plans the smallest crew when no planner answers', () => {
		const fallback = fallbackPlan('Tolong rapikan dokumen ini');
		expect(fallback).toMatchObject({ kind: 'general', research: false, reviewer: null, launch: false });
	});
});

describe('how a run ends', () => {
	const scope = { kind: 'flow' as const, title: 'Test', ownerId: 'f-1', projectId: null, notes: [] };

	it('calls a loop that stops improving unfinished, not done', async () => {
		const result = await runRecipe(
			{ title: 'loop', steps: [{ kind: 'repeat', until: '$w is not empty', max: 3, steps: [{ kind: 'wait', minutes: 0, name: 'w' }] }] },
			scope,
			{ signal: new AbortController().signal }
		);
		expect(result.ok).toBe(false);
		expect(result.outcome).toBe('unfinished');
	});

	it('refuses project work without a project', async () => {
		const result = await runRecipe({ title: 'task', steps: [{ kind: 'do', goal: 'Build it' }] }, { ...scope, kind: 'task' }, { signal: new AbortController().signal });
		expect(result.outcome).toBe('failed');
		expect(result.error).toMatch(/no project/);
	});
});

describe('the plan canvas', () => {
	it('draws the build crew as build → test → check, with a loop back to the test', () => {
		const recipe = crewRecipe(plan({}), 'Build a calculator', undefined, 'p-1');
		const graph = buildPlanGraph({ recipe, trace: [], running: false, vertical: false, selected: null });
		const titles = graph.nodes.map((node) => node.data.title);
		expect(titles).toContain('Build it');
		expect(titles).toContain('Test in the browser');
		expect(titles).toContain('Share a link');
		expect(titles.some((title) => title.includes('$'))).toBe(false);
		expect(graph.edges.some((edge) => edge.loop && edge.label === 'again')).toBe(true);
		expect(graph.edges.some((edge) => edge.label === 'problems')).toBe(true);
	});

	it('marks steps from the trace, every round on the drawn one', () => {
		const recipe = crewRecipe(plan({}), 'Build a calculator', undefined, 'p-1');
		const trace = [
			{ path: '1', kind: 'do' as const, label: 'Developer: Build it', status: 'ok' as const, startedAt: '', ms: 1 },
			{ path: '2.r2.1', kind: 'do' as const, label: 'Tester', status: 'ok' as const, startedAt: '', ms: 1 }
		];
		const graph = buildPlanGraph({ recipe, trace, running: true, vertical: true, selected: null });
		expect(graph.nodes.find((node) => node.id === '1')?.data.status).toBe('done');
		expect(graph.nodes.find((node) => node.id === '2.r1.1')?.data.status).toBe('done');
		expect(graph.nodes.some((node) => node.data.status === 'running')).toBe(true);
	});
});

describe('the canvas layout', () => {
	const recipe = crewRecipe(plan({ research: true }), 'Build a calculator', undefined, 'p-1');
	const graph = buildPlanGraph({ recipe, trace: [], running: false, vertical: false, selected: null });

	it('is the same every time for the same plan', () => {
		const first = layoutPlan(graph, 4);
		const second = layoutPlan(buildPlanGraph({ recipe, trace: [], running: true, vertical: false, selected: '1' }), 4);
		expect([...second.positions.entries()]).toEqual([...first.positions.entries()]);
	});

	it('snakes: the second row runs right to left, and no two cards overlap', () => {
		const layout = layoutPlan(graph, 2);
		const boxes = [...layout.positions.values()];
		for (let i = 0; i < boxes.length; i++)
			for (let j = i + 1; j < boxes.length; j++) {
				const overlap = Math.abs(boxes[i].x - boxes[j].x) < NODE_WIDTH && Math.abs(boxes[i].y - boxes[j].y) < NODE_HEIGHT;
				expect(overlap).toBe(false);
			}
		const main = graph.nodes.filter((node) => !node.owner).map((node) => layout.positions.get(node.id)!);
		expect(main[2].y).toBeGreaterThan(main[0].y);
		expect(main[2].x).toBeGreaterThan(main[3].x);
	});

	it('hangs the fix under the check and loops back below the row', () => {
		const fix = graph.nodes.find((node) => node.data.title === 'Fix what the test found')!;
		expect(fix.owner).not.toBeNull();
		const loop = graph.edges.find((edge) => edge.loop && edge.label === 'again')!;
		expect(layoutPlan(graph, 4).handles.get(loop.id)).toEqual({ source: 'bottom', target: 'bottom' });
	});

	it('loops a fix back to the check right above it round the side, not along the line down', () => {
		const general = buildPlanGraph({ recipe: crewRecipe(plan({ kind: 'general' }), 'Sign the offer letter', undefined, 'p-1'), trace: [], running: false, vertical: false, selected: null });
		const layout = layoutPlan(general, 4);
		for (const edge of general.edges.filter((entry) => entry.loop)) {
			const from = layout.positions.get(edge.source)!;
			const to = layout.positions.get(edge.target)!;
			if (Math.abs(from.x - to.x) < NODE_WIDTH) expect(layout.handles.get(edge.id)).toEqual({ source: 'right', target: 'right' });
		}
		expect(general.edges.some((entry) => entry.loop)).toBe(true);
	});
});

describe('the canvas over a run', () => {
	const recipe = crewRecipe(plan({}), 'Build a calculator', undefined, 'p-1');
	const entry = (path: string, status: 'ok' | 'failed' = 'ok', error?: string) => ({ path, kind: 'do' as const, label: path, status, startedAt: '', ms: 1, ...(error ? { error } : {}) });

	it('shows the latest round of a loop, and which round it is', () => {
		const trace = [entry('1'), entry('2.r1.1'), entry('2.r1.2'), entry('2.r1.3.then.1')];
		const graph = buildPlanGraph({ recipe, trace: [...trace, entry('2.r2.1')], running: true, vertical: false, selected: null });
		const test = graph.nodes.find((node) => node.id === '2.r1.1')!;
		expect(test.data.status).toBe('done');
		expect(test.data.round).toBe(2);
		// The round-2 check has not run: it is what runs next, not "done" from round 1.
		expect(graph.nodes.find((node) => node.id === '2.r1.2')!.data.status).toBe('running');
		expect(graph.edges.some((edge) => edge.loop && edge.label === 'again · round 2')).toBe(true);
	});

	it('says what a stopped run never reached', () => {
		const graph = buildPlanGraph({ recipe, trace: [entry('1'), entry('2.r1.1', 'failed', 'Stopped.')], running: false, ended: true, vertical: false, selected: null });
		expect(graph.nodes.find((node) => node.id === '2.r1.1')!.data.status).toBe('stopped');
		expect(graph.nodes.find((node) => node.data.title === 'Share a link')!.data.status).toBe('unreached');
	});

	it('routes loops round the side on a phone', () => {
		const graph = buildPlanGraph({ recipe, trace: [], running: false, vertical: true, selected: null });
		const loop = graph.edges.find((edge) => edge.loop)!;
		expect(layoutPlan(graph, 1).handles.get(loop.id)).toEqual({ source: 'left', target: 'left' });
	});
});

describe('project avatars', () => {
	it('gives similar names different letters', () => {
		const avatars = projectAvatars([
			{ id: 'a', name: 'clicktrainer' },
			{ id: 'b', name: 'clicklander' },
			{ id: 'c', name: 'course-updater' }
		]);
		expect(avatars.get('a')?.initials).toBe('Ct');
		expect(avatars.get('b')?.initials).toBe('Cl');
		expect(avatars.get('c')?.initials).toBe('Cu');
	});
});
