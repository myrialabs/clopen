/**
 * Flows (stored as jobs) — recipes that start on their own.
 *
 * Triggers:
 *   - schedule: a cron expression in this computer's local time;
 *   - once:     a single moment, then the flow switches itself off;
 *   - event:    a verified webhook from a connected integration (a GitHub push,
 *               a new issue…), optionally filtered by event name;
 *   - watch:    a URL or a file, looked at every N minutes; a change runs it;
 *   - checkin:  every N minutes the assistant goes through a checklist and
 *               only speaks up when something needs attention;
 *   - manual:   only when asked ("run it now", or as a step of another flow).
 *
 * What a flow does is its recipe (`shared/types/recipe.ts`), run by
 * `backend/recipes/engine.ts`. Every change to a recipe is a version.
 * This module validates and stores flows and works out when each runs next;
 * `runner.ts` runs them and `scheduler.ts` decides when.
 */

import { jobQueries, projectQueries, type JobInput } from '$backend/database/queries';
import type { Job, JobDelivery, JobMissedPolicy, JobOverlapPolicy, JobRun, JobTriggerType } from '$shared/types/assistant';
import type { Recipe } from '$shared/types/recipe';
import { normaliseRecipe, RecipeError, recipeToText } from '$shared/utils/recipe-text';
import { debug } from '$shared/utils/logger';
import { notifyAssistantChanged } from '$backend/assistant/events';
import { toJob, toJobRun } from '$backend/assistant/mappers';
import { describeCron, isValidCron, nextCronRun } from './cron';
import { describeAt, parseWhen, WHEN_EXAMPLES } from './when';

export interface JobDraft {
	name: string;
	description?: string;
	triggerType: JobTriggerType;
	trigger: Record<string, unknown>;
	/** The recipe — `{ title, steps }`, a list of steps, or recipe text. */
	recipe: Recipe | string | unknown;
	projectId?: string | null;
	budgetUsd?: number | null;
	enabled?: boolean;
	missedPolicy?: JobMissedPolicy;
	overlapPolicy?: JobOverlapPolicy;
	delivery?: JobDelivery;
	createdBy?: 'user' | 'assistant';
}

const MIN_INTERVAL_MINUTES = 1;

function minutes(value: unknown, name: string): number {
	const number = Number(value);
	if (!Number.isFinite(number) || number < MIN_INTERVAL_MINUTES) throw new Error(`${name} must be at least ${MIN_INTERVAL_MINUTES} minute.`);
	return Math.round(number);
}

/** Check a trigger and return it in its stored shape. */
export function normaliseTrigger(type: JobTriggerType, raw: Record<string, unknown>): Record<string, unknown> {
	switch (type) {
		case 'schedule': {
			const cron = String(raw.cron ?? '').trim();
			if (!isValidCron(cron)) throw new Error(`"${cron}" is not a valid schedule. Use five cron fields, e.g. "0 7 * * *" for 07:00 daily.`);
			return { cron };
		}
		case 'once': {
			const at = new Date(String(raw.at ?? ''));
			if (Number.isNaN(at.getTime())) throw new Error('A one-off flow needs a valid time.');
			return { at: at.toISOString() };
		}
		case 'manual':
			return {};
		case 'event': {
			const provider = String(raw.provider ?? '').trim();
			if (!provider) throw new Error('An event flow needs the integration provider whose events start it (e.g. github).');
			const event = raw.event ? String(raw.event).trim() : undefined;
			return { provider, ...(event ? { event } : {}) };
		}
		case 'watch': {
			const target = raw.target as { kind?: string; url?: string; path?: string } | undefined;
			if (target?.kind === 'url') {
				const url = String(target.url ?? '');
				if (!/^https?:\/\//.test(url)) throw new Error('A watched URL must start with http:// or https://.');
				return { target: { kind: 'url', url }, everyMinutes: minutes(raw.everyMinutes ?? 15, 'everyMinutes') };
			}
			if (target?.kind === 'file') {
				const path = String(target.path ?? '').trim();
				if (!path) throw new Error('A watched file needs a path.');
				return { target: { kind: 'file', path }, everyMinutes: minutes(raw.everyMinutes ?? 5, 'everyMinutes') };
			}
			throw new Error('A watch flow needs a target: { kind: "url", url } or { kind: "file", path }.');
		}
		case 'checkin': {
			const checklist = String(raw.checklist ?? '').trim();
			if (!checklist) throw new Error('A check-in needs a checklist: what to look at every time.');
			return { everyMinutes: minutes(raw.everyMinutes ?? 60, 'everyMinutes'), checklist };
		}
	}
}

/** When a job with this trigger runs next, from `from`. Event jobs have no clock. */
export function nextRunFor(type: JobTriggerType, trigger: Record<string, unknown>, from: Date = new Date()): string | null {
	if (type === 'schedule') return nextCronRun(String(trigger.cron), from)?.toISOString() ?? null;
	if (type === 'once') {
		const at = new Date(String(trigger.at));
		return at.getTime() > from.getTime() - 60_000 ? at.toISOString() : null;
	}
	if (type === 'watch' || type === 'checkin') return new Date(from.getTime() + Number(trigger.everyMinutes) * 60_000).toISOString();
	return null;
}

/** Flows that run more often than this tell the owner only what changed, in a line. */
export const FREQUENT_MINUTES = 5;

/** About how many minutes apart a flow runs, or null when it does not repeat on its own. */
export function intervalMinutes(type: JobTriggerType, trigger: Record<string, unknown>): number | null {
	if (type === 'watch' || type === 'checkin') return Number(trigger.everyMinutes) || null;
	if (type !== 'schedule') return null;
	const first = nextCronRun(String(trigger.cron ?? ''));
	const second = first ? nextCronRun(String(trigger.cron ?? ''), first) : null;
	return first && second ? Math.max(1, Math.round((second.getTime() - first.getTime()) / 60_000)) : null;
}

export function isFrequent(type: JobTriggerType, trigger: Record<string, unknown>): boolean {
	const every = intervalMinutes(type, trigger);
	return every !== null && every < FREQUENT_MINUTES;
}

/** A recipe from whatever shape the caller had, with errors that say what to fix. */
export function toRecipe(raw: unknown, title: string): Recipe {
	try {
		return normaliseRecipe(raw, title);
	} catch (error) {
		throw new Error(error instanceof RecipeError ? `The recipe is not valid: ${error.message}` : String(error));
	}
}

/** A trigger from plain English ("every day at 07:00", "in 10 minutes", a cron). */
export function triggerFromWhen(when: string): { triggerType: JobTriggerType; trigger: Record<string, unknown> } {
	const parsed = parseWhen(when);
	return parsed.kind === 'cron' ? { triggerType: 'schedule', trigger: { cron: parsed.cron } } : { triggerType: 'once', trigger: { at: parsed.at.toISOString() } };
}

export { WHEN_EXAMPLES };

/** "Every day at 07:00 (Asia/Jakarta)", "Once, Thu 9 Nov 15:48", "When github sends push"… */
export function describeTrigger(job: Pick<Job, 'trigger'>): string {
	switch (job.trigger.type) {
		case 'schedule':
			return describeCron(job.trigger.config.cron);
		case 'once':
			return `Once, ${describeAt(new Date(job.trigger.config.at))}`;
		case 'event':
			return `When ${job.trigger.config.provider} sends ${job.trigger.config.event ?? 'an event'}`;
		case 'watch':
			return `When ${job.trigger.config.target.kind === 'url' ? job.trigger.config.target.url : job.trigger.config.target.path} changes`;
		case 'checkin':
			return `Check-in every ${job.trigger.config.everyMinutes} min`;
		case 'manual':
			return 'When asked';
	}
}

export function createJob(draft: JobDraft): Job {
	if (!draft.name.trim()) throw new Error('A flow needs a name.');
	if (draft.projectId && !projectQueries.getById(draft.projectId)) throw new Error('That project does not exist.');
	const trigger = normaliseTrigger(draft.triggerType, draft.trigger);
	const recipe = toRecipe(draft.recipe, draft.name.trim());
	const input: JobInput = {
		name: draft.name.trim(),
		description: draft.description?.trim() ?? '',
		triggerType: draft.triggerType,
		triggerConfig: trigger,
		actionType: 'recipe',
		actionConfig: {},
		projectId: draft.projectId ?? null,
		enabled: draft.enabled ?? true,
		missedPolicy: draft.missedPolicy ?? 'run-once',
		overlapPolicy: draft.overlapPolicy ?? 'skip',
		delivery: draft.delivery ?? (draft.triggerType === 'checkin' || draft.triggerType === 'watch' || isFrequent(draft.triggerType, trigger) ? 'changes' : 'always'),
		budgetUsd: draft.budgetUsd ?? null,
		createdBy: draft.createdBy ?? 'user',
		nextRunAt: nextRunFor(draft.triggerType, trigger)
	};
	const row = jobQueries.create(input);
	jobQueries.saveRecipe(row.id, recipe, 'Created', draft.createdBy ?? 'user');
	notifyAssistantChanged('automations', row.id);
	return toJob(jobQueries.getById(row.id)!);
}

export function updateJob(id: string, patch: Partial<JobDraft> & { recipeNote?: string }): Job {
	const current = jobQueries.getById(id);
	if (!current) throw new Error('That flow does not exist.');
	const job = toJob(current);
	const triggerType = patch.triggerType ?? job.trigger.type;
	const trigger = patch.trigger || patch.triggerType ? normaliseTrigger(triggerType, patch.trigger ?? (job.trigger.config as unknown as Record<string, unknown>)) : null;
	const enabled = patch.enabled ?? job.enabled;
	if (patch.recipe !== undefined) {
		const next = toRecipe(patch.recipe, patch.name?.trim() || job.name);
		const before = recipeToText(job.recipe);
		const after = recipeToText(next);
		// The same recipe again is not a version.
		if (after !== before) {
			const note = patch.recipeNote?.trim();
			const version = jobQueries.saveRecipe(id, next, note || 'Edited', patch.createdBy ?? 'user');
			if (!note || GENERIC_NOTES.has(note)) void describeChange(id, version, before, after);
		}
	}
	const row = jobQueries.update(id, {
		name: patch.name?.trim(),
		description: patch.description,
		triggerType: patch.triggerType,
		triggerConfig: trigger ?? undefined,
		projectId: patch.projectId,
		enabled: patch.enabled,
		missedPolicy: patch.missedPolicy,
		overlapPolicy: patch.overlapPolicy,
		// Made to run every minute or two: from now on only what changed is news.
		delivery: patch.delivery ?? (trigger && isFrequent(triggerType, trigger) ? 'changes' : undefined),
		budgetUsd: patch.budgetUsd,
		...(trigger || patch.enabled !== undefined
			? { nextRunAt: enabled ? nextRunFor(triggerType, trigger ?? (job.trigger.config as unknown as Record<string, unknown>)) : null }
			: {})
	})!;
	// Switched off: a run in flight stops too, so nothing more arrives from it.
	if (patch.enabled === false) void import('./runner').then(({ stopFlowRuns }) => stopFlowRuns(id));
	notifyAssistantChanged('automations', id);
	return toJob(row);
}

/** Notes that say a version exists but not what it changed. */
const GENERIC_NOTES = new Set(['Edited', 'Edited by the owner', 'Changed by Clopen']);

/** Say what a version changed, in a line, so the history can be read without opening each one. */
async function describeChange(id: string, version: number, before: string, after: string): Promise<void> {
	try {
		const { think } = await import('$backend/assistant/think');
		const { note } = await think<{ note: string }>(
			[
				'A repeating task\'s plan changed. Before:',
				'<before>',
				before.slice(0, 5000),
				'</before>',
				'After:',
				'<after>',
				after.slice(0, 5000),
				'</after>',
				'Say what changed in one short line (at most 90 characters), in the language the plan is written for the owner in — e.g. "Sends at 08:00 instead of 07:00". No preamble.'
			].join('\n'),
			{ type: 'object', properties: { note: { type: 'string' } }, required: ['note'] }
		);
		if (note?.trim()) {
			jobQueries.setVersionNote(id, version, note.trim().slice(0, 140));
			notifyAssistantChanged('automations', id);
		}
	} catch (error) {
		debug.warn('jobs', 'Describing a flow change failed:', error);
	}
}

/** Put a flow's recipe back to an earlier version (itself saved as a new version). */
export function revertRecipe(id: string, version: number): Job {
	const entry = jobQueries.versionsOf(id, 500).find((row) => row.version === version);
	if (!entry) throw new Error(`There is no version ${version}.`);
	jobQueries.saveRecipe(id, JSON.parse(entry.recipe), `Back to version ${version}`, 'user');
	notifyAssistantChanged('automations', id);
	return toJob(jobQueries.getById(id)!);
}

export function deleteJob(id: string): void {
	void import('./hooks').then(({ forgetFlowHook }) => forgetFlowHook(id));
	void import('./runner').then(({ stopFlowRuns }) => stopFlowRuns(id));
	jobQueries.delete(id);
	notifyAssistantChanged('automations', id);
}

export function listJobs(): Job[] {
	return jobQueries.list().map(toJob);
}

export function getJob(id: string): Job | null {
	const row = jobQueries.getById(id);
	return row ? toJob(row) : null;
}

export function jobRuns(id: string, limit = 20): JobRun[] {
	return jobQueries.runsOf(id, limit).map(toJobRun);
}
