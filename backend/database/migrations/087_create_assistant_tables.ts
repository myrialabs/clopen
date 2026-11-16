import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';

export const description = 'Create the Clopen assistant tables: tasks, flows (recipes), inbox, scripts, skill versions, control audit, recordings and agent database access';

/**
 * The tables behind the Clopen assistant (v0.5).
 *
 * - `missions` / `mission_sessions` / `mission_events`: a task — a goal the
 *   assistant drives across one or more project sessions, usually by running a
 *   recipe (its crew: stages, specialists, reviews) — the sessions it opened
 *   with the specialist role each works as, and the timeline of what happened.
 * - `jobs` / `job_runs` / `recipe_versions`: flows — recipes that start on
 *   their own (a schedule, a one-off time, an inbound event, something watched
 *   changing, a check-in). A recipe is a list of steps with branches, loops and
 *   reviews; it keeps lessons from earlier runs (`notes`), per-step success
 *   counts (`stats`), an optional daily spend cap, and every revision. Each run
 *   keeps a per-step trace and its cost. Trigger and action types are not
 *   CHECK-constrained: they grow with the recipe engine.
 * - `chat_sessions.origin`: who opened a chat — the owner, a task, a flow or
 *   Clopen — so runs do not fill the owner's chat history.
 * - `inbox_items`: everything that needs the owner's eyes — questions,
 *   approvals, reports, and things the assistant learned.
 * - `scripts`: deterministic automations the assistant (or the owner) saved, so
 *   repeated work stops costing tokens.
 * - `skill_versions`: every revision of a skill, so a skill the assistant
 *   improved can be compared and reverted.
 * - `control_audit`: one row per action an agent ran through the control
 *   surface — who, what, how risky, and how it ended.
 * - `task_recordings`: interactions recorded in the Preview Browser, turned into
 *   skills or scripts ("teach a task").
 * - `db_agent_access`: what an agent may do with each DB Client connection.
 *   Kept beside the connection rather than on it, so the connection row (and
 *   every mapper that reads it) is untouched; a missing row means `none`.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Creating assistant tables...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS missions (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			goal TEXT NOT NULL,
			criteria TEXT NOT NULL DEFAULT '[]',
			status TEXT NOT NULL DEFAULT 'active'
				CHECK (status IN ('active', 'paused', 'stalled', 'completed', 'failed', 'cancelled')),
			autonomy TEXT NOT NULL DEFAULT 'autonomous' CHECK (autonomy IN ('autonomous', 'ask')),
			assistant_session_id TEXT,
			job_id TEXT,
			iteration INTEGER NOT NULL DEFAULT 0,
			stall_count INTEGER NOT NULL DEFAULT 0,
			last_signature TEXT,
			summary TEXT,
			recipe TEXT,
			trace TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			finished_at TEXT
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status, updated_at DESC)`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS mission_sessions (
			mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
			session_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			role TEXT,
			created_at TEXT NOT NULL,
			PRIMARY KEY (mission_id, session_id)
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_sessions_session ON mission_sessions(session_id)`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS mission_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
			kind TEXT NOT NULL,
			text TEXT NOT NULL DEFAULT '',
			data TEXT NOT NULL DEFAULT '{}',
			session_id TEXT,
			project_id TEXT,
			created_at TEXT NOT NULL
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_events_mission ON mission_events(mission_id, id)`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			trigger_type TEXT NOT NULL,
			trigger_config TEXT NOT NULL DEFAULT '{}',
			action_type TEXT NOT NULL DEFAULT 'recipe',
			action_config TEXT NOT NULL DEFAULT '{}',
			project_id TEXT,
			is_enabled INTEGER NOT NULL DEFAULT 1,
			missed_policy TEXT NOT NULL DEFAULT 'run-once' CHECK (missed_policy IN ('run-once', 'skip')),
			watch_state TEXT,
			created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'assistant')),
			overlap_policy TEXT NOT NULL DEFAULT 'skip' CHECK (overlap_policy IN ('skip', 'wait')),
			delivery TEXT NOT NULL DEFAULT 'changes' CHECK (delivery IN ('always', 'changes', 'failures')),
			recipe TEXT,
			notes TEXT NOT NULL DEFAULT '[]',
			version INTEGER NOT NULL DEFAULT 0,
			budget_usd REAL,
			stats TEXT NOT NULL DEFAULT '{}',
			last_run_at TEXT,
			next_run_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_next_run ON jobs(is_enabled, next_run_at)`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS recipe_versions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
			version INTEGER NOT NULL,
			recipe TEXT NOT NULL,
			note TEXT NOT NULL DEFAULT '',
			created_by TEXT NOT NULL DEFAULT 'assistant',
			created_at TEXT NOT NULL
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_recipe_versions_job ON recipe_versions(job_id, version)`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS job_runs (
			id TEXT PRIMARY KEY,
			job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
			status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
			reason TEXT NOT NULL DEFAULT 'schedule',
			output TEXT NOT NULL DEFAULT '',
			error TEXT,
			mission_id TEXT,
			session_id TEXT,
			trace TEXT NOT NULL DEFAULT '[]',
			cost_usd REAL NOT NULL DEFAULT 0,
			started_at TEXT NOT NULL,
			finished_at TEXT
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job_id, started_at DESC)`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS inbox_items (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL CHECK (kind IN ('question', 'approval', 'report', 'learned', 'stalled', 'suggestion')),
			title TEXT NOT NULL,
			body TEXT NOT NULL DEFAULT '',
			data TEXT NOT NULL DEFAULT '{}',
			status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
			mission_id TEXT,
			job_id TEXT,
			session_id TEXT,
			project_id TEXT,
			resolution TEXT,
			created_at TEXT NOT NULL,
			resolved_at TEXT
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_items(status, created_at DESC)`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS scripts (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			runtime TEXT NOT NULL DEFAULT 'bash' CHECK (runtime IN ('bash', 'bun')),
			content TEXT NOT NULL,
			params TEXT NOT NULL DEFAULT '[]',
			project_id TEXT,
			source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'assistant', 'recording', 'detected')),
			is_enabled INTEGER NOT NULL DEFAULT 1,
			run_count INTEGER NOT NULL DEFAULT 0,
			last_run_at TEXT,
			last_exit_code INTEGER,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);
	db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_scripts_slug_scope ON scripts(slug, IFNULL(project_id, ''))`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS skill_versions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			skill_slug TEXT NOT NULL,
			version INTEGER NOT NULL,
			content TEXT NOT NULL,
			note TEXT NOT NULL DEFAULT '',
			created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'assistant')),
			created_at TEXT NOT NULL,
			UNIQUE (skill_slug, version)
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS control_audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			actor TEXT NOT NULL,
			session_id TEXT,
			project_id TEXT,
			action TEXT NOT NULL,
			args TEXT NOT NULL DEFAULT '{}',
			risk TEXT NOT NULL CHECK (risk IN ('read', 'write', 'irreversible')),
			outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'blocked', 'pending')),
			error TEXT,
			created_at TEXT NOT NULL
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_control_audit_created ON control_audit(created_at DESC)`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS task_recordings (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL,
			name TEXT NOT NULL DEFAULT '',
			steps TEXT NOT NULL DEFAULT '[]',
			status TEXT NOT NULL DEFAULT 'recording' CHECK (status IN ('recording', 'stopped', 'saved')),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS db_agent_access (
			connection_id TEXT PRIMARY KEY REFERENCES db_client_connections(id) ON DELETE CASCADE,
			access TEXT NOT NULL DEFAULT 'none' CHECK (access IN ('none', 'schema', 'read', 'write')),
			updated_at TEXT NOT NULL
		)
	`);

	const hasOrigin = (db.prepare(`PRAGMA table_info(chat_sessions)`).all() as Array<{ name: string }>).some((column) => column.name === 'origin');
	if (!hasOrigin) db.exec(`ALTER TABLE chat_sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'owner'`);

	debug.log('migration', '✅ Assistant tables created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Dropping assistant tables...');
	for (const table of [
		'db_agent_access',
		'task_recordings',
		'control_audit',
		'skill_versions',
		'scripts',
		'inbox_items',
		'recipe_versions',
		'job_runs',
		'jobs',
		'mission_events',
		'mission_sessions',
		'missions'
	]) {
		db.exec(`DROP TABLE IF EXISTS ${table}`);
	}
	const hasOrigin = (db.prepare(`PRAGMA table_info(chat_sessions)`).all() as Array<{ name: string }>).some((column) => column.name === 'origin');
	if (hasOrigin) db.exec('ALTER TABLE chat_sessions DROP COLUMN origin');
	debug.log('migration', '✅ Assistant tables dropped');
};
