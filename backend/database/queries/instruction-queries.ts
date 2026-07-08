/**
 * Instruction Queries
 *
 * Stores the Clopen-managed instruction block for the single global scope
 * (`project_id` NULL) and per project. The content is materialized into each
 * engine's memory file as a marker-region (see `backend/instructions/sync.ts`),
 * so hand-written parts of `CLAUDE.md` / `AGENTS.md` are never overwritten.
 */

import { getDatabase } from '../index';

export type InstructionScope = 'global' | 'project';

export interface InstructionRow {
	id: number;
	scope: InstructionScope;
	project_id: string | null;
	content: string;
	is_enabled: number;
	updated_at: string;
}

export const instructionQueries = {
	getGlobal(): InstructionRow | null {
		return getDatabase()
			.prepare(`SELECT * FROM instructions WHERE scope = 'global' AND project_id IS NULL`)
			.get() as InstructionRow | null;
	},

	getForProject(projectId: string): InstructionRow | null {
		return getDatabase()
			.prepare(`SELECT * FROM instructions WHERE scope = 'project' AND project_id = ?`)
			.get(projectId) as InstructionRow | null;
	},

	getAllEnabledProjects(): InstructionRow[] {
		return getDatabase()
			.prepare(`SELECT * FROM instructions WHERE scope = 'project' AND is_enabled = 1`)
			.all() as InstructionRow[];
	},

	/**
	 * Upsert the block for a scope target (global = null projectId). Done as an
	 * explicit get-then-update/insert because SQLite treats NULL as distinct in
	 * UNIQUE constraints, so `ON CONFLICT` never fires for the global row.
	 */
	upsert(scope: InstructionScope, projectId: string | null, content: string, enabled: boolean): InstructionRow {
		const db = getDatabase();
		const existing = scope === 'global' ? this.getGlobal() : projectId ? this.getForProject(projectId) : null;
		if (existing) {
			db.prepare(
				`UPDATE instructions SET content = ?, is_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
			).run(content, enabled ? 1 : 0, existing.id);
		} else {
			db.prepare(
				`INSERT INTO instructions (scope, project_id, content, is_enabled) VALUES (?, ?, ?, ?)`
			).run(scope, projectId, content, enabled ? 1 : 0);
		}
		const row = scope === 'global' ? this.getGlobal() : this.getForProject(projectId!);
		return row!;
	}
};
