import type { Recipe, RecipeTraceEntry } from './recipe';
/**
 * The Clopen assistant (v0.5) — shared shapes for missions, jobs, the inbox,
 * scripts, recordings and the control audit. Rows are mapped to these on the
 * server, so the frontend never sees JSON-in-a-column.
 */

/** How much the assistant does before asking. */
export type AssistantAutonomy = 'autonomous' | 'ask';

export interface AssistantSettings {
	/** `autonomous` (default): work until done; `ask`: discuss and get approval first. */
	autonomy: AssistantAutonomy;
	/** When true, even irreversible actions run without an Inbox approval. */
	allowIrreversible: boolean;
}

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
	autonomy: 'autonomous',
	allowIrreversible: false
};

// ── Missions ───────────────────────────────────────────────────────────────

export type MissionStatus = 'active' | 'paused' | 'stalled' | 'completed' | 'failed' | 'cancelled';

export interface MissionCriterion {
	text: string;
	done: boolean;
}

export interface Mission {
	id: string;
	title: string;
	goal: string;
	criteria: MissionCriterion[];
	status: MissionStatus;
	autonomy: AssistantAutonomy;
	assistantSessionId: string | null;
	jobId: string | null;
	iteration: number;
	stallCount: number;
	summary: string | null;
	/** The crew's recipe, when the task runs one (most do). */
	recipe: Recipe | null;
	/** What each step of the crew did so far. */
	trace: RecipeTraceEntry[];
	/** The steps under way right now (the trace has a step only once it ended). */
	runningSteps: string[];
	createdAt: string;
	updatedAt: string;
	finishedAt: string | null;
	/** Sessions this mission opened or drives, with their projects. */
	sessions: Array<{ sessionId: string; projectId: string; role: string | null; busy: boolean }>;
}

export type MissionEventKind =
	| 'created'
	| 'prompt'
	| 'turn-finished'
	| 'question'
	| 'answer'
	| 'verdict'
	| 'stalled'
	| 'status'
	| 'note';

export interface MissionEvent {
	id: number;
	missionId: string;
	kind: MissionEventKind;
	text: string;
	data: Record<string, unknown>;
	sessionId: string | null;
	projectId: string | null;
	createdAt: string;
}

// ── Flows (stored as jobs) ─────────────────────────────────────────────────

export type JobTriggerType = 'schedule' | 'once' | 'event' | 'watch' | 'checkin' | 'manual';
/** `recipe` for every flow made since recipes; the others are read as one-step recipes. */
export type JobActionType = 'recipe' | 'prompt' | 'skill' | 'script' | 'mission';
export type JobMissedPolicy = 'run-once' | 'skip';
/** When the previous run is still going: skip this one, or run once right after it. */
export type JobOverlapPolicy = 'skip' | 'wait';
/** When a run's result reaches the owner: every time, only when it changed, or only on failure. */
export type JobDelivery = 'always' | 'changes' | 'failures';

export interface ScheduleTrigger {
	/** Five-field cron expression (or @hourly/@daily/@weekly/@monthly), in the server's local time. */
	cron: string;
}

/** Run once at a moment, then switch off. */
export interface OnceTrigger {
	at: string;
}

export interface EventTrigger {
	/** Integration provider whose verified webhooks start this job (e.g. `github`). */
	provider: string;
	/** Optional event name filter, matched against the provider's event header. */
	event?: string;
}

export type WatchTarget =
	| { kind: 'url'; url: string }
	| { kind: 'file'; path: string };

export interface WatchTrigger {
	target: WatchTarget;
	/** How often to look, in minutes. */
	everyMinutes: number;
}

export interface CheckinTrigger {
	everyMinutes: number;
	/** What the assistant checks on every visit, in plain words. */
	checklist: string;
}

export type JobTrigger =
	| { type: 'schedule'; config: ScheduleTrigger }
	| { type: 'once'; config: OnceTrigger }
	| { type: 'manual'; config: Record<string, never> }
	| { type: 'event'; config: EventTrigger }
	| { type: 'watch'; config: WatchTrigger }
	| { type: 'checkin'; config: CheckinTrigger };

export interface JobActionConfig {
	/** prompt / mission: what to ask. */
	prompt?: string;
	/** skill: which skill to run, and its arguments. */
	skill?: string;
	skillArgs?: string;
	/** script: which script, and its arguments. */
	scriptId?: string;
	scriptArgs?: string[];
}

export interface Job {
	id: string;
	name: string;
	description: string;
	trigger: JobTrigger;
	actionType: JobActionType;
	action: JobActionConfig;
	projectId: string | null;
	enabled: boolean;
	missedPolicy: JobMissedPolicy;
	overlapPolicy: JobOverlapPolicy;
	delivery: JobDelivery;
	/** What the flow does — every flow is a recipe (older action types are read as one). */
	recipe: Recipe;
	/** Lessons from earlier runs, fed to its AI steps. */
	notes: string[];
	version: number;
	/** Optional spend cap per day, in USD. */
	budgetUsd: number | null;
	/** Successful runs per step path, and how often its output stayed the same. */
	stats: Record<string, { ok: number; same: number; last?: string }>;
	createdBy: 'user' | 'assistant';
	lastRunAt: string | null;
	nextRunAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export type JobRunStatus = 'running' | 'succeeded' | 'failed' | 'skipped';

export interface JobRun {
	id: string;
	jobId: string;
	status: JobRunStatus;
	reason: string;
	output: string;
	error: string | null;
	missionId: string | null;
	sessionId: string | null;
	trace: RecipeTraceEntry[];
	/** The steps under way right now, while the run runs. */
	runningSteps: string[];
	costUsd: number;
	startedAt: string;
	finishedAt: string | null;
}

// ── Inbox ──────────────────────────────────────────────────────────────────

export type InboxKind = 'question' | 'approval' | 'report' | 'learned' | 'stalled' | 'suggestion';
export type InboxStatus = 'open' | 'resolved' | 'dismissed';

export interface InboxItem {
	id: string;
	kind: InboxKind;
	title: string;
	body: string;
	data: Record<string, unknown>;
	status: InboxStatus;
	missionId: string | null;
	jobId: string | null;
	sessionId: string | null;
	projectId: string | null;
	resolution: Record<string, unknown> | null;
	createdAt: string;
	resolvedAt: string | null;
	/** Which of Clopen's chats it belongs to (set when listed for the web). */
	chatId?: string;
}

// ── Scripts ────────────────────────────────────────────────────────────────

export type ScriptRuntime = 'bash' | 'bun';
export type ScriptSource = 'user' | 'assistant' | 'recording' | 'detected';

export interface ScriptParam {
	name: string;
	description: string;
}

export interface Script {
	id: string;
	slug: string;
	name: string;
	description: string;
	runtime: ScriptRuntime;
	content: string;
	params: ScriptParam[];
	projectId: string | null;
	source: ScriptSource;
	enabled: boolean;
	runCount: number;
	lastRunAt: string | null;
	lastExitCode: number | null;
	createdAt: string;
	updatedAt: string;
}

export interface ScriptRunResult {
	exitCode: number;
	output: string;
	durationMs: number;
	timedOut: boolean;
}

// ── Skill versions ─────────────────────────────────────────────────────────

export interface SkillVersion {
	id: number;
	skillSlug: string;
	version: number;
	content: string;
	note: string;
	createdBy: 'user' | 'assistant';
	createdAt: string;
}

// ── Recordings (teach a task) ──────────────────────────────────────────────

export type RecordedStep =
	| { type: 'navigate'; url: string; at: number }
	| { type: 'click'; x: number; y: number; target: string | null; url: string | null; at: number }
	| { type: 'type'; text: string; target: string | null; at: number }
	| { type: 'key'; key: string; at: number }
	| { type: 'scroll'; deltaY: number; at: number };

export interface TaskRecording {
	id: string;
	projectId: string;
	name: string;
	steps: RecordedStep[];
	status: 'recording' | 'stopped' | 'saved';
	createdAt: string;
	updatedAt: string;
}

// ── Control audit ──────────────────────────────────────────────────────────

export type ControlRisk = 'read' | 'write' | 'irreversible';
export type ControlOutcome = 'ok' | 'error' | 'blocked' | 'pending';

export interface ControlAuditEntry {
	id: number;
	actor: string;
	sessionId: string | null;
	projectId: string | null;
	action: string;
	args: Record<string, unknown>;
	risk: ControlRisk;
	outcome: ControlOutcome;
	error: string | null;
	createdAt: string;
}

// ── Database access for agents ─────────────────────────────────────────────

/** What an agent may do with one DB Client connection. Missing means `none`. */
export type DbAgentAccess = 'none' | 'schema' | 'read' | 'write';

/** The overview the assistant view and the sidebar badge read. */
export interface AssistantOverview {
	activeMissions: Mission[];
	openInbox: number;
	upcomingJobs: Job[];
	recentlyLearned: Array<{ kind: 'skill' | 'script'; name: string; at: string }>;
	/** Projects Clopen made for its tasks (the sidebar groups them apart). */
	createdProjectIds: string[];
}
