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

	/** Projects in the workspace list — everything except projects the owner removed. */
	getListed(): Project[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT p.* FROM projects p
			INNER JOIN workspace_projects wp ON p.id = wp.project_id
			ORDER BY p.created_at ASC
		`).all() as Project[];
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

	isListed(projectId: string): boolean {
		const db = getDatabase();
		const result = db.prepare(`
			SELECT 1 as ok FROM workspace_projects WHERE project_id = ? LIMIT 1
		`).get(projectId) as { ok: number } | undefined;
		return Boolean(result);
	},

	create(project: Omit<Project, 'id'>): Project {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const newProject: Project = { id, kind: 'project', ...project };

		db.prepare(`
			INSERT INTO projects (id, name, path, created_at, last_opened_at, kind)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run(id, project.name, project.path, project.created_at, project.last_opened_at, newProject.kind ?? 'project');

		return newProject;
	},

	/** The Home workspace, if it has been created. */
	getHome(): Project | null {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM projects WHERE kind = 'home'
		`).get() as Project | null;
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

	/** The project-wide default profile, or null. */
	getDefaultProfileId(id: string): number | null {
		const db = getDatabase();
		const row = db.prepare(`SELECT default_profile_id FROM projects WHERE id = ?`)
			.get(id) as { default_profile_id: number | null } | undefined;
		return row?.default_profile_id ?? null;
	},

	/** Set (or clear, with null) the project-wide default profile. */
	setDefaultProfileId(id: string, profileId: number | null): void {
		const db = getDatabase();
		db.prepare(`UPDATE projects SET default_profile_id = ? WHERE id = ?`).run(profileId, id);
	},

	deleteProject(id: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM workspace_projects WHERE project_id = ?').run(id);
		db.prepare('DELETE FROM projects WHERE id = ?').run(id);
	},

	/** Put a project in the workspace list (idempotent). */
	list(projectId: string): void {
		const db = getDatabase();
		const now = new Date().toISOString();
		db.prepare(`
			INSERT OR IGNORE INTO workspace_projects (project_id, joined_at)
			VALUES (?, ?)
		`).run(projectId, now);
	},

	/** Take a project out of the workspace list, keeping its record and chats. */
	unlist(projectId: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM workspace_projects WHERE project_id = ?').run(projectId);
	},

	getCurrentSessionId(projectId: string): string | null {
		const db = getDatabase();
		const result = db.prepare(`
			SELECT current_session_id FROM workspace_projects WHERE project_id = ?
		`).get(projectId) as { current_session_id: string | null } | null;
		return result?.current_session_id || null;
	},

	setCurrentSessionId(projectId: string, sessionId: string | null): void {
		const db = getDatabase();
		const now = new Date().toISOString();
		db.prepare(`
			INSERT OR IGNORE INTO workspace_projects (project_id, joined_at)
			VALUES (?, ?)
		`).run(projectId, now);
		db.prepare(`
			UPDATE workspace_projects SET current_session_id = ? WHERE project_id = ?
		`).run(sessionId, projectId);
	},

	getFilesPanelState(projectId: string): string | null {
		const db = getDatabase();
		const result = db.prepare(`
			SELECT files_panel_state FROM workspace_projects WHERE project_id = ?
		`).get(projectId) as { files_panel_state: string | null } | null;
		return result?.files_panel_state || null;
	},

	setFilesPanelState(projectId: string, state: string | null): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE workspace_projects SET files_panel_state = ? WHERE project_id = ?
		`).run(state, projectId);
	},

	getWorkspaceState(projectId: string): string | null {
		const db = getDatabase();
		const result = db.prepare(`
			SELECT workspace_state FROM workspace_projects WHERE project_id = ?
		`).get(projectId) as { workspace_state: string | null } | null;
		return result?.workspace_state || null;
	},

	setWorkspaceState(projectId: string, state: string | null): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE workspace_projects SET workspace_state = ? WHERE project_id = ?
		`).run(state, projectId);
	}
};
