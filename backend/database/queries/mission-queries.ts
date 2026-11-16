/**
 * Missions — a goal the Clopen assistant drives across project sessions, the
 * sessions it opened, and the timeline of what happened.
 */

import { getDatabase } from '../index';
import type { AssistantAutonomy, MissionCriterion, MissionEventKind, MissionStatus } from '$shared/types/assistant';

export interface MissionRow {
	id: string;
	title: string;
	goal: string;
	criteria: string;
	status: MissionStatus;
	autonomy: AssistantAutonomy;
	assistant_session_id: string | null;
	job_id: string | null;
	iteration: number;
	stall_count: number;
	last_signature: string | null;
	summary: string | null;
	/** The crew's recipe (JSON), when the task runs one. */
	recipe: string | null;
	/** What each step of the crew did so far (JSON). */
	trace: string;
	created_at: string;
	updated_at: string;
	finished_at: string | null;
}

export interface MissionSessionRow {
	mission_id: string;
	session_id: string;
	project_id: string;
	/** The specialist this chat works as ("Writer", "Developer"…), when one was named. */
	role: string | null;
	created_at: string;
}

export interface MissionEventRow {
	id: number;
	mission_id: string;
	kind: MissionEventKind;
	text: string;
	data: string;
	session_id: string | null;
	project_id: string | null;
	created_at: string;
}

const FINISHED: MissionStatus[] = ['completed', 'failed', 'cancelled'];

export function parseCriteria(raw: string): MissionCriterion[] {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed
					.filter((item) => item && typeof item.text === 'string')
					.map((item) => ({ text: item.text as string, done: Boolean(item.done) }))
			: [];
	} catch {
		return [];
	}
}

export const missionQueries = {
	create(input: {
		title: string;
		goal: string;
		criteria: MissionCriterion[];
		autonomy: AssistantAutonomy;
		assistantSessionId: string | null;
		jobId?: string | null;
	}): MissionRow {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO missions (id, title, goal, criteria, status, autonomy, assistant_session_id, job_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
		).run(id, input.title, input.goal, JSON.stringify(input.criteria), input.autonomy, input.assistantSessionId, input.jobId ?? null, now, now);
		return missionQueries.getById(id)!;
	},

	getById(id: string): MissionRow | null {
		return (getDatabase().prepare('SELECT * FROM missions WHERE id = ?').get(id) as MissionRow | undefined) ?? null;
	},

	list(options: { status?: MissionStatus[]; limit?: number } = {}): MissionRow[] {
		const db = getDatabase();
		const limit = options.limit ?? 100;
		if (options.status?.length) {
			const marks = options.status.map(() => '?').join(', ');
			return db
				.prepare(`SELECT * FROM missions WHERE status IN (${marks}) ORDER BY updated_at DESC LIMIT ?`)
				.all(...options.status, limit) as MissionRow[];
		}
		return db.prepare('SELECT * FROM missions ORDER BY updated_at DESC LIMIT ?').all(limit) as MissionRow[];
	},

	/** Missions that are still being worked on. */
	listOpen(): MissionRow[] {
		return missionQueries.list({ status: ['active', 'paused', 'stalled'] });
	},

	update(
		id: string,
		patch: Partial<{
			title: string;
			goal: string;
			criteria: MissionCriterion[];
			status: MissionStatus;
			autonomy: AssistantAutonomy;
			assistantSessionId: string | null;
			iteration: number;
			stallCount: number;
			lastSignature: string | null;
			summary: string | null;
		}>
	): MissionRow | null {
		const db = getDatabase();
		const sets: string[] = [];
		const values: unknown[] = [];
		const column: Record<string, string> = {
			title: 'title',
			goal: 'goal',
			status: 'status',
			autonomy: 'autonomy',
			assistantSessionId: 'assistant_session_id',
			iteration: 'iteration',
			stallCount: 'stall_count',
			lastSignature: 'last_signature',
			summary: 'summary'
		};
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) continue;
			if (key === 'criteria') {
				sets.push('criteria = ?');
				values.push(JSON.stringify(value));
			} else if (column[key]) {
				sets.push(`${column[key]} = ?`);
				values.push(value);
			}
		}
		if (patch.status) {
			sets.push('finished_at = ?');
			values.push(FINISHED.includes(patch.status) ? new Date().toISOString() : null);
		}
		if (sets.length === 0) return missionQueries.getById(id);
		sets.push('updated_at = ?');
		values.push(new Date().toISOString());
		db.prepare(`UPDATE missions SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
		return missionQueries.getById(id);
	},

	delete(id: string): void {
		getDatabase().prepare('DELETE FROM missions WHERE id = ?').run(id);
	},

	setRecipe(id: string, recipe: unknown): void {
		getDatabase().prepare('UPDATE missions SET recipe = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(recipe), new Date().toISOString(), id);
	},

	setTrace(id: string, trace: unknown[]): void {
		getDatabase().prepare('UPDATE missions SET trace = ? WHERE id = ?').run(JSON.stringify(trace).slice(0, 200_000), id);
	},

	// ── Sessions ──

	linkSession(missionId: string, sessionId: string, projectId: string, role: string | null = null): void {
		const db = getDatabase();
		db.prepare(
			`INSERT OR IGNORE INTO mission_sessions (mission_id, session_id, project_id, role, created_at) VALUES (?, ?, ?, ?, ?)`
		).run(missionId, sessionId, projectId, role, new Date().toISOString());
		if (role) db.prepare('UPDATE mission_sessions SET role = ? WHERE mission_id = ? AND session_id = ?').run(role, missionId, sessionId);
	},

	sessionsOf(missionId: string): MissionSessionRow[] {
		return getDatabase()
			.prepare('SELECT * FROM mission_sessions WHERE mission_id = ? ORDER BY created_at')
			.all(missionId) as MissionSessionRow[];
	},

	/** The open mission driving this session, if any. */
	openMissionForSession(sessionId: string): MissionRow | null {
		return (
			(getDatabase()
				.prepare(
					`SELECT m.* FROM missions m JOIN mission_sessions s ON s.mission_id = m.id
					 WHERE s.session_id = ? AND m.status IN ('active', 'paused', 'stalled')
					 ORDER BY m.updated_at DESC LIMIT 1`
				)
				.get(sessionId) as MissionRow | undefined) ?? null
		);
	},

	/** Every session any mission ever drove — the "by Clopen" label in session lists. */
	isMissionSession(sessionId: string): boolean {
		return Boolean(getDatabase().prepare('SELECT 1 FROM mission_sessions WHERE session_id = ? LIMIT 1').get(sessionId));
	},

	missionSessionIds(projectId: string): string[] {
		return (
			getDatabase().prepare('SELECT DISTINCT session_id FROM mission_sessions WHERE project_id = ?').all(projectId) as Array<{
				session_id: string;
			}>
		).map((row) => row.session_id);
	},

	/** Open missions working in this project. */
	openMissionsForProject(projectId: string): MissionRow[] {
		return getDatabase()
			.prepare(
				`SELECT DISTINCT m.* FROM missions m JOIN mission_sessions s ON s.mission_id = m.id
				 WHERE s.project_id = ? AND m.status IN ('active', 'paused', 'stalled')
				 ORDER BY m.updated_at DESC`
			)
			.all(projectId) as MissionRow[];
	},

	// ── Events ──

	addEvent(input: {
		missionId: string;
		kind: MissionEventKind;
		text: string;
		data?: Record<string, unknown>;
		sessionId?: string | null;
		projectId?: string | null;
	}): MissionEventRow {
		const db = getDatabase();
		const now = new Date().toISOString();
		const result = db
			.prepare(
				`INSERT INTO mission_events (mission_id, kind, text, data, session_id, project_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				input.missionId,
				input.kind,
				input.text,
				JSON.stringify(input.data ?? {}),
				input.sessionId ?? null,
				input.projectId ?? null,
				now
			) as { lastInsertRowid: number | bigint };
		db.prepare('UPDATE missions SET updated_at = ? WHERE id = ?').run(now, input.missionId);
		return db.prepare('SELECT * FROM mission_events WHERE id = ?').get(Number(result.lastInsertRowid)) as MissionEventRow;
	},

	eventsOf(missionId: string, limit = 500): MissionEventRow[] {
		return getDatabase()
			.prepare('SELECT * FROM (SELECT * FROM mission_events WHERE mission_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id')
			.all(missionId, limit) as MissionEventRow[];
	}
};
