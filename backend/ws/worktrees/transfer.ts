/**
 * Moving work between a worktree and the main tree.
 *
 * Two phases, mirroring the checkpoint restore flow: preview first so the user
 * sees what would change and resolves anything contested, then execute.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { executeTransfer, previewTransfer } from '../../worktrees';
import type { MergeResolution } from '../../worktrees';
import { ws } from '$backend/utils/ws';
import { debug } from '$shared/utils/logger';
import { requireWorktreeAccess } from './crud';

const directionSchema = t.Union([t.Literal('apply'), t.Literal('sync')]);

const changeSchema = t.Object({
	path: t.String(),
	status: t.Union([t.Literal('added'), t.Literal('modified'), t.Literal('deleted')]),
	conflict: t.Boolean(),
	autoMergeable: t.Boolean()
});

export const worktreeTransferHandler = createRouter()
	/** Phase 1: what would change, and what needs a decision. */
	.http('worktrees:preview-transfer', {
		data: t.Object({
			id: t.String({ minLength: 1 }),
			direction: directionSchema
		}),
		response: t.Object({
			direction: directionSchema,
			changes: t.Array(changeSchema),
			conflicts: t.Array(t.Object({
				...changeSchema.properties,
				sourceContent: t.Optional(t.String()),
				targetContent: t.Optional(t.String())
			}))
		})
	}, async ({ data, conn }) => {
		const worktree = requireWorktreeAccess(conn, data.id);
		const preview = await previewTransfer(worktree.id, data.direction);

		debug.log(
			'worktree',
			`Preview ${data.direction} for ${worktree.name}: ${preview.changes.length} changes, ${preview.conflicts.length} conflicts`
		);

		return preview;
	})

	/** Phase 2: carry the changes across using the user's resolutions. */
	.http('worktrees:transfer', {
		data: t.Object({
			id: t.String({ minLength: 1 }),
			direction: directionSchema,
			resolutions: t.Optional(t.Record(
				t.String(),
				t.Union([t.Literal('source'), t.Literal('target'), t.Literal('merge')])
			))
		}),
		response: t.Object({
			written: t.Number(),
			deleted: t.Number(),
			skipped: t.Number(),
			failed: t.Array(t.String())
		})
	}, async ({ data, conn }) => {
		const worktree = requireWorktreeAccess(conn, data.id);

		const result = await executeTransfer(
			worktree.id,
			data.direction,
			(data.resolutions ?? {}) as Record<string, MergeResolution>
		);

		ws.emit.project(worktree.project_id, 'worktrees:transferred', {
			worktreeId: worktree.id,
			projectId: worktree.project_id,
			direction: data.direction,
			written: result.written,
			deleted: result.deleted,
			skipped: result.skipped
		});

		return result;
	});
