import { getDatabase } from '../index';
import type { Project } from '$shared/types/database/schema';

export const projectQueries = {
	getAll(): Project[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM projects
			ORDER BY created_at ASC
		`).all() as Project[];
	},

	getAllForUser(userId: string): Project[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT p.* FROM projects p
			INNER JOIN user_projects up ON p.id = up.project_id
			WHERE up.user_id = ?
			ORDER BY p.created_at ASC
		`).all(userId) as Project[];
	},

	getById(id: string): Project | null {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM projects WHERE id = ?
		`).get(id) as Project | null;
	},

	getByPath(path: string): Project | null {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM projects WHERE path = ?
		`).get(path) as Project | null;
	},

	userHasProject(userId: string, projectId: string): boolean {
		const db = getDatabase();
		const result = db.prepare(`
			SELECT 1 as ok FROM user_projects
			WHERE user_id = ? AND project_id = ?
			LIMIT 1
		`).get(userId, projectId) as { ok: number } | undefined;
		return Boolean(result);
	},

	create(project: Omit<Project, 'id'>): Project {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const newProject = { id, ...project };

		db.prepare(`
			INSERT INTO projects (id, name, path, created_at, last_opened_at)
			VALUES (?, ?, ?, ?, ?)
		`).run(id, project.name, project.path, project.created_at, project.last_opened_at);

		return newProject;
	},

	updateLastOpened(id: string): void {
		const db = getDatabase();
		const now = new Date().toISOString();
		db.prepare(`
			UPDATE projects
			SET last_opened_at = ?
			WHERE id = ?
		`).run(now, id);
	},

	deleteProject(id: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM user_projects WHERE project_id = ?').run(id);
		db.prepare('DELETE FROM projects WHERE id = ?').run(id);
	},

	addUserProject(userId: string, projectId: string): void {
		const db = getDatabase();
		const now = new Date().toISOString();
		db.prepare(`
			INSERT OR IGNORE INTO user_projects (user_id, project_id, joined_at)
			VALUES (?, ?, ?)
		`).run(userId, projectId, now);
	},

	removeUserProject(userId: string, projectId: string): void {
		const db = getDatabase();
		db.prepare(`
			DELETE FROM user_projects WHERE user_id = ? AND project_id = ?
		`).run(userId, projectId);
	},

	getUserCountForProject(projectId: string): number {
		const db = getDatabase();
		const result = db.prepare(`
			SELECT COUNT(*) as count FROM user_projects WHERE project_id = ?
		`).get(projectId) as { count: number };
		return result.count;
	},

	getCurrentSessionId(userId: string, projectId: string): string | null {
		const db = getDatabase();
		const result = db.prepare(`
			SELECT current_session_id FROM user_projects
			WHERE user_id = ? AND project_id = ?
		`).get(userId, projectId) as { current_session_id: string | null } | null;
		return result?.current_session_id || null;
	},

	setCurrentSessionId(userId: string, projectId: string, sessionId: string | null): void {
		const db = getDatabase();
		// Ensure the user_projects row exists
		const now = new Date().toISOString();
		db.prepare(`
			INSERT OR IGNORE INTO user_projects (user_id, project_id, joined_at)
			VALUES (?, ?, ?)
		`).run(userId, projectId, now);
		// Update the current session
		db.prepare(`
			UPDATE user_projects
			SET current_session_id = ?
			WHERE user_id = ? AND project_id = ?
		`).run(sessionId, userId, projectId);
	},

	getFilesPanelState(userId: string, projectId: string): string | null {
		const db = getDatabase();
		const result = db.prepare(`
			SELECT files_panel_state FROM user_projects
			WHERE user_id = ? AND project_id = ?
		`).get(userId, projectId) as { files_panel_state: string | null } | null;
		return result?.files_panel_state || null;
	},

	setFilesPanelState(userId: string, projectId: string, state: string | null): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE user_projects
			SET files_panel_state = ?
			WHERE user_id = ? AND project_id = ?
		`).run(state, userId, projectId);
	},

	getWorkspaceState(userId: string, projectId: string): string | null {
		const db = getDatabase();
		const result = db.prepare(`
			SELECT workspace_state FROM user_projects
			WHERE user_id = ? AND project_id = ?
		`).get(userId, projectId) as { workspace_state: string | null } | null;
		return result?.workspace_state || null;
	},

	setWorkspaceState(userId: string, projectId: string, state: string | null): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE user_projects
			SET workspace_state = ?
			WHERE user_id = ? AND project_id = ?
		`).run(state, userId, projectId);
	}
};
