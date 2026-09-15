/**
 * Worktrees Router
 *
 * Structure:
 * - crud.ts: list/create/rename/delete/status and session binding
 * - transfer.ts: two-phase apply (worktree → main) and sync (main → worktree)
 * - branching.ts: the database branch a worktree gets, and the ones it leaked
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { worktreeCrudHandler } from './crud';
import { worktreeTransferHandler } from './transfer';
import { worktreeBranchingHandler } from './branching';

export const worktreesRouter = createRouter()
	.merge(worktreeCrudHandler)
	.merge(worktreeTransferHandler)
	.merge(worktreeBranchingHandler)
	// Collaborative broadcast events (Server → Client)
	.emit('worktrees:changed', t.Object({
		projectId: t.String(),
		worktrees: t.Array(t.Any())
	}))
	.emit('worktrees:session-assigned', t.Object({
		sessionId: t.String(),
		worktreeId: t.Union([t.String(), t.Null()])
	}))
	/**
	 * The branching binding or the branch list moved.
	 *
	 * Carries the whole state rather than a delta: the dialog renders providers,
	 * accounts, the binding, the dotenv file list and every branch together, and
	 * five separate events would have five orders they could arrive in.
	 */
	.emit('worktrees:branching-changed', t.Object({
		projectId: t.String(),
		state: t.Any()
	}))
	.emit('worktrees:transferred', t.Object({
		worktreeId: t.String(),
		projectId: t.String(),
		direction: t.Union([t.Literal('apply'), t.Literal('sync')]),
		written: t.Number(),
		deleted: t.Number(),
		skipped: t.Number()
	}));
