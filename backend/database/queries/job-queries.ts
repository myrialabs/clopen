/**
 * Jobs — work that starts on its own (a schedule, an inbound event, a watched
 * change, a periodic check-in) — and the record of every run.
 */

import { getDatabase } from '../index';
import type { JobActionType, JobDelivery, JobMissedPolicy, JobOverlapPolicy, JobRunStatus, JobTriggerType } from '$shared/types/assistant';

export interface JobRow {
	id: string;
	name: string;
	description: string;
	trigger_type: JobTriggerType;
	trigger_config: string;
	action_type: JobActionType;
	action_config: string;
	project_id: string | null;
	is_enabled: number;
	missed_policy: JobMissedPolicy;
	overlap_policy: JobOverlapPolicy;
	delivery: JobDelivery;
	recipe: string | null;
	notes: string;
	version: number;
	budget_usd: number | null;
	stats: string;
	watch_state: string | null;
	created_by: 'user' | 'assistant';
	last_run_at: string | null;
	next_run_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface JobRunRow {
	id: string;
	job_id: string;
	status: JobRunStatus;
	reason: string;
	output: string;
	error: string | null;
	mission_id: string | null;
	session_id: string | null;
	trace: string;
	cost_usd: number;
	started_at: string;
	finished_at: string | null;
}

export interface JobInput {
	name: string;
	description?: string;
	triggerType: JobTriggerType;
	triggerConfig: Record<string, unknown>;
	actionType: JobActionType;
	actionConfig: Record<string, unknown>;
	projectId?: string | null;
	enabled?: boolean;
	missedPolicy?: JobMissedPolicy;
	overlapPolicy?: JobOverlapPolicy;
	delivery?: JobDelivery;
	recipe?: string | null;
	budgetUsd?: number | null;
	createdBy?: 'user' | 'assistant';
	nextRunAt?: string | null;
}

/** Output kept per run — enough to read what happened, not a log archive. */
const MAX_RUN_OUTPUT = 20_000;
/** Runs kept per job; older ones are pruned as new ones start. */
const RUNS_KEPT = 50;

export const jobQueries = {
	create(input: JobInput): JobRow {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO jobs (id, name, description, trigger_type, trigger_config, action_type, action_config, project_id,
				is_enabled, missed_policy, overlap_policy, delivery, recipe, budget_usd, created_by, next_run_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			id,
			input.name,
			input.description ?? '',
			input.triggerType,
			JSON.stringify(input.triggerConfig),
			input.actionType,
			JSON.stringify(input.actionConfig),
			input.projectId ?? null,
			input.enabled === false ? 0 : 1,
			input.missedPolicy ?? 'run-once',
			input.overlapPolicy ?? 'skip',
			input.delivery ?? 'changes',
			input.recipe ?? null,
			input.budgetUsd ?? null,
			input.createdBy ?? 'user',
			input.nextRunAt ?? null,
			now,
			now
		);
		return jobQueries.getById(id)!;
	},

	getById(id: string): JobRow | null {
		return (getDatabase().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined) ?? null;
	},

	list(): JobRow[] {
		return getDatabase().prepare('SELECT * FROM jobs ORDER BY created_at DESC').all() as JobRow[];
	},

	listEnabled(): JobRow[] {
		return getDatabase().prepare('SELECT * FROM jobs WHERE is_enabled = 1').all() as JobRow[];
	},

	update(id: string, patch: Partial<JobInput>): JobRow | null {
		const db = getDatabase();
		const sets: string[] = [];
		const values: unknown[] = [];
		const put = (column: string, value: unknown) => {
			sets.push(`${column} = ?`);
			values.push(value);
		};
		if (patch.name !== undefined) put('name', patch.name);
		if (patch.description !== undefined) put('description', patch.description);
		if (patch.triggerType !== undefined) put('trigger_type', patch.triggerType);
		if (patch.triggerConfig !== undefined) put('trigger_config', JSON.stringify(patch.triggerConfig));
		if (patch.actionType !== undefined) put('action_type', patch.actionType);
		if (patch.actionConfig !== undefined) put('action_config', JSON.stringify(patch.actionConfig));
		if (patch.projectId !== undefined) put('project_id', patch.projectId);
		if (patch.enabled !== undefined) put('is_enabled', patch.enabled ? 1 : 0);
		if (patch.missedPolicy !== undefined) put('missed_policy', patch.missedPolicy);
		if (patch.overlapPolicy !== undefined) put('overlap_policy', patch.overlapPolicy);
		if (patch.delivery !== undefined) put('delivery', patch.delivery);
		if (patch.recipe !== undefined) put('recipe', patch.recipe);
		if (patch.budgetUsd !== undefined) put('budget_usd', patch.budgetUsd);
		if (patch.nextRunAt !== undefined) put('next_run_at', patch.nextRunAt);
		if (sets.length === 0) return jobQueries.getById(id);
		put('updated_at', new Date().toISOString());
		db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
		return jobQueries.getById(id);
	},

	setSchedule(id: string, lastRunAt: string | null, nextRunAt: string | null): void {
		getDatabase()
			.prepare('UPDATE jobs SET last_run_at = COALESCE(?, last_run_at), next_run_at = ? WHERE id = ?')
			.run(lastRunAt, nextRunAt, id);
	},

	setWatchState(id: string, state: string | null): void {
		getDatabase().prepare('UPDATE jobs SET watch_state = ? WHERE id = ?').run(state, id);
	},

	delete(id: string): void {
		getDatabase().prepare('DELETE FROM jobs WHERE id = ?').run(id);
	},

	// ── Runs ──

	startRun(jobId: string, reason: string): JobRunRow {
		const db = getDatabase();
		const id = crypto.randomUUID();
		db.prepare(`INSERT INTO job_runs (id, job_id, status, reason, started_at) VALUES (?, ?, 'running', ?, ?)`).run(
			id,
			jobId,
			reason,
			new Date().toISOString()
		);
		db.prepare(
			`DELETE FROM job_runs WHERE job_id = ? AND id NOT IN (
				SELECT id FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?
			)`
		).run(jobId, jobId, RUNS_KEPT);
		return db.prepare('SELECT * FROM job_runs WHERE id = ?').get(id) as JobRunRow;
	},

	finishRun(
		id: string,
		result: {
			status: Exclude<JobRunStatus, 'running'>;
			output?: string;
			error?: string | null;
			missionId?: string | null;
			sessionId?: string | null;
			trace?: unknown[];
			costUsd?: number;
		}
	): void {
		const output = (result.output ?? '').slice(-MAX_RUN_OUTPUT);
		getDatabase()
			.prepare(
				`UPDATE job_runs SET status = ?, output = ?, error = ?, mission_id = COALESCE(?, mission_id),
					session_id = COALESCE(?, session_id), trace = COALESCE(?, trace), cost_usd = COALESCE(?, cost_usd), finished_at = ? WHERE id = ?`
			)
			.run(
				result.status,
				output,
				result.error ?? null,
				result.missionId ?? null,
				result.sessionId ?? null,
				result.trace ? JSON.stringify(result.trace).slice(0, 200_000) : null,
				result.costUsd ?? null,
				new Date().toISOString(),
				id
			);
	},

	/** Live progress of a running run: its trace so far. */
	setRunTrace(id: string, trace: unknown[], costUsd: number): void {
		getDatabase().prepare('UPDATE job_runs SET trace = ?, cost_usd = ? WHERE id = ?').run(JSON.stringify(trace).slice(0, 200_000), costUsd, id);
	},

	/** What the flow's runs cost since `sinceIso` — for the daily budget. */
	spentSince(jobId: string, sinceIso: string): number {
		const row = getDatabase().prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM job_runs WHERE job_id = ? AND started_at >= ?').get(jobId, sinceIso) as {
			total: number;
		};
		return row?.total ?? 0;
	},

	// ── Recipe, notes, stats, versions ──

	/** Save a new revision of the recipe: the current one moves into `recipe_versions`. */
	saveRecipe(id: string, recipe: unknown, note: string, createdBy: 'user' | 'assistant'): number {
		const db = getDatabase();
		const current = jobQueries.getById(id);
		if (!current) throw new Error('That flow does not exist.');
		const version = (current.version ?? 0) + 1;
		const json = JSON.stringify(recipe);
		db.prepare(`INSERT INTO recipe_versions (job_id, version, recipe, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
			id,
			version,
			json,
			note,
			createdBy,
			new Date().toISOString()
		);
		db.prepare('UPDATE jobs SET recipe = ?, version = ?, action_type = ?, updated_at = ? WHERE id = ?').run(json, version, 'recipe', new Date().toISOString(), id);
		return version;
	},

	setVersionNote(id: string, version: number, note: string): void {
		getDatabase().prepare('UPDATE recipe_versions SET note = ? WHERE job_id = ? AND version = ?').run(note, id, version);
	},

	versionsOf(id: string, limit = 30): Array<{ version: number; note: string; created_by: string; created_at: string; recipe: string }> {
		return getDatabase()
			.prepare('SELECT version, note, created_by, created_at, recipe FROM recipe_versions WHERE job_id = ? ORDER BY version DESC LIMIT ?')
			.all(id, limit) as Array<{ version: number; note: string; created_by: string; created_at: string; recipe: string }>;
	},

	setNotes(id: string, notes: string[]): void {
		getDatabase().prepare('UPDATE jobs SET notes = ? WHERE id = ?').run(JSON.stringify(notes.slice(-30)), id);
	},

	setStats(id: string, stats: Record<string, unknown>): void {
		getDatabase().prepare('UPDATE jobs SET stats = ? WHERE id = ?').run(JSON.stringify(stats), id);
	},

	/** The session a still-running run is waiting on. */
	attachRunSession(id: string, sessionId: string): void {
		getDatabase().prepare('UPDATE job_runs SET session_id = ? WHERE id = ?').run(sessionId, id);
	},

	/** Whether ANY run of this job is still going — not just the latest. */
	hasRunningRun(jobId: string): boolean {
		return Boolean(getDatabase().prepare(`SELECT 1 FROM job_runs WHERE job_id = ? AND status = 'running' LIMIT 1`).get(jobId));
	},

	/** The latest finished run that was not skipped — what "did it change / did it fail last time" compares against. */
	lastSettledRun(jobId: string, excludeId?: string): JobRunRow | null {
		return (
			(getDatabase()
				.prepare(`SELECT * FROM job_runs WHERE job_id = ? AND status IN ('succeeded', 'failed') AND id != ? ORDER BY started_at DESC LIMIT 1`)
				.get(jobId, excludeId ?? '') as JobRunRow | undefined) ?? null
		);
	},

	runsOf(jobId: string, limit = 20): JobRunRow[] {
		return getDatabase()
			.prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?')
			.all(jobId, limit) as JobRunRow[];
	},

	/** Runs left `running` by a process that died — closed at startup. */
	closeOrphanedRuns(): number {
		const result = getDatabase()
			.prepare(`UPDATE job_runs SET status = 'failed', error = 'Clopen stopped while this run was in progress', finished_at = ? WHERE status = 'running'`)
			.run(new Date().toISOString()) as { changes: number | bigint };
		return Number(result.changes ?? 0);
	}
};
