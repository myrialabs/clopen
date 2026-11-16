/**
 * Recipes learn from their runs.
 *
 *   - Repair: when a run fails, a model reads the recipe, the error and the
 *     trace, and either rewrites the recipe (another source, another approach,
 *     a branch for the case it hit), says a retry is enough, or gives up. The
 *     lesson is kept in the recipe's notes, which its AI steps read next time.
 *   - Freeze: an AI step that has succeeded several times is checked once —
 *     could a script do exactly this? If so, the script is written, tested,
 *     and swapped in: the step keeps working and stops costing tokens.
 *
 * Every change is a new recipe version the owner can roll back, and is said in
 * one line.
 */

import { jobQueries } from '$backend/database/queries';
import { toJob } from '$backend/assistant/mappers';
import { journal } from '$backend/assistant/journal';
import { runScript, saveScript } from '$backend/assistant/scripts';
import { think } from '$backend/assistant/think';
import type { Job } from '$shared/types/assistant';
import type { Recipe, RecipeStep } from '$shared/types/recipe';
import { parseRecipeText, recipeToText, RecipeError } from '$shared/utils/recipe-text';
import { debug } from '$shared/utils/logger';
import type { RunResult } from './engine';

/** Successful runs of an AI step before Clopen checks whether a script could do it. */
export const FREEZE_AFTER_RUNS = 5;

const RECIPE_FORMAT = `Recipe format (keep exactly this structure; content may be in any language):
# Title
1. Do: <goal for an AI agent> (as <Role> in <project>) → $name
2. Run: <script-name> <args>
3. HTTP GET <url>
4. Use <service>.<tool>: {"json":"args"}
5. Tell: <message for the owner, may use $name>
6. Ask: <question> [option a | option b]
7. Approve: <what needs the owner's OK>
8. If: <check like $x > 3, or a plain question>
   1. <steps>
   Else:
   1. <steps>
9. Choose: <what to sort>
   Case <label>:
   1. <steps>
   Otherwise:
   1. <steps>
10. For each: $list
   1. <steps using $item>
11. In parallel:
   Branch:
   1. <steps>
12. Repeat until: <condition>
   1. <steps>
13. Review $name by <Role>, <Role>: <what to check>
14. Wait: <minutes> min`;

/** A rewritten recipe, an advice to retry, or nothing to be done. */
export async function repairRecipe(job: Job, result: RunResult): Promise<{ rewritten: boolean; retry: boolean; lesson: string }> {
	const trace = result.trace
		.slice(-12)
		.map((entry) => `${entry.path} [${entry.status}] ${entry.label}${entry.error ? ` — ${entry.error.slice(0, 400)}` : ''}`)
		.join('\n');
	let answer: { decision: 'rewrite' | 'retry' | 'give_up'; lesson: string; recipe: string | null };
	try {
		answer = await think(
			[
				`A recipe ("${job.name}") failed. Decide how to fix it so the next run works.`,
				'',
				'Current recipe:',
				recipeToText(job.recipe),
				'',
				`Failed at step ${result.failedPath ?? '?'}: ${result.error ?? 'unknown error'}`,
				'Trace:',
				trace,
				'',
				job.notes.length ? `Earlier lessons:\n${job.notes.slice(-10).map((note) => `- ${note}`).join('\n')}` : '',
				'',
				'decision: "rewrite" if a different approach would work (another data source, an extra step, a branch for this case) — then give the complete new recipe;',
				'"retry" if it was a passing glitch (a timeout, a rate limit); "give_up" if only the owner can fix it (a missing account or permission).',
				'lesson: one short sentence worth remembering for next time.',
				'',
				RECIPE_FORMAT
			].join('\n'),
			{
				type: 'object',
				additionalProperties: false,
				properties: {
					decision: { type: 'string', enum: ['rewrite', 'retry', 'give_up'] },
					lesson: { type: 'string' },
					recipe: { type: ['string', 'null'], description: 'The complete rewritten recipe text when decision is rewrite, else null.' }
				},
				required: ['decision', 'lesson', 'recipe']
			}
		);
	} catch (error) {
		debug.warn('jobs', `Repairing ${job.name} failed:`, error);
		return { rewritten: false, retry: false, lesson: '' };
	}

	const lesson = answer.lesson.trim().slice(0, 300);
	if (lesson) jobQueries.setNotes(job.id, [...job.notes, lesson]);
	if (answer.decision === 'rewrite' && answer.recipe) {
		try {
			const recipe = parseRecipeText(answer.recipe, job.recipe.title);
			jobQueries.saveRecipe(job.id, recipe, `Repaired after a failure: ${lesson || result.error || ''}`.slice(0, 300), 'assistant');
			journal('automation', `"${job.name}" repaired itself: ${lesson}`, { jobId: job.id });
			return { rewritten: true, retry: true, lesson };
		} catch (error) {
			debug.warn('jobs', `The repaired recipe for ${job.name} was not valid:`, error instanceof RecipeError ? error.message : error);
		}
	}
	return { rewritten: false, retry: answer.decision === 'retry', lesson };
}

function stepAt(steps: RecipeStep[], path: string): RecipeStep | null {
	const [head, ...rest] = path.split('.');
	const step = steps[Number(head) - 1];
	return step && rest.length === 0 ? step : null;
}

function replaceAt(recipe: Recipe, path: string, step: RecipeStep): Recipe {
	const index = Number(path) - 1;
	return { ...recipe, steps: recipe.steps.map((entry, position) => (position === index ? step : entry)) };
}

/**
 * Count the run's successes per top-level AI step and, for one that has
 * succeeded often enough, check once whether a script could replace it.
 * Returns a one-line note when a step was frozen.
 */
export async function considerFreezing(jobId: string, result: RunResult): Promise<string | null> {
	const row = jobQueries.getById(jobId);
	if (!row || !result.ok) return null;
	const job = toJob(row);
	const stats = { ...job.stats } as Record<string, { ok: number; same: number; last?: string; checked?: boolean }>;
	for (const entry of result.trace) {
		if (entry.kind !== 'do' || entry.status !== 'ok' || entry.path.includes('.')) continue;
		const current = stats[entry.path] ?? { ok: 0, same: 0 };
		const output = (entry.output ?? '').trim();
		stats[entry.path] = { ...current, ok: current.ok + 1, same: current.last === output ? current.same + 1 : 0, last: output.slice(0, 500) };
	}
	jobQueries.setStats(jobId, stats);

	const candidate = Object.entries(stats).find(([path, stat]) => stat.ok >= FREEZE_AFTER_RUNS && !stat.checked && stepAt(job.recipe.steps, path)?.kind === 'do');
	if (!candidate) return null;
	const [path] = candidate;
	stats[path] = { ...stats[path], checked: true };
	jobQueries.setStats(jobId, stats);
	const step = stepAt(job.recipe.steps, path) as Extract<RecipeStep, { kind: 'do' }>;
	const example = result.trace.find((entry) => entry.path === path)?.output ?? '';

	let answer: { scriptable: boolean; runtime: 'bash' | 'bun'; script: string | null; reason: string };
	try {
		answer = await think(
			[
				`This AI step runs every time "${job.name}" runs:`,
				`"${step.goal}"`,
				`A recent result:\n<<<\n${example.slice(0, 3000)}\n>>>`,
				'',
				'Could a script do exactly this, with no judgement (fetching, extracting, formatting)? If yes, write it:',
				'- bash, or bun (TypeScript) when parsing JSON or HTML is easier that way;',
				'- free public sources only, no API keys; print the result to stdout in the same shape as the example;',
				'- exit non-zero on failure.',
				'If it needs judgement (summarising, deciding, writing for a person), answer scriptable false.'
			].join('\n'),
			{
				type: 'object',
				additionalProperties: false,
				properties: {
					scriptable: { type: 'boolean' },
					runtime: { type: 'string', enum: ['bash', 'bun'] },
					script: { type: ['string', 'null'] },
					reason: { type: 'string' }
				},
				required: ['scriptable', 'runtime', 'script', 'reason']
			}
		);
	} catch (error) {
		debug.warn('jobs', 'Checking a step for freezing failed:', error);
		return null;
	}
	if (!answer.scriptable || !answer.script?.trim()) return null;

	try {
		const script = saveScript({
			name: `${job.name} step ${path}`,
			description: `Frozen from an AI step of "${job.name}": ${step.goal.slice(0, 120)}`,
			content: answer.script,
			runtime: answer.runtime,
			projectId: job.projectId,
			source: 'assistant'
		});
		const { scriptQueries } = await import('$backend/database/queries');
		const row = scriptQueries.getById(script.id);
		if (!row) return null;
		const test = await runScript(row, [], { projectId: job.projectId, timeoutMs: 120_000 });
		if (test.exitCode !== 0 || !test.output.trim()) {
			scriptQueries.delete(script.id);
			return null;
		}
		const frozen: RecipeStep = { kind: 'run', script: script.slug, ...(step.name ? { name: step.name } : {}) };
		const note = `Step ${path} now runs as a script (${script.slug}) — no AI, no tokens.`;
		jobQueries.saveRecipe(jobId, replaceAt(job.recipe, path, frozen), note, 'assistant');
		journal('automation', `"${job.name}": ${note}`, { jobId });
		return note;
	} catch (error) {
		debug.warn('jobs', 'Freezing a step failed:', error);
		return null;
	}
}
