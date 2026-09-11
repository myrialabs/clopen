/**
 * The two actions that turn a work item into work.
 *
 *   work:start-work   item → worktree + branch + session + first prompt
 *   work:checks       CI runs for a branch
 *   work:check-logs   a failing run's logs, composed into a chat prompt
 *
 * Both return TEXT for the client to send rather than sending it themselves.
 * The chat pipeline is driven from the browser — it owns which session is
 * active, the streaming state and the optimistic message — and a second, silent
 * path that injects messages from the backend would race with all three.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { gitService } from '$backend/git/git-service';
import { buildCheckLogPrompt, workService, startWork } from '$backend/work';
import { serializeWorktree } from '../worktrees/crud';
import { worktreeQueries } from '$backend/database/queries';
import { ws } from '$backend/utils/ws';
import type { EngineType } from '$shared/types/unified';
import { resolveWorkProject } from './context';
import { announceWorkChanged } from './crud';
import {
	CHECK_RUN_SCHEMA,
	COMMIT_DETAIL_SCHEMA,
	COMMIT_SCHEMA,
	FILE_CHANGE_SCHEMA,
	KIND_SCHEMA
} from './schemas';
import { debug } from '$shared/utils/logger';

const ENGINE_SCHEMA = t.Union([
	t.Literal('claude-code'),
	t.Literal('opencode'),
	t.Literal('copilot'),
	t.Literal('codex'),
	t.Literal('qwen'),
	t.Literal('pi'),
	t.Literal('cline'),
	t.Literal('cursor')
]);

/** The branch the caller is looking at, when it did not name one. */
async function currentBranchOf(root: string): Promise<string> {
	const branches = await gitService.getBranches(root);
	if (!branches.current || branches.detached) {
		throw new Error('This workspace is not on a branch');
	}
	return branches.current;
}

export const workActionsHandler = createRouter()
	.http('work:start-work', {
		data: t.Object({
			projectId: t.Optional(t.String()),
			accountId: t.String({ minLength: 1 }),
			kind: KIND_SCHEMA,
			id: t.String({ minLength: 1 }),
			engine: ENGINE_SCHEMA
		}),
		response: t.Object({
			worktreeId: t.String(),
			worktreeName: t.String(),
			sessionId: t.String(),
			branch: t.String(),
			prompt: t.String(),
			transitionedTo: t.Union([t.String(), t.Null()]),
			transitionError: t.Union([t.String(), t.Null()]),
			needsSetup: t.Boolean()
		})
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		const userId = ws.getUserId(conn);

		const result = await startWork({
			projectId,
			accountId: data.accountId,
			kind: data.kind,
			itemId: data.id,
			engine: data.engine as EngineType,
			userId
		});

		// The worktree list and the session list both just changed for everyone in
		// the project, and the person who clicked is about to switch into both.
		ws.emit.project(projectId, 'worktrees:changed', {
			projectId,
			worktrees: worktreeQueries.getByProjectId(projectId).map(serializeWorktree)
		});
		announceWorkChanged(projectId);

		debug.log('work', `Started work on ${data.kind} ${data.id} in worktree ${result.worktreeId}`);
		return result;
	})

	.http('work:checks', {
		data: t.Object({
			projectId: t.Optional(t.String()),
			accountId: t.String({ minLength: 1 }),
			branch: t.Optional(t.String())
		}),
		response: t.Object({
			branch: t.String(),
			runs: t.Array(CHECK_RUN_SCHEMA)
		})
	}, async ({ data, conn }) => {
		const { projectId, root } = resolveWorkProject(conn, data.projectId);

		const branch = data.branch?.trim() || (await currentBranchOf(root));
		return { branch, runs: await workService.listChecks(projectId, data.accountId, branch) };
	})

	.http('work:check-logs', {
		data: t.Object({
			projectId: t.Optional(t.String()),
			accountId: t.String({ minLength: 1 }),
			runId: t.String({ minLength: 1 }),
			branch: t.String({ minLength: 1 }),
			runUrl: t.String()
		}),
		response: t.Object({
			runName: t.String(),
			/** The logs themselves, so they can be READ here rather than only sent. */
			text: t.String(),
			prompt: t.String(),
			truncated: t.Boolean()
		})
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		const bundle = await workService.fetchCheckLogs(projectId, data.accountId, data.runId);

		return {
			runName: bundle.runName,
			text: bundle.text,
			prompt: buildCheckLogPrompt(bundle, {
				locator: workService.describeBinding(projectId, data.accountId) ?? 'this repository',
				branch: data.branch,
				runUrl: data.runUrl
			}),
			truncated: bundle.truncated
		};
	})

	.http('work:pr-commits', {
		data: t.Object({
			projectId: t.Optional(t.String()),
			accountId: t.String({ minLength: 1 }),
			id: t.String({ minLength: 1 })
		}),
		response: t.Array(COMMIT_SCHEMA)
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		return workService.listCommits(projectId, data.accountId, data.id);
	})

	/**
	 * One commit, opened.
	 *
	 * Separate from `pr-commits` because it costs a request per commit and the
	 * list is read far more often than any single commit is opened.
	 */
	.http('work:commit-detail', {
		data: t.Object({
			projectId: t.Optional(t.String()),
			accountId: t.String({ minLength: 1 }),
			sha: t.String({ minLength: 1, maxLength: 100 })
		}),
		response: COMMIT_DETAIL_SCHEMA
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		return workService.commitDetail(projectId, data.accountId, data.sha);
	})

	.http('work:file-content', {
		data: t.Object({
			projectId: t.Optional(t.String()),
			accountId: t.String({ minLength: 1 }),
			path: t.String({ minLength: 1, maxLength: 1000 }),
			ref: t.String({ minLength: 1, maxLength: 250 }),
			/** Preferred address: it survives forks, deletions and gone branches. */
			blobSha: t.Optional(t.String({ maxLength: 100 }))
		}),
		response: t.Object({ content: t.String(), truncated: t.Boolean() })
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		return workService.fetchFileContent(
			projectId,
			data.accountId,
			data.path,
			data.ref,
			data.blobSha
		);
	})

	.http('work:pr-files', {
		data: t.Object({
			projectId: t.Optional(t.String()),
			accountId: t.String({ minLength: 1 }),
			id: t.String({ minLength: 1 })
		}),
		response: t.Array(FILE_CHANGE_SCHEMA)
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		return workService.listFiles(projectId, data.accountId, data.id);
	});
