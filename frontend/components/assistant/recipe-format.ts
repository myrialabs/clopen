/**
 * How flows and recipes read on screen — shared by the flow list, the flow
 * view and a task's crew.
 */

import type { Job, JobTriggerType } from '$shared/types/assistant';
import type { RecipeStep, RecipeTraceEntry } from '$shared/types/recipe';
import type { IconName } from '$shared/types/ui/icons';

export function triggerIcon(type: JobTriggerType): IconName {
	switch (type) {
		case 'schedule':
			return 'lucide:clock';
		case 'once':
			return 'lucide:alarm-clock';
		case 'watch':
			return 'lucide:eye';
		case 'event':
			return 'lucide:zap';
		case 'manual':
			return 'lucide:play';
		default:
			return 'lucide:list-checks';
	}
}

export const DELIVERY_LABEL: Record<Job['delivery'], string> = {
	always: 'Tell me every result',
	changes: 'Tell me when it changes',
	failures: 'Tell me only if it fails'
};

export const STEP_ICON: Record<RecipeStep['kind'], IconName> = {
	do: 'lucide:bot',
	run: 'lucide:terminal',
	http: 'lucide:globe',
	use: 'lucide:plug',
	tell: 'lucide:send',
	ask: 'lucide:message-circle-question-mark',
	approve: 'lucide:shield-check',
	if: 'lucide:git-branch',
	choose: 'lucide:split',
	each: 'lucide:list',
	parallel: 'lucide:git-fork',
	repeat: 'lucide:repeat',
	review: 'lucide:users',
	flow: 'lucide:workflow',
	wait: 'lucide:hourglass'
};

/** One line for a step, the way the recipe text would say it. */
export function stepLabel(step: RecipeStep): string {
	switch (step.kind) {
		case 'do':
			return step.goal;
		case 'run':
			return `Run ${step.script}${step.args?.length ? ` ${step.args.join(' ')}` : ''}`;
		case 'http':
			return `${step.method ?? 'GET'} ${step.url}`;
		case 'use':
			return `Use ${step.service} → ${step.tool}`;
		case 'tell':
			return `Tell me: ${step.text}`;
		case 'ask':
			return `Ask me: ${step.question}`;
		case 'approve':
			return `Wait for my OK: ${step.what}`;
		case 'if':
			return `If ${step.when}`;
		case 'choose':
			return `Choose by ${step.by}`;
		case 'each':
			return `For each of ${step.items}`;
		case 'parallel':
			return `At the same time (${step.branches.length})`;
		case 'repeat':
			return `Repeat until ${step.until}`;
		case 'review':
			return `${step.reviewers.join(', ')} review ${step.target}`;
		case 'flow':
			return `Run flow ${step.flow}`;
		case 'wait':
			return `Wait ${step.minutes} min`;
	}
}

/** Nested step groups with their caption, for the renderer. */
export function stepChildren(step: RecipeStep): Array<{ caption: string | null; steps: RecipeStep[] }> {
	switch (step.kind) {
		case 'if':
			return [{ caption: null, steps: step.then }, ...(step.else ? [{ caption: 'Otherwise', steps: step.else }] : [])];
		case 'choose':
			return [...step.cases.map((entry) => ({ caption: entry.label, steps: entry.steps })), ...(step.otherwise ? [{ caption: 'Otherwise', steps: step.otherwise }] : [])];
		case 'each':
		case 'repeat':
			return [{ caption: null, steps: step.steps }];
		case 'parallel':
			return step.branches.map((steps, index) => ({ caption: `Branch ${index + 1}`, steps }));
		default:
			return [];
	}
}

/** The newest trace entry for each step path. */
export function latestByPath(trace: RecipeTraceEntry[]): Map<string, RecipeTraceEntry> {
	const map = new Map<string, RecipeTraceEntry>();
	for (const entry of trace) map.set(entry.path, entry);
	return map;
}

export function money(usd: number | null | undefined): string {
	if (!usd) return '$0';
	return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

export function duration(ms: number): string {
	if (ms < 1000) return `${ms} ms`;
	const seconds = Math.round(ms / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** The step at a canvas path ("2", "3.then.1", "2.r1.1"), or null. */
export function findStep(steps: RecipeStep[], path: string): RecipeStep | null {
	const walk = (list: RecipeStep[], prefix: string): RecipeStep | null => {
		for (const [index, step] of list.entries()) {
			const here = prefix ? `${prefix}.${index + 1}` : String(index + 1);
			if (here === path) return step;
			if (!path.startsWith(`${here}.`)) continue;
			const children: Array<[RecipeStep[], string]> =
				step.kind === 'if'
					? [[step.then, `${here}.then`], [step.else ?? [], `${here}.else`]]
					: step.kind === 'choose'
						? [...step.cases.map((entry) => [entry.steps, `${here}.${entry.label}`] as [RecipeStep[], string]), [step.otherwise ?? [], `${here}.otherwise`]]
						: step.kind === 'parallel'
							? step.branches.map((branch, at) => [branch, `${here}.b${at + 1}`] as [RecipeStep[], string])
							: step.kind === 'repeat'
								? [[step.steps, `${here}.r1`]]
								: step.kind === 'each'
									? [[step.steps, `${here}.1`]]
									: [];
			for (const [child, childPrefix] of children) {
				const found = walk(child, childPrefix);
				if (found) return found;
			}
		}
		return null;
	};
	return walk(steps, '');
}

/** Every run of the step at a canvas path, oldest first — one per round of a loop. */
export function entriesAt(trace: RecipeTraceEntry[], path: string): RecipeTraceEntry[] {
	const normal = (value: string) => value.replace(/\.r\d+(?=\.|$)/g, '.r1');
	return trace.filter((entry) => normal(entry.path) === path);
}

/** What a step was told to do, when it has words of its own. */
export function stepInstructions(step: RecipeStep): string | null {
	switch (step.kind) {
		case 'do':
			return step.goal;
		case 'tell':
			return step.text;
		case 'ask':
			return step.question;
		case 'approve':
			return step.what;
		case 'if':
			return `If: ${step.when}`;
		case 'choose':
			return `Choose by ${step.by}: ${step.cases.map((entry) => entry.label).join(', ')}`;
		case 'repeat':
			return `Repeat until ${step.until}${step.max ? ` (at most ${step.max} rounds)` : ''}`;
		case 'review':
			return `Review ${step.target} by ${step.reviewers.join(', ')}${step.criteria ? `: ${step.criteria}` : ''}`;
		case 'use':
			return `${step.service}.${step.tool}${step.args ? `\n${JSON.stringify(step.args, null, 2)}` : ''}`;
		case 'http':
			return `${step.method ?? 'GET'} ${step.url}`;
		case 'run':
			return `${step.script}${step.args?.length ? ` ${step.args.join(' ')}` : ''}`;
		default:
			return null;
	}
}

/** The step's own words that can be changed in place, and where they are kept; null when it has none. */
export function editableInstructions(step: RecipeStep): { key: 'goal' | 'text' | 'question' | 'what'; value: string } | null {
	switch (step.kind) {
		case 'do':
			return { key: 'goal', value: step.goal };
		case 'tell':
			return { key: 'text', value: step.text };
		case 'ask':
			return { key: 'question', value: step.question };
		case 'approve':
			return { key: 'what', value: step.what };
		default:
			return null;
	}
}

/** A review's verdict, when a step's output is one ({ passed, issues }). */
export function readVerdict(output: string | undefined): { passed: boolean; issues: string[]; notes: string[] } | null {
	if (!output) return null;
	try {
		const value = JSON.parse(output) as { passed?: unknown; issues?: unknown; verdicts?: Array<{ summary?: string }> };
		if (typeof value.passed !== 'boolean') return null;
		const issues = Array.isArray(value.issues) ? value.issues.map(String) : [];
		const notes = Array.isArray(value.verdicts) ? value.verdicts.map((entry) => entry.summary ?? '').filter(Boolean) : [];
		return { passed: value.passed, issues, notes };
	} catch {
		return null;
	}
}
