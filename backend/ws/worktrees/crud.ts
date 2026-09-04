/**
 * Worktree CRUD
 *
 * Listing, creating, renaming and deleting the isolated project copies that
 * chat sessions can run in.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import type { WSConnection } from '$shared/utils/ws-server';
import type { Worktree } from '$shared/types/database/schema';
import { sessionQueries, worktreeQueries } from '../../database/queries';
import {
	countPendingChanges,
	createWorktree,
	getWorktreeDiskUsage,
	removeWorktree
} from '../../worktrees';
import { ws } from '$backend/utils/ws';
import { debug } from '$shared/utils/logger';
import { requireCurrentProjectAccess, requireSessionAccess } from '../access';

export const worktreeSchema = t.Object({
	id: t.String(),
	project_id: t.String(),
	name: t.String(),
	slug: t.String(),
	path: t.String(),
	status: t.Union([t.Literal('active'), t.Literal('applied'), t.Literal('archived')]),
	clone_mode: t.Union([t.Literal('reflink'), t.Literal('copy')]),
	created_by: t.Optional(t.String()),
	created_at: t.String(),
	last_opened_at: t.Optional(t.String()),
	last_applied_at: t.Optional(t.String()),
	sessionCount: t.Number()
});

/**
 * Convert a row → response. `base_tree` is deliberately dropped: it is a full
 * hash map of the project and has no use on the client.
 */
export function serializeWorktree(worktree: Worktree) {
	return {
		id: worktree.id,
		project_id: worktree.project_id,
		name: worktree.name,
		slug: worktree.slug,
		path: worktree.path,
		status: worktree.status,
		clone_mode: worktree.clone_mode,
		created_by: worktree.created_by ?? undefined,
		created_at: worktree.created_at,
		last_opened_at: worktree.last_opened_at ?? undefined,
		last_applied_at: worktree.last_applied_at ?? undefined,
		sessionCount: worktreeQueries.countSessions(worktree.id)
	};
}

/** Tell everyone in the project that the worktree list moved. */
function broadcastWorktrees(projectId: string): void {
	ws.emit.project(projectId, 'worktrees:changed', {
		projectId,
		worktrees: worktreeQueries.getByProjectId(projectId).map(serializeWorktree)
	});
}

export const worktreeCrudHandler = createRouter()
	.http('worktrees:list', {
		data: t.Object({}),
		response: t.Array(worktreeSchema)
	}, async ({ conn }) => {
		const { projectId } = requireCurrentProjectAccess(conn);
		return worktreeQueries.getByProjectId(projectId).map(serializeWorktree);
	})

	.http('worktrees:create', {
		data: t.Object({
			name: t.String({ minLength: 1, maxLength: 80 })
		}),
		response: t.Object({
			worktree: worktreeSchema,
			fileCount: t.Number(),
			carriedIgnoredFiles: t.Boolean()
		})
	}, async ({ data, conn }) => {
		const { projectId, userId } = requireCurrentProjectAccess(conn);

		const result = await createWorktree({
			projectId,
			name: data.name,
			createdBy: userId
		});

		broadcastWorktrees(projectId);

		return {
			worktree: serializeWorktree(result.worktree),
			fileCount: result.fileCount,
			carriedIgnoredFiles: result.carriedIgnoredFiles
		};
	})

	.http('worktrees:rename', {
		data: t.Object({
			id: t.String({ minLength: 1 }),
			name: t.String({ minLength: 1, maxLength: 80 })
		}),
		response: worktreeSchema
	}, async ({ data, conn }) => {
		const worktree = requireWorktreeAccess(conn, data.id);
		worktreeQueries.rename(worktree.id, data.name.trim());
		broadcastWorktrees(worktree.project_id);

		const updated = worktreeQueries.getById(worktree.id);
		if (!updated) throw new Error('Worktree not found');
		return serializeWorktree(updated);
	})

	.http('worktrees:delete', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data, conn }) => {
		const worktree = requireWorktreeAccess(conn, data.id);
		await removeWorktree(worktree.id);
		broadcastWorktrees(worktree.project_id);
		debug.log('worktree', `Deleted worktree ${worktree.name}`);
		return { success: true };
	})

	/** Divergence and disk footprint — computed on demand, never in the list. */
	.http('worktrees:status', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Object({
			pendingChanges: t.Number(),
			diskKilobytes: t.Optional(t.Number())
		})
	}, async ({ data, conn }) => {
		const worktree = requireWorktreeAccess(conn, data.id);
		const [pendingChanges, diskKilobytes] = await Promise.all([
			countPendingChanges(worktree.id),
			getWorktreeDiskUsage(worktree.path)
		]);

		return { pendingChanges, diskKilobytes: diskKilobytes ?? undefined };
	})

	/** Bind (or unbind) a chat session to a worktree. */
	.http('worktrees:assign-session', {
		data: t.Object({
			sessionId: t.String({ minLength: 1 }),
			worktreeId: t.Union([t.String(), t.Null()])
		}),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data, conn }) => {
		const session = requireSessionAccess(conn, data.sessionId);

		if (data.worktreeId !== null) {
			const worktree = worktreeQueries.getById(data.worktreeId);
			if (!worktree || worktree.project_id !== session.project_id) {
				throw new Error('Worktree not found');
			}
			worktreeQueries.touch(worktree.id);
		}

		sessionQueries.setWorktree(session.id, data.worktreeId);
		ws.emit.project(session.project_id, 'worktrees:session-assigned', {
			sessionId: session.id,
			worktreeId: data.worktreeId
		});

		return { success: true };
	});

/** A worktree is reachable exactly when its project is. */
export function requireWorktreeAccess(conn: WSConnection, worktreeId: string): Worktree {
	const worktree = worktreeQueries.getById(worktreeId);
	if (!worktree) throw new Error('Access denied');

	const { projectId } = requireCurrentProjectAccess(conn);
	if (worktree.project_id !== projectId) throw new Error('Access denied');

	return worktree;
}
