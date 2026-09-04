/**
 * Worktrees Router
 *
 * Structure:
 * - crud.ts: list/create/rename/delete/status and session binding
 * - transfer.ts: two-phase apply (worktree → main) and sync (main → worktree)
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { worktreeCrudHandler } from './crud';
import { worktreeTransferHandler } from './transfer';

export const worktreesRouter = createRouter()
	.merge(worktreeCrudHandler)
	.merge(worktreeTransferHandler)
	// Collaborative broadcast events (Server → Client)
	.emit('worktrees:changed', t.Object({
		projectId: t.String(),
		worktrees: t.Array(t.Any())
	}))
	.emit('worktrees:session-assigned', t.Object({
		sessionId: t.String(),
		worktreeId: t.Union([t.String(), t.Null()])
	}))
	.emit('worktrees:transferred', t.Object({
		worktreeId: t.String(),
		projectId: t.String(),
		direction: t.Union([t.Literal('apply'), t.Literal('sync')]),
		written: t.Number(),
		deleted: t.Number(),
		skipped: t.Number()
	}));
