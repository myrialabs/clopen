/**
 * Running a flow (stored as a job): its recipe, through the recipe engine.
 *
 * One run at a time. When a trigger fires while a run is still going, the
 * overlap policy decides: `skip` drops the new start, `wait` runs it once the
 * current run ends (several starts while waiting collapse into one).
 *
 * A run that fails is handed to `repairRecipe` once: the recipe may be
 * rewritten (a new version) and the run tried again, or a passing glitch is
 * simply retried. A run that succeeds feeds `considerFreezing`, which turns an
 * AI step that keeps working into a script. A flow with a daily budget pauses
 * itself when the budget is used up.
 *
 * The owner hears about results according to the delivery policy — every run,
 * only when the result changed, or only failures — unless the recipe already
 * told them itself (a `tell` step). Failures are reported once: a broken flow
 * raises a single "isn't working" item that stays until it works again. A run
 * the owner stopped is not a failure.
 *
 * Whatever started the run from outside — a webhook body, the new content of a
 * watched page — is passed to the AI steps as quoted, untrusted context.
 */

import { inboxQueries, jobQueries, type JobRow } from '$backend/database/queries';
import { raiseInboxItem, resolveInboxItem } from '$backend/assistant/inbox';
import { notifyAssistantChanged } from '$backend/assistant/events';
import { journal } from '$backend/assistant/journal';
import { tellOwner } from '$backend/assistant/notify';
import { inOwnersLanguage } from '$backend/assistant/think';
import { toJob } from '$backend/assistant/mappers';
import { isFrequent } from './service';
import type { JobTriggerType } from '$shared/types/assistant';
import { runRecipe, type RunResult } from '$backend/recipes/engine';
import { considerFreezing, repairRecipe } from '$backend/recipes/learn';
import type { RecipeTraceEntry } from '$shared/types/recipe';
import { debug } from '$shared/utils/logger';

/** What a check-in answers when everything is fine — nothing is sent then. */
export const NOTHING_TO_REPORT = 'NOTHING TO REPORT';

/** Starts held back by the `wait` overlap policy, by flow. */
const deferred = new Map<string, { reason: string; context?: string }>();

/** Runs in progress, so they can be stopped. */
const active = new Map<string, { jobId: string; controller: AbortController }>();

const failingKey = (jobId: string) => `automation-failing:${jobId}`;

function sameResult(a: string, b: string): boolean {
	const norm = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').replace(/\d{1,2}:\d{2}(:\d{2})?/g, '#').trim();
	return norm(a) === norm(b);
}

function startOfToday(): string {
	const now = new Date();
	now.setHours(0, 0, 0, 0);
	return now.toISOString();
}

/** Words the owner wrote for this flow (its name, its steps), to tell them about it in their language. */
function sampleOf(row: JobRow): string {
	const words = [...(row.recipe ?? '').matchAll(/"(?:text|goal|question|what)":"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]).join(' ');
	return `${row.name} ${row.description ?? ''} ${words}`.slice(0, 500);
}

/** A fixed notice about a flow, said in the owner's language. */
function say(row: JobRow, text: string): Promise<string> {
	return inOwnersLanguage(text, sampleOf(row));
}

/**
 * Tell the owner how a run ended — or don't. One open "isn't working" item
 * per broken flow; it is settled, with a short "works again", by the next
 * success.
 */
function deliverResult(row: JobRow, run: { id: string; ok: boolean; output: string; error: string | null; told: boolean }, options: { checkin?: boolean } = {}): void {
	const failing = inboxQueries.findOpen('report', { dedupe: failingKey(row.id) });
	if (!run.ok) {
		journal('automation', `"${row.name}" failed: ${run.error ?? 'unknown error'}`, { jobId: row.id });
		if (failing) return;
		// Said in the owner's words, in a line — never the raw error text of a step.
		void Promise.all([say(row, `${row.name} isn’t working.`), run.error ? say(row, `Why: ${run.error.slice(0, 300)}`) : Promise.resolve('')]).then(([title, why]) =>
			raiseInboxItem({
				kind: 'report',
				title,
				body: why,
				dedupe: failingKey(row.id),
				jobId: row.id,
				projectId: row.project_id
			})
		);
		return;
	}

	journal('automation', `"${row.name}" ran: ${run.output.replace(/\s+/g, ' ').slice(0, 200) || 'done'}`, { jobId: row.id });
	if (failing) {
		resolveInboxItem(failing.id, 'resolved', { by: 'automation', note: 'Working again' });
		void say(row, `${row.name} works again.`).then((text) => tellOwner({ text, refs: { jobId: row.id } }));
		return;
	}
	if (run.told) return;
	if (options.checkin && run.output.trim().toUpperCase().startsWith(NOTHING_TO_REPORT)) return;
	const delivery = row.delivery ?? 'changes';
	if (delivery === 'failures') return;
	if (delivery === 'changes') {
		const previous = jobQueries.lastSettledRun(row.id, run.id);
		if (previous?.status === 'succeeded' && sameResult(previous.output ?? '', run.output)) return;
	}
	if (!run.output.trim()) return;
	void tellOwner({ text: run.output, title: row.name, refs: { jobId: row.id, projectId: row.project_id } });
}

async function execute(row: JobRow, runId: string, context: string | undefined, controller: AbortController): Promise<{ result: RunResult; trace: RecipeTraceEntry[] }> {
	let job = toJob(row);
	const budget = job.budgetUsd ? { limitUsd: job.budgetUsd, spentBefore: jobQueries.spentSince(job.id, startOfToday()) } : null;
	let lastProgress = 0;
	const allTrace: RecipeTraceEntry[] = [];
	let progressTimer: ReturnType<typeof setTimeout> | null = null;
	let latest: { trace: RecipeTraceEntry[]; costUsd: number } | null = null;
	// At most once a second, the latest always written — a step that starts right after another ended is still shown.
	const flushProgress = () => {
		if (!latest) return;
		lastProgress = Date.now();
		jobQueries.setRunTrace(runId, [...allTrace, ...latest.trace], latest.costUsd);
		latest = null;
		notifyAssistantChanged('automations', job.id);
	};
	const onProgress = (trace: RecipeTraceEntry[], costUsd: number) => {
		latest = { trace: [...trace], costUsd };
		const wait = lastProgress + 1000 - Date.now();
		if (wait <= 0) flushProgress();
		else progressTimer ??= setTimeout(() => {
			progressTimer = null;
			flushProgress();
		}, wait);
	};
	const frequent = isFrequent(row.trigger_type as JobTriggerType, job.trigger.config as unknown as Record<string, unknown>);
	const scope = () => ({ kind: 'flow' as const, title: job.name, ownerId: job.id, projectId: job.projectId, notes: job.notes, context, frequent });

	let result = await runRecipe(job.recipe, scope(), { signal: controller.signal, onProgress, budget });
	if (!result.ok && result.outcome === 'failed' && !/budget/i.test(result.error ?? '')) {
		const repair = await repairRecipe(job, result);
		if (repair.retry) {
			allTrace.push(...result.trace.map((entry) => ({ ...entry, status: entry.status === 'failed' ? ('repaired' as const) : entry.status })));
			job = toJob(jobQueries.getById(row.id)!);
			const first = result.costUsd;
			result = await runRecipe(job.recipe, scope(), { signal: controller.signal, onProgress, budget: budget ? { ...budget, spentBefore: budget.spentBefore + first } : null });
			result = { ...result, costUsd: result.costUsd + first };
			if (repair.rewritten) void say(row, `${job.name} hit a problem and fixed itself${repair.lesson ? `: ${repair.lesson}` : ''}.`).then((text) => tellOwner({ text, refs: { jobId: job.id } }));
		}
	}
	// The run is over: a progress write still waiting would put an older trace over the final one.
	if (progressTimer) clearTimeout(progressTimer);
	latest = null;
	return { result, trace: [...allTrace, ...result.trace] };
}

export async function runJob(jobId: string, reason: string, context?: string): Promise<{ runId: string | null; skipped?: string }> {
	const row = jobQueries.getById(jobId);
	if (!row) throw new Error('That flow does not exist.');
	if (jobQueries.hasRunningRun(jobId)) {
		if ((row.overlap_policy ?? 'skip') === 'wait') {
			deferred.set(jobId, { reason, context });
			return { runId: null, skipped: 'Waiting for the current run to end.' };
		}
		// Not recorded as a run: a skipped start is not news, and a row per tick
		// would bury the runs that happened.
		return { runId: null, skipped: 'The previous run is still going.' };
	}
	const run = jobQueries.startRun(jobId, reason);
	jobQueries.setSchedule(jobId, new Date().toISOString(), row.next_run_at);
	notifyAssistantChanged('automations', jobId);
	const controller = new AbortController();
	active.set(run.id, { jobId, controller });

	void (async () => {
		try {
			const { result, trace } = await execute(row, run.id, context, controller);
			const overBudget = /budget/i.test(result.error ?? '');
			jobQueries.finishRun(run.id, {
				status: result.ok ? 'succeeded' : result.cancelled ? 'skipped' : 'failed',
				output: result.output,
				error: result.cancelled ? 'Stopped' : result.error,
				trace,
				costUsd: result.costUsd
			});
			if (overBudget) {
				jobQueries.update(jobId, { enabled: false });
				void say(row, `${row.name} is paused: ${result.error}`).then((text) => tellOwner({ text, refs: { jobId } }));
			} else if (!result.cancelled) {
				deliverResult(row, { id: run.id, ok: result.ok, output: result.output, error: result.error, told: result.told }, { checkin: row.trigger_type === 'checkin' });
			}
			if (result.ok) {
				const note = await considerFreezing(jobId, result);
				if (note) void say(row, `${row.name}: ${note}`).then((text) => tellOwner({ text, refs: { jobId } }));
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			jobQueries.finishRun(run.id, { status: 'failed', error: message });
			deliverResult(row, { id: run.id, ok: false, output: '', error: message, told: false });
		} finally {
			active.delete(run.id);
			notifyAssistantChanged('automations', jobId);
			startDeferred(jobId);
		}
	})();
	return { runId: run.id };
}

function startDeferred(jobId: string): void {
	const next = deferred.get(jobId);
	if (!next || jobQueries.hasRunningRun(jobId)) return;
	deferred.delete(jobId);
	void runJob(jobId, next.reason, next.context).catch((error) => debug.warn('jobs', 'Starting a waiting run failed:', error));
}

/** Stop running flows — one flow's, or all. Returns how many were stopped. */
export function stopFlowRuns(jobId?: string): number {
	let stopped = 0;
	for (const [runId, entry] of active) {
		if (jobId && entry.jobId !== jobId) continue;
		entry.controller.abort();
		deferred.delete(entry.jobId);
		active.delete(runId);
		stopped += 1;
	}
	return stopped;
}

export function initJobRunner(): void {
	const closed = jobQueries.closeOrphanedRuns();
	if (closed > 0) debug.log('jobs', `Closed ${closed} flow run(s) left open by a previous process`);
}
