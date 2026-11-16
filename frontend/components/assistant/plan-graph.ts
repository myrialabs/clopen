/**
 * A recipe as a graph for the plan canvas (Svelte Flow).
 *
 * Every step that does something is a node; branches fan out with their case
 * on the edge; a loop is a dashed edge back to where it starts. The crew's
 * "work → check → fix, again until it passes" loop is drawn the way a person
 * would sketch it — check, then "problems" to the fix and "again" back —
 * instead of as a node reading `not $qa.passed`.
 *
 * Node ids are the engine's step paths, so a run's trace marks the right node
 * (`.r2`, `.r3`… of a loop all mark the round drawn as `.r1`).
 */

import type { Recipe, RecipeStep, RecipeTraceEntry } from '$shared/types/recipe';
import type { IconName } from '$shared/types/ui/icons';
import { STEP_ICON } from './recipe-format';

export type PlanStatus = 'done' | 'running' | 'failed' | 'skipped' | 'repaired' | 'waiting' | 'stopped' | 'unreached';

export interface PlanNodeData {
	path: string;
	kind: RecipeStep['kind'] | 'trigger';
	icon: IconName;
	/** Who does it: a role, "Clopen", "You". */
	who: string;
	title: string;
	status: PlanStatus;
	costUsd: number | null;
	vertical: boolean;
	selected: boolean;
	/** The round of the loop it is in, from round 2 on. */
	round: number | null;
	/** A service step whose service is not connected yet. */
	notConnected?: boolean;
	[key: string]: unknown;
}

export interface PlanGraph {
	/** `owner`: the branching step (if, choose, for each, in parallel) a node hangs under; null on the main line. */
	nodes: Array<{ id: string; data: PlanNodeData; owner: string | null }>;
	edges: Array<{ id: string; source: string; target: string; label?: string; loop?: boolean }>;
	/** Each node's step, for the details panel. */
	steps: Map<string, RecipeStep>;
}

/** The first sentence or line of a step's text, short enough for a card. */
function headline(text: string, max = 70): string {
	const line = text.replace(/\$([A-Za-z_][\w-]*)(?:\.[\w.-]+)?/g, '$1').split('\n').map((part) => part.trim()).find(Boolean) ?? '';
	const sentence = line.split(/(?<=[.!?])\s/)[0].replace(/[:.]+$/, '');
	return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

/** Plain words for a condition: `$x.passed` reads as "x passed?". */
function conditionText(when: string): string {
	return headline(when.replace(/^not\s+/i, 'not ').replace(/\$([A-Za-z_][\w-]*)\.([\w-]+)/g, '$1 $2'), 60) + '?';
}

function describe(step: RecipeStep): { who: string; title: string } {
	const title = step.title;
	switch (step.kind) {
		case 'do':
			return { who: step.role ?? 'Clopen', title: title ?? headline(step.goal) };
		case 'review':
			return { who: step.reviewers.join(', '), title: title ?? 'Review' };
		case 'ask':
			return { who: 'You', title: title ?? headline(step.question) };
		case 'approve':
			return { who: 'You', title: title ?? headline(step.what) };
		case 'tell':
			return { who: 'Clopen', title: title ?? 'Tell you' };
		case 'run':
			return { who: 'Script', title: title ?? step.script };
		case 'http':
			return { who: 'Web', title: title ?? `${step.method ?? 'GET'} ${headline(step.url, 40)}` };
		case 'use':
			return { who: step.service, title: title ?? step.tool };
		case 'if':
			return { who: 'Check', title: title ?? conditionText(step.when) };
		case 'choose':
			return { who: 'Decide', title: title ?? headline(step.by, 50) };
		case 'each':
			return { who: 'Repeat', title: title ?? `For each ${headline(step.items, 40)}` };
		case 'parallel':
			return { who: 'Split', title: title ?? 'At the same time' };
		case 'repeat':
			return { who: 'Loop', title: title ?? `Until ${conditionText(step.until)}` };
		case 'flow':
			return { who: 'Flow', title: title ?? step.flow };
		case 'wait':
			return { who: 'Wait', title: title ?? `${step.minutes} min` };
	}
}

/** Is this the crew's "check, then fix if it did not pass" loop? */
function checkAndFix(step: Extract<RecipeStep, { kind: 'repeat' }>): { before: RecipeStep[]; fix: RecipeStep[] } | null {
	const last = step.steps[step.steps.length - 1];
	if (step.steps.length < 2 || last.kind !== 'if' || last.else || !/^not\s+\$/i.test(last.when.trim())) return null;
	return { before: step.steps.slice(0, -1), fix: last.then };
}

export function buildPlanGraph(input: {
	recipe: Recipe;
	trace: RecipeTraceEntry[];
	/** The steps under way now, as the run reports them. */
	runningSteps?: string[];
	trigger?: string | null;
	running: boolean;
	vertical: boolean;
	selected: string | null;
	/** The run is over (cancelled, failed, done): steps it never reached say so. */
	ended?: boolean;
}): PlanGraph {
	// A loop shows its latest round: each step's mark comes from that round, not an earlier one.
	const raw = new Map<string, RecipeTraceEntry>();
	const latestRound = new Map<string, number>();
	const live = new Set(input.running ? (input.runningSteps ?? []) : []);
	for (const path of [...input.trace.map((entry) => entry.path), ...live]) {
		for (const match of path.matchAll(/(?:^|\.)r(\d+)(?=\.|$)/g)) {
			const loop = path.slice(0, match.index ?? 0);
			latestRound.set(loop, Math.max(latestRound.get(loop) ?? 1, Number(match[1])));
		}
	}
	for (const entry of input.trace) raw.set(entry.path, entry);
	const loops: string[] = [];
	const actual = (path: string) => loops.reduce((current, loop) => current.replace(`${loop}.r1`, `${loop}.r${latestRound.get(loop) ?? 1}`), path);
	const graph: PlanGraph = { nodes: [], edges: [], steps: new Map() };
	let edgeCount = 0;
	const edge = (source: string, target: string, label?: string, loop?: boolean) => {
		if (!graph.edges.some((existing) => existing.source === source && existing.target === target && existing.label === label)) {
			graph.edges.push({ id: `e${edgeCount++}`, source, target, ...(label ? { label } : {}), ...(loop ? { loop } : {}) });
		}
	};
	let owner: string | null = null;
	const under = <T>(id: string, run: () => T): T => {
		const before = owner;
		owner = id;
		try {
			return run();
		} finally {
			owner = before;
		}
	};
	const node = (path: string, step: RecipeStep) => {
		const ran = raw.get(actual(path));
		const now = live.has(actual(path));
		const loop = loops[loops.length - 1];
		const round = loop ? (latestRound.get(loop) ?? 1) : 1;
		const { who, title } = describe(step);
		graph.steps.set(path, step);
		graph.nodes.push({
			id: path,
			owner,
			data: {
				path,
				kind: step.kind,
				icon: STEP_ICON[step.kind],
				who,
				title,
				status: now ? 'running' : !ran ? (input.ended ? 'unreached' : 'waiting') : ran.status === 'ok' ? 'done' : ran.status === 'failed' && ran.error === 'Stopped.' ? 'stopped' : ran.status,
				costUsd: ran?.costUsd ?? null,
				vertical: input.vertical,
				selected: input.selected === path,
				round: round > 1 ? round : null
			}
		});
		return path;
	};

	type Segment = { first: string | null; lasts: Array<{ id: string; label?: string }> };

	const sequence = (steps: RecipeStep[], prefix: string): Segment => {
		let first: string | null = null;
		let lasts: Segment['lasts'] = [];
		steps.forEach((step, index) => {
			const path = prefix ? `${prefix}.${index + 1}` : String(index + 1);
			const segment = one(step, path);
			if (!segment.first) return;
			for (const last of lasts) edge(last.id, segment.first, last.label);
			first ??= segment.first;
			lasts = segment.lasts;
		});
		return { first, lasts };
	};

	const one = (step: RecipeStep, path: string): Segment => {
		switch (step.kind) {
			case 'if': {
				const id = node(path, step);
				const yes = under(id, () => sequence(step.then, `${path}.then`));
				const no = under(id, () => sequence(step.else ?? [], `${path}.else`));
				if (yes.first) edge(id, yes.first, 'yes');
				if (no.first) edge(id, no.first, 'no');
				return { first: id, lasts: [...(yes.first ? yes.lasts : [{ id, label: 'yes' }]), ...(no.first ? no.lasts : [{ id, label: 'no' }])] };
			}
			case 'choose': {
				const id = node(path, step);
				const lasts: Segment['lasts'] = [];
				for (const entry of step.cases) {
					const branch = under(id, () => sequence(entry.steps, `${path}.${entry.label}`));
					if (branch.first) {
						edge(id, branch.first, entry.label);
						lasts.push(...branch.lasts);
					} else lasts.push({ id, label: entry.label });
				}
				const otherwise = under(id, () => sequence(step.otherwise ?? [], `${path}.otherwise`));
				if (otherwise.first) {
					edge(id, otherwise.first, 'otherwise');
					lasts.push(...otherwise.lasts);
				} else lasts.push({ id, label: 'otherwise' });
				return { first: id, lasts };
			}
			case 'each': {
				const id = node(path, step);
				const inner = under(id, () => sequence(step.steps, `${path}.1`));
				if (inner.first) {
					edge(id, inner.first, 'each');
					for (const last of inner.lasts) edge(last.id, id, 'next', true);
				}
				return { first: id, lasts: [{ id, label: 'all done' }] };
			}
			case 'parallel': {
				const id = node(path, step);
				const lasts: Segment['lasts'] = [];
				step.branches.forEach((branch, index) => {
					const part = under(id, () => sequence(branch, `${path}.b${index + 1}`));
					if (part.first) {
						edge(id, part.first);
						lasts.push(...part.lasts);
					}
				});
				return { first: id, lasts: lasts.length ? lasts : [{ id }] };
			}
			case 'repeat': {
				loops.push(path);
				try {
					return repeatSegment(step, path);
				} finally {
					loops.pop();
				}
			}
			default:
				return { first: node(path, step), lasts: [{ id: path }] };
		}
	};

	const repeatSegment = (step: Extract<RecipeStep, { kind: 'repeat' }>, path: string): Segment => {
		const round = latestRound.get(path) ?? 1;
		const again = round > 1 ? `again · round ${round}` : 'again';
		{
				const pattern = checkAndFix(step);
				if (pattern) {
					const work = sequence(pattern.before, `${path}.r1`);
					const check = work.lasts[work.lasts.length - 1]?.id;
					// The fix hangs under the check that found the problems; the main line goes on from the check.
					const fixPrefix = `${path}.r1.${step.steps.length}.then`;
					const fix = check ? under(check, () => sequence(pattern.fix, fixPrefix)) : sequence(pattern.fix, fixPrefix);
					if (check && fix.first) {
						edge(check, fix.first, 'problems');
						for (const last of fix.lasts) if (work.first) edge(last.id, work.first, again, true);
					}
					return { first: work.first, lasts: check ? [{ id: check, label: 'passes' }] : work.lasts };
				}
				const inner = sequence(step.steps, `${path}.r1`);
				for (const last of inner.lasts) if (inner.first && last.id !== inner.first) edge(last.id, inner.first, again, true);
				return inner;
		}
	};

	let start: string | null = null;
	if (input.trigger) {
		start = 'trigger';
		graph.nodes.push({
			id: 'trigger',
			owner: null,
			data: { path: 'trigger', kind: 'trigger', icon: 'lucide:zap', who: 'Starts', title: input.trigger, status: 'done', costUsd: null, vertical: input.vertical, selected: false, round: null }
		});
	}
	const body = sequence(input.recipe.steps, '');
	if (start && body.first) edge(start, body.first);

	// While it runs and says nothing of its steps (between two of them), the first step not done yet whose predecessors are done is next.
	if (input.running && !graph.nodes.some((entry) => entry.data.status === 'running')) {
		const done = new Set(graph.nodes.filter((entry) => entry.data.status === 'done' || entry.data.status === 'skipped' || entry.data.status === 'repaired').map((entry) => entry.id));
		const next = graph.nodes.find(
			(entry) => entry.data.status === 'waiting' && graph.edges.filter((link) => link.target === entry.id && !link.loop).every((link) => done.has(link.source))
		);
		if (next) next.data.status = 'running';
	}
	return graph;
}

// ── Layout ──────────────────────────────────────────────────────────────────

export const NODE_WIDTH = 224;
export const NODE_HEIGHT = 78;
const GAP_X = 72;
const GAP_Y = 64;
const STACK_GAP = 24;

export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface PlanLayout {
	positions: Map<string, { x: number; y: number }>;
	/** Which side of each node an edge leaves and enters. */
	handles: Map<string, { source: Side; target: Side }>;
}

/**
 * Lay the plan out like reading a page: the main line runs left to right,
 * turns down at the end of a row and comes back right to left (a snake), so a
 * long plan stays compact. What hangs under a branching step — the "yes" of
 * an if, the cases of a choose — is stacked beneath it. The layout depends
 * only on the plan's structure and the number of columns, never on timing
 * or the window, so the same plan looks the same every time it is opened.
 */
export function layoutPlan(graph: PlanGraph, columns: number): PlanLayout {
	const positions = new Map<string, { x: number; y: number }>();
	const ownerOf = new Map(graph.nodes.map((entry) => [entry.id, entry.owner]));
	const topOf = (id: string): string => {
		let current = id;
		while (ownerOf.get(current)) current = ownerOf.get(current)!;
		return current;
	};
	const main = graph.nodes.filter((entry) => !entry.owner).map((entry) => entry.id);
	const hanging = new Map<string, string[]>();
	for (const entry of graph.nodes) {
		if (!entry.owner) continue;
		const top = topOf(entry.id);
		hanging.set(top, [...(hanging.get(top) ?? []), entry.id]);
	}
	const depthOf = (id: string): number => {
		let depth = 0;
		let current = ownerOf.get(id);
		while (current) {
			depth += 1;
			current = ownerOf.get(current);
		}
		return depth;
	};

	const cols = Math.max(1, columns);
	const rows: string[][] = [];
	for (let index = 0; index < main.length; index += cols) rows.push(main.slice(index, index + cols));
	let y = 0;
	rows.forEach((row, rowIndex) => {
		const rightToLeft = rowIndex % 2 === 1;
		let tallest = 0;
		row.forEach((id, column) => {
			const slot = rightToLeft ? cols - 1 - column : column;
			const x = slot * (NODE_WIDTH + GAP_X);
			positions.set(id, { x, y });
			const stack = hanging.get(id) ?? [];
			stack.forEach((child, index) => {
				positions.set(child, { x: x + (depthOf(child) - 1) * 16, y: y + (index + 1) * (NODE_HEIGHT + STACK_GAP) });
			});
			tallest = Math.max(tallest, stack.length);
		});
		y += NODE_HEIGHT + tallest * (NODE_HEIGHT + STACK_GAP) + GAP_Y;
	});

	const handles = new Map<string, { source: Side; target: Side }>();
	for (const link of graph.edges) {
		const from = positions.get(link.source);
		const to = positions.get(link.target);
		if (!from || !to) continue;
		if (link.loop) {
			// A loop never runs along a line already drawn. Back to the step right above it (a fix hanging
			// under its check): round the right side, beside the line coming down. Back to a step in another
			// column: underneath, into that step's free bottom. On a phone: round the left, clear of the middle.
			const above = Math.abs(from.x - to.x) < NODE_WIDTH;
			handles.set(link.id, cols === 1 ? { source: 'left', target: 'left' } : above ? { source: 'right', target: 'right' } : { source: 'bottom', target: 'bottom' });
		} else if (Math.abs(from.y - to.y) < 1) {
			handles.set(link.id, from.x <= to.x ? { source: 'right', target: 'left' } : { source: 'left', target: 'right' });
		} else if (to.y > from.y && Math.abs(from.x - to.x) < NODE_WIDTH) {
			handles.set(link.id, { source: 'bottom', target: 'top' });
		} else {
			handles.set(link.id, to.y > from.y ? { source: 'bottom', target: 'top' } : { source: 'top', target: 'bottom' });
		}
	}
	return { positions, handles };
}

