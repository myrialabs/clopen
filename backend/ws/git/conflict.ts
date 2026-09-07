/**
 * Git Conflict Resolution Handler
 */

import { t } from 'elysia';
import path from 'node:path';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '../../git/git-service';
import { findNestedRepoPaths, findRepoForFile } from '../../git/nested-repos';
import { requireProjectWorkspace } from '../access';
import { debug } from '$shared/utils/logger';

function resolveRepoCwd(projectPath: string, repoPath: string | undefined): string | null {
	if (!repoPath) return null;
	const resolved = path.resolve(repoPath);
	const projectRoot = path.resolve(projectPath);
	const sep = path.sep;
	if (resolved !== projectRoot && !resolved.startsWith(projectRoot + sep)) {
		debug.warn('git', `Rejected nested repoPath outside project: ${resolved}`);
		return projectRoot;
	}
	return resolved;
}

const ConflictKindSchema = t.Union([
	t.Literal('both-modified'),
	t.Literal('both-added'),
	t.Literal('added-by-us'),
	t.Literal('added-by-them'),
	t.Literal('deleted-by-us'),
	t.Literal('deleted-by-them'),
	t.Literal('both-deleted')
]);

const OperationSchema = t.Union([
	t.Literal('rebase'),
	t.Literal('merge'),
	t.Literal('cherry-pick'),
	t.Literal('revert'),
	t.Literal('bisect'),
	t.Null()
]);

const OperationStateSchema = t.Object({
	operation: OperationSchema,
	step: t.Optional(t.Number()),
	total: t.Optional(t.Number()),
	oursLabel: t.String(),
	theirsLabel: t.String(),
	currentCommit: t.Optional(t.String()),
	unmergedCount: t.Number(),
	canContinue: t.Boolean(),
	canSkip: t.Boolean(),
	stashConflict: t.Boolean()
});

const ConflictMarkerSchema = t.Object({
	ourStart: t.Number(),
	ourEnd: t.Number(),
	theirStart: t.Number(),
	theirEnd: t.Number(),
	baseStart: t.Optional(t.Number()),
	baseEnd: t.Optional(t.Number()),
	ourContent: t.String(),
	theirContent: t.String(),
	baseContent: t.Optional(t.String())
});

export const conflictHandler = createRouter()
	.http('git:conflict-files', {
		data: t.Object({
			projectId: t.String()
		}),
		response: t.Array(t.Object({
			path: t.String(),
			content: t.String(),
			markers: t.Array(ConflictMarkerSchema),
			kind: ConflictKindSchema,
			contentOmitted: t.Boolean(),
			omitReason: t.Optional(t.Union([
				t.Literal('binary'),
				t.Literal('missing'),
				t.Literal('too-large')
			])),
			size: t.Optional(t.Number())
		}))
	}, async ({ data, conn }) => {
		const { root } = requireProjectWorkspace(conn, data.projectId);
		const conflicts = await gitService.getConflictFiles(root);

		try {
			const nestedRepoPaths = await findNestedRepoPaths(root);
			for (const repoPath of nestedRepoPaths) {
				try {
					const nestedConflicts = await gitService.getConflictFiles(repoPath);
					const prefix = path.relative(root, repoPath).replace(/\\/g, '/') + '/';
					for (const conflict of nestedConflicts) {
						conflicts.push({
							...conflict,
							path: prefix + conflict.path
						});
					}
				} catch {
					// Skip nested repos whose conflict status fails
				}
			}
		} catch {
			// Skip finding nested repos if it fails
		}

		return conflicts;
	})

	.http('git:resolve-conflict', {
		data: t.Object({
			projectId: t.String(),
			filePath: t.String(),
			resolution: t.Union([
				t.Literal('ours'),
				t.Literal('theirs'),
				t.Literal('custom'),
				t.Literal('keep'),
				t.Literal('delete'),
				t.Literal('reset')
			]),
			customContent: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const { root } = requireProjectWorkspace(conn, data.projectId);
		const repo = await findRepoForFile(root, data.filePath);
		const cwd = repo?.repoPath ?? root;
		const filePath = repo?.relativeFilePath ?? data.filePath;
		await gitService.resolveConflict(
			cwd,
			filePath,
			data.resolution,
			data.customContent
		);
		return { ok: true };
	})

	/**
	 * Everything needed to describe (and finish) an in-progress merge/rebase.
	 * Scoped to one repo: a project with nested repos can be mid-rebase in a
	 * sub-repo while the outer tree is clean, so the caller passes `repoPath`
	 * rather than us guessing from whichever conflict happens to be first.
	 */
	.http('git:operation-state', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: OperationStateSchema
	}, async ({ data, conn }) => {
		const { root } = requireProjectWorkspace(conn, data.projectId);
		const cwd = resolveRepoCwd(root, data.repoPath) ?? root;
		return await gitService.getOperationState(cwd);
	})

	.http('git:continue-operation', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ success: t.Boolean(), message: t.String() })
	}, async ({ data, conn }) => {
		const { root } = requireProjectWorkspace(conn, data.projectId);
		const cwd = resolveRepoCwd(root, data.repoPath) ?? root;
		return await gitService.continueOperation(cwd);
	})

	.http('git:skip-operation', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ success: t.Boolean(), message: t.String() })
	}, async ({ data, conn }) => {
		const { root } = requireProjectWorkspace(conn, data.projectId);
		const cwd = resolveRepoCwd(root, data.repoPath) ?? root;
		return await gitService.skipOperation(cwd);
	})

	.http('git:abort-operation', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const { root } = requireProjectWorkspace(conn, data.projectId);
		const cwd = resolveRepoCwd(root, data.repoPath) ?? root;
		await gitService.abortOperation(cwd);
		return { ok: true };
	})

	/** Retained under the old name so existing clients keep working. */
	.http('git:abort-merge', {
		data: t.Object({
			projectId: t.String(),
			repoPath: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const { root } = requireProjectWorkspace(conn, data.projectId);
		const cwd = resolveRepoCwd(root, data.repoPath) ?? root;
		await gitService.abortOperation(cwd);
		return { ok: true };
	});
