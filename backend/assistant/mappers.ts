/**
 * Rows → the shared shapes the UI and agents read. JSON columns are parsed
 * here, once, so nothing downstream handles a string that should be an object.
 */

import {
	missionQueries,
	parseCriteria,
	parseParams,
	type InboxItemRow,
	type JobRow,
	type JobRunRow,
	type MissionEventRow,
	type MissionRow,
	type ScriptRow,
	type TaskRecordingRow
} from '$backend/database/queries';
import { streamManager } from '$backend/chat/stream-manager';
import { runningSteps } from '$backend/recipes/live-steps';
import type { Recipe, RecipeTraceEntry } from '$shared/types/recipe';
import type {
	JobActionConfig,
	InboxItem,
	Job,
	JobRun,
	JobTrigger,
	Mission,
	MissionEvent,
	RecordedStep,
	Script,
	TaskRecording
} from '$shared/types/assistant';

export function parseObject(raw: string | null | undefined): Record<string, unknown> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

export function toMission(row: MissionRow): Mission {
	return {
		id: row.id,
		title: row.title,
		goal: row.goal,
		criteria: parseCriteria(row.criteria),
		status: row.status,
		autonomy: row.autonomy,
		assistantSessionId: row.assistant_session_id,
		jobId: row.job_id,
		iteration: row.iteration,
		stallCount: row.stall_count,
		summary: row.summary,
		recipe: (() => {
			try {
				return row.recipe ? (JSON.parse(row.recipe) as Recipe) : null;
			} catch {
				return null;
			}
		})(),
		trace: parseArray<RecipeTraceEntry>(row.trace),
		runningSteps: row.status === 'active' ? runningSteps(row.id) : [],
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		finishedAt: row.finished_at,
		sessions: missionQueries.sessionsOf(row.id).map((link) => ({
			sessionId: link.session_id,
			projectId: link.project_id,
			role: link.role ?? null,
			busy: streamManager.getSessionStream(link.session_id, link.project_id)?.status === 'active'
		}))
	};
}

export function toMissionEvent(row: MissionEventRow): MissionEvent {
	return {
		id: row.id,
		missionId: row.mission_id,
		kind: row.kind,
		text: row.text,
		data: parseObject(row.data),
		sessionId: row.session_id,
		projectId: row.project_id,
		createdAt: row.created_at
	};
}

/** Flows made before recipes stored one action; they read as a one-step recipe. */
function legacyRecipe(row: JobRow, config: Record<string, unknown>): Recipe {
	const action = parseObject(row.action_config) as JobActionConfig;
	const where = row.project_id ? { project: row.project_id } : {};
	if (row.trigger_type === 'checkin') {
		return {
			title: row.name,
			steps: [
				{
					kind: 'do',
					goal: `Go through this checklist now, looking rather than assuming:\n${String(config.checklist ?? '')}\nIf nothing needs the owner's attention, answer exactly "NOTHING TO REPORT". Otherwise say briefly what needs attention and what you already did.`,
					name: 'checkin'
				}
			]
		};
	}
	switch (row.action_type) {
		case 'script':
			return { title: row.name, steps: [{ kind: 'run', script: action.scriptId ?? '', args: action.scriptArgs ?? [], name: 'result' }] };
		case 'skill':
			return { title: row.name, steps: [{ kind: 'do', goal: `/${action.skill ?? ''}${action.skillArgs ? ` ${action.skillArgs}` : ''}`, ...where, name: 'result' }] };
		case 'mission':
			return { title: row.name, steps: [{ kind: 'do', goal: `Start a task for this goal and drive it to done: ${action.prompt ?? ''}`, name: 'result' }] };
		default:
			return { title: row.name, steps: [{ kind: 'do', goal: action.prompt ?? row.description ?? row.name, ...where, name: 'result' }] };
	}
}

function parseArray<T>(raw: string | null | undefined): T[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch {
		return [];
	}
}

export function toJob(row: JobRow): Job {
	const config = parseObject(row.trigger_config);
	let recipe: Recipe | null = null;
	if (row.recipe) {
		try {
			recipe = JSON.parse(row.recipe) as Recipe;
		} catch {
			recipe = null;
		}
	}
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		trigger: { type: row.trigger_type, config } as unknown as JobTrigger,
		actionType: row.action_type,
		action: parseObject(row.action_config),
		projectId: row.project_id,
		enabled: row.is_enabled === 1,
		missedPolicy: row.missed_policy,
		overlapPolicy: row.overlap_policy ?? 'skip',
		delivery: row.delivery ?? 'changes',
		recipe: recipe ?? legacyRecipe(row, config),
		notes: parseArray<string>(row.notes),
		version: row.version ?? 0,
		budgetUsd: row.budget_usd ?? null,
		stats: parseObject(row.stats) as Job['stats'],
		createdBy: row.created_by,
		lastRunAt: row.last_run_at,
		nextRunAt: row.next_run_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export function toJobRun(row: JobRunRow): JobRun {
	return {
		id: row.id,
		jobId: row.job_id,
		status: row.status,
		reason: row.reason,
		output: row.output,
		error: row.error,
		missionId: row.mission_id,
		sessionId: row.session_id,
		trace: parseArray<RecipeTraceEntry>(row.trace),
		runningSteps: row.status === 'running' ? runningSteps(row.job_id) : [],
		costUsd: row.cost_usd ?? 0,
		startedAt: row.started_at,
		finishedAt: row.finished_at
	};
}

export function toInboxItem(row: InboxItemRow): InboxItem {
	return {
		id: row.id,
		kind: row.kind,
		title: row.title,
		body: row.body,
		data: parseObject(row.data),
		status: row.status,
		missionId: row.mission_id,
		jobId: row.job_id,
		sessionId: row.session_id,
		projectId: row.project_id,
		resolution: row.resolution ? parseObject(row.resolution) : null,
		createdAt: row.created_at,
		resolvedAt: row.resolved_at
	};
}

export function toScript(row: ScriptRow): Script {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		runtime: row.runtime,
		content: row.content,
		params: parseParams(row.params),
		projectId: row.project_id,
		source: row.source,
		enabled: row.is_enabled === 1,
		runCount: row.run_count,
		lastRunAt: row.last_run_at,
		lastExitCode: row.last_exit_code,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export function toRecording(row: TaskRecordingRow): TaskRecording {
	let steps: RecordedStep[] = [];
	try {
		const parsed = JSON.parse(row.steps);
		if (Array.isArray(parsed)) steps = parsed as RecordedStep[];
	} catch {
		// A corrupt recording reads as empty.
	}
	return {
		id: row.id,
		projectId: row.project_id,
		name: row.name,
		steps,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}
