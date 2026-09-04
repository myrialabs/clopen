/**
 * Database queries for worktrees — isolated project copies that sessions run in.
 */

import type { Worktree, WorktreeCloneMode, WorktreeStatus } from '$shared/types/database/schema';
import type { TreeMap } from '../../snapshot/blob-store';
import { getDatabase } from '../index';

export const worktreeQueries = {
	getByProjectId(projectId: string): Worktree[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM worktrees
			WHERE project_id = ?
			ORDER BY created_at DESC
		`).all(projectId) as Worktree[];
	},

	getById(id: string): Worktree | null {
		const db = getDatabase();
		return db.prepare(`SELECT * FROM worktrees WHERE id = ?`).get(id) as Worktree | null;
	},

	getByPath(worktreePath: string): Worktree | null {
		const db = getDatabase();
		return db.prepare(`SELECT * FROM worktrees WHERE path = ?`).get(worktreePath) as Worktree | null;
	},

	getBySlug(projectId: string, slug: string): Worktree | null {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM worktrees WHERE project_id = ? AND slug = ?
		`).get(projectId, slug) as Worktree | null;
	},

	create(input: {
		project_id: string;
		name: string;
		slug: string;
		path: string;
		clone_mode: WorktreeCloneMode;
		base_tree: TreeMap;
		created_by?: string | null;
	}): Worktree {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		const worktree: Worktree = {
			id,
			project_id: input.project_id,
			name: input.name,
			slug: input.slug,
			path: input.path,
			status: 'active',
			clone_mode: input.clone_mode,
			base_tree: JSON.stringify(input.base_tree),
			created_by: input.created_by ?? null,
			created_at: now,
			last_opened_at: now,
			last_applied_at: null
		};

		db.prepare(`
			INSERT INTO worktrees (
				id, project_id, name, slug, path, status, clone_mode,
				base_tree, created_by, created_at, last_opened_at, last_applied_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
		`).run(
			worktree.id,
			worktree.project_id,
			worktree.name,
			worktree.slug,
			worktree.path,
			worktree.status,
			worktree.clone_mode,
			worktree.base_tree,
			worktree.created_by,
			worktree.created_at,
			worktree.last_opened_at
		);

		return worktree;
	},

	rename(id: string, name: string): void {
		const db = getDatabase();
		db.prepare(`UPDATE worktrees SET name = ? WHERE id = ?`).run(name, id);
	},

	touch(id: string): void {
		const db = getDatabase();
		db.prepare(`UPDATE worktrees SET last_opened_at = ? WHERE id = ?`)
			.run(new Date().toISOString(), id);
	},

	setStatus(id: string, status: WorktreeStatus): void {
		const db = getDatabase();
		db.prepare(`UPDATE worktrees SET status = ? WHERE id = ?`).run(status, id);
	},

	/** Record a successful apply and re-base the worktree onto the tree it just produced. */
	markApplied(id: string, baseTree: TreeMap): void {
		const db = getDatabase();
		db.prepare(`
			UPDATE worktrees SET status = 'applied', last_applied_at = ?, base_tree = ?
			WHERE id = ?
		`).run(new Date().toISOString(), JSON.stringify(baseTree), id);
	},

	/** Re-base without changing status — used by sync-from-main. */
	updateBaseTree(id: string, baseTree: TreeMap): void {
		const db = getDatabase();
		db.prepare(`UPDATE worktrees SET base_tree = ? WHERE id = ?`)
			.run(JSON.stringify(baseTree), id);
	},

	delete(id: string): void {
		const db = getDatabase();
		// Sessions outlive their worktree: they fall back to the main tree rather
		// than disappearing with it, so only the pointer is cleared.
		db.prepare(`UPDATE chat_sessions SET worktree_id = NULL WHERE worktree_id = ?`).run(id);
		db.prepare(`DELETE FROM worktrees WHERE id = ?`).run(id);
	},

	deleteByProjectId(projectId: string): Worktree[] {
		const db = getDatabase();
		const worktrees = this.getByProjectId(projectId);
		db.prepare(`DELETE FROM worktrees WHERE project_id = ?`).run(projectId);
		return worktrees;
	},

	countSessions(worktreeId: string): number {
		const db = getDatabase();
		const row = db.prepare(`
			SELECT COUNT(*) AS total FROM chat_sessions WHERE worktree_id = ?
		`).get(worktreeId) as { total: number } | undefined;
		return row?.total ?? 0;
	},

	parseBaseTree(worktree: Worktree): TreeMap {
		try {
			return JSON.parse(worktree.base_tree) as TreeMap;
		} catch {
			return {};
		}
	}
};
