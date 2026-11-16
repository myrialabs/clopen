/**
 * The smaller assistant tables: skill revisions, the control audit, Preview
 * Browser recordings, and what an agent may do with each database connection.
 */

import { getDatabase } from '../index';
import type { ControlOutcome, ControlRisk, DbAgentAccess, RecordedStep } from '$shared/types/assistant';

export interface SkillVersionRow {
	id: number;
	skill_slug: string;
	version: number;
	content: string;
	note: string;
	created_by: 'user' | 'assistant';
	created_at: string;
}

export interface ControlAuditRow {
	id: number;
	actor: string;
	session_id: string | null;
	project_id: string | null;
	action: string;
	args: string;
	risk: ControlRisk;
	outcome: ControlOutcome;
	error: string | null;
	created_at: string;
}

export interface TaskRecordingRow {
	id: string;
	project_id: string;
	name: string;
	steps: string;
	status: 'recording' | 'stopped' | 'saved';
	created_at: string;
	updated_at: string;
}

/** Revisions kept per skill. */
const VERSIONS_KEPT = 30;
/** Audit rows kept — a trail, not an archive. */
const AUDIT_KEPT = 5000;

export const skillVersionQueries = {
	/** Record a revision; returns its version number. Identical consecutive content is not stored twice. */
	add(slug: string, content: string, note: string, createdBy: 'user' | 'assistant'): number {
		const db = getDatabase();
		const latest = skillVersionQueries.latest(slug);
		if (latest && latest.content === content) return latest.version;
		const version = (latest?.version ?? 0) + 1;
		db.prepare(
			'INSERT INTO skill_versions (skill_slug, version, content, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
		).run(slug, version, content, note, createdBy, new Date().toISOString());
		db.prepare(
			`DELETE FROM skill_versions WHERE skill_slug = ? AND version NOT IN (
				SELECT version FROM skill_versions WHERE skill_slug = ? ORDER BY version DESC LIMIT ?
			)`
		).run(slug, slug, VERSIONS_KEPT);
		return version;
	},

	latest(slug: string): SkillVersionRow | null {
		return (
			(getDatabase()
				.prepare('SELECT * FROM skill_versions WHERE skill_slug = ? ORDER BY version DESC LIMIT 1')
				.get(slug) as SkillVersionRow | undefined) ?? null
		);
	},

	list(slug: string): SkillVersionRow[] {
		return getDatabase()
			.prepare('SELECT * FROM skill_versions WHERE skill_slug = ? ORDER BY version DESC')
			.all(slug) as SkillVersionRow[];
	},

	get(slug: string, version: number): SkillVersionRow | null {
		return (
			(getDatabase()
				.prepare('SELECT * FROM skill_versions WHERE skill_slug = ? AND version = ?')
				.get(slug, version) as SkillVersionRow | undefined) ?? null
		);
	},

	deleteAll(slug: string): void {
		getDatabase().prepare('DELETE FROM skill_versions WHERE skill_slug = ?').run(slug);
	}
};

export const controlAuditQueries = {
	add(entry: {
		actor: string;
		sessionId: string | null;
		projectId: string | null;
		action: string;
		args: Record<string, unknown>;
		risk: ControlRisk;
		outcome: ControlOutcome;
		error?: string | null;
	}): void {
		const db = getDatabase();
		db.prepare(
			`INSERT INTO control_audit (actor, session_id, project_id, action, args, risk, outcome, error, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			entry.actor,
			entry.sessionId,
			entry.projectId,
			entry.action,
			JSON.stringify(entry.args).slice(0, 4000),
			entry.risk,
			entry.outcome,
			entry.error ?? null,
			new Date().toISOString()
		);
		db.prepare(`DELETE FROM control_audit WHERE id <= (SELECT MAX(id) FROM control_audit) - ?`).run(AUDIT_KEPT);
	},

	list(limit = 200): ControlAuditRow[] {
		return getDatabase().prepare('SELECT * FROM control_audit ORDER BY id DESC LIMIT ?').all(limit) as ControlAuditRow[];
	}
};

export const taskRecordingQueries = {
	create(projectId: string): TaskRecordingRow {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO task_recordings (id, project_id, name, steps, status, created_at, updated_at) VALUES (?, ?, '', '[]', 'recording', ?, ?)`
		).run(id, projectId, now, now);
		return taskRecordingQueries.getById(id)!;
	},

	getById(id: string): TaskRecordingRow | null {
		return (getDatabase().prepare('SELECT * FROM task_recordings WHERE id = ?').get(id) as TaskRecordingRow | undefined) ?? null;
	},

	activeForProject(projectId: string): TaskRecordingRow | null {
		return (
			(getDatabase()
				.prepare(`SELECT * FROM task_recordings WHERE project_id = ? AND status = 'recording' ORDER BY created_at DESC LIMIT 1`)
				.get(projectId) as TaskRecordingRow | undefined) ?? null
		);
	},

	list(projectId: string): TaskRecordingRow[] {
		return getDatabase()
			.prepare('SELECT * FROM task_recordings WHERE project_id = ? ORDER BY created_at DESC LIMIT 50')
			.all(projectId) as TaskRecordingRow[];
	},

	setSteps(id: string, steps: RecordedStep[]): void {
		getDatabase()
			.prepare('UPDATE task_recordings SET steps = ?, updated_at = ? WHERE id = ?')
			.run(JSON.stringify(steps), new Date().toISOString(), id);
	},

	setStatus(id: string, status: TaskRecordingRow['status'], name?: string): void {
		getDatabase()
			.prepare('UPDATE task_recordings SET status = ?, name = COALESCE(?, name), updated_at = ? WHERE id = ?')
			.run(status, name ?? null, new Date().toISOString(), id);
	},

	delete(id: string): void {
		getDatabase().prepare('DELETE FROM task_recordings WHERE id = ?').run(id);
	}
};

export const dbAgentAccessQueries = {
	get(connectionId: string): DbAgentAccess {
		const row = getDatabase().prepare('SELECT access FROM db_agent_access WHERE connection_id = ?').get(connectionId) as
			| { access: DbAgentAccess }
			| undefined;
		return row?.access ?? 'none';
	},

	all(): Record<string, DbAgentAccess> {
		const rows = getDatabase().prepare('SELECT connection_id, access FROM db_agent_access').all() as Array<{
			connection_id: string;
			access: DbAgentAccess;
		}>;
		return Object.fromEntries(rows.map((row) => [row.connection_id, row.access]));
	},

	set(connectionId: string, access: DbAgentAccess): void {
		getDatabase()
			.prepare(
				`INSERT INTO db_agent_access (connection_id, access, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(connection_id) DO UPDATE SET access = excluded.access, updated_at = excluded.updated_at`
			)
			.run(connectionId, access, new Date().toISOString());
	}
};
