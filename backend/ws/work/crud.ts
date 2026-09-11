/**
 * Reading and changing work items.
 *
 *   work:sources          which connected accounts serve a project
 *   work:list             work items for one source
 *   work:get              one item, with body, comments and mergeability
 *   work:states           the states an item can be moved to
 *   work:comment          add a comment
 *   work:comment-update   edit one
 *   work:comment-delete   delete one
 *   work:transition       change state
 *   work:assignees        who this repository can assign to
 *   work:set-assignees    replace an item's assignees
 *   work:create-issue     open a new issue
 *   work:set-binding      point a project at a different repository
 *   work:set-config       per-binding behaviour (transitions, branch template)
 *
 * NOT admin-gated, unlike `integrations:*`. The distinction is what the route
 * can reach: an integrations route changes a credential every project and every
 * engine depends on, while these routes act inside one project the caller was
 * already granted access to — the same reasoning that leaves `git:push` open.
 *
 * Every route takes an optional `projectId`, because this surface is global.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { workService } from '$backend/work';
import { DEFAULT_BRANCH_TEMPLATE } from '$shared/types/work';
import type { CommentSource, WorkItemKind, WorkItemState } from '$shared/types/work';
import { ws } from '$backend/utils/ws';
import { resolveWorkProject } from './context';
import {
	BINDING_CONFIG_SCHEMA,
	COMMENT_SCHEMA,
	COMMENT_SOURCE_SCHEMA,
	KIND_SCHEMA,
	RATE_LIMIT_SCHEMA,
	SOURCE_SCHEMA,
	WORK_ITEM_DETAIL_SCHEMA,
	WORK_ITEM_SCHEMA
} from './schemas';

/**
 * Tell a project's viewers that one of its sources changed.
 *
 * Project-scoped rather than global: a binding belongs to one project, and two
 * people looking at different projects have no reason to refetch because of
 * each other.
 */
export function announceWorkChanged(projectId: string): void {
	ws.emit.project(projectId, 'work:changed', { projectId });
}

const STATE_FILTER_SCHEMA = t.Union([t.Literal('open'), t.Literal('closed'), t.Literal('all')]);

/** Present on every route in this surface. Empty means "the current project". */
const PROJECT_FIELD = { projectId: t.Optional(t.String()) };

export const workCrudHandler = createRouter()
	.http('work:sources', {
		data: t.Object({ ...PROJECT_FIELD }),
		response: t.Array(SOURCE_SCHEMA)
	}, async ({ data, conn }) => {
		const { projectId, project } = resolveWorkProject(conn, data.projectId);
		// The MAIN project path, not the viewed worktree: a worktree is a copy and
		// carries the same remotes, but the project is what the binding belongs to
		// and reading it from a tree that may have been deleted is a race.
		return workService.listSources(projectId, project.path);
	})

	.http('work:list', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			kind: KIND_SCHEMA,
			state: STATE_FILTER_SCHEMA,
			mineOnly: t.Boolean(),
			author: t.Optional(t.String()),
			labels: t.Optional(t.Array(t.String(), { maxItems: 20 })),
			since: t.Optional(t.String()),
			until: t.Optional(t.String()),
			search: t.Optional(t.String()),
			page: t.Optional(t.Number({ minimum: 1, maximum: 100 }))
		}),
		response: t.Object({
			items: t.Array(WORK_ITEM_SCHEMA),
			rateLimit: t.Union([RATE_LIMIT_SCHEMA, t.Null()]),
			hasMore: t.Boolean(),
			nextPage: t.Union([t.Number(), t.Null()])
		})
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		return workService.list(projectId, data.accountId, {
			kind: data.kind as WorkItemKind,
			state: data.state as WorkItemState,
			mineOnly: data.mineOnly,
			...(data.author && { author: data.author }),
			...(data.labels?.length && { labels: data.labels }),
			...(data.since && { since: data.since }),
			...(data.until && { until: data.until }),
			...(data.search && { search: data.search }),
			...(data.page && { page: data.page })
		});
	})

	.http('work:labels', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 })
		}),
		response: t.Array(t.String())
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		return workService.listLabels(projectId, data.accountId);
	})

	.http('work:update-item', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			kind: KIND_SCHEMA,
			id: t.String({ minLength: 1 }),
			title: t.Optional(t.String({ minLength: 1, maxLength: 400 })),
			body: t.Optional(t.String({ maxLength: 65_536 }))
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		await workService.updateItem(
			projectId,
			data.accountId,
			data.kind as WorkItemKind,
			data.id,
			{
				...(data.title !== undefined && { title: data.title }),
				...(data.body !== undefined && { body: data.body })
			}
		);
		announceWorkChanged(projectId);
		return { ok: true };
	})

	.http('work:get', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			kind: KIND_SCHEMA,
			id: t.String({ minLength: 1 })
		}),
		response: WORK_ITEM_DETAIL_SCHEMA
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		return workService.get(projectId, data.accountId, data.kind as WorkItemKind, data.id);
	})

	.http('work:states', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			kind: KIND_SCHEMA
		}),
		response: t.Array(t.Object({
			value: t.String(),
			label: t.String(),
			category: t.Union([t.Literal('open'), t.Literal('closed'), t.Literal('merged'), t.Literal('draft')])
		}))
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		return workService.listStates(projectId, data.accountId, data.kind as WorkItemKind);
	})

	.http('work:comment', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			kind: KIND_SCHEMA,
			id: t.String({ minLength: 1 }),
			body: t.String({ minLength: 1, maxLength: 65_536 })
		}),
		response: COMMENT_SCHEMA
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		const comment = await workService.comment(
			projectId,
			data.accountId,
			data.kind as WorkItemKind,
			data.id,
			data.body
		);
		announceWorkChanged(projectId);
		return comment;
	})

	.http('work:comment-update', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			commentId: t.String({ minLength: 1 }),
			source: COMMENT_SOURCE_SCHEMA,
			body: t.String({ minLength: 1, maxLength: 65_536 })
		}),
		response: COMMENT_SCHEMA
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		const comment = await workService.updateComment(
			projectId,
			data.accountId,
			{ id: data.commentId, source: data.source as CommentSource },
			data.body
		);
		announceWorkChanged(projectId);
		return comment;
	})

	.http('work:comment-delete', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			commentId: t.String({ minLength: 1 }),
			source: COMMENT_SOURCE_SCHEMA
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		await workService.deleteComment(projectId, data.accountId, {
			id: data.commentId,
			source: data.source as CommentSource
		});
		announceWorkChanged(projectId);
		return { ok: true };
	})

	.http('work:transition', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			kind: KIND_SCHEMA,
			id: t.String({ minLength: 1 }),
			state: t.String({ minLength: 1 })
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		await workService.transition(
			projectId,
			data.accountId,
			data.kind as WorkItemKind,
			data.id,
			data.state
		);
		announceWorkChanged(projectId);
		return { ok: true };
	})

	.http('work:assignees', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 })
		}),
		response: t.Array(t.String())
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		return workService.listAssignees(projectId, data.accountId);
	})

	.http('work:set-assignees', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			kind: KIND_SCHEMA,
			id: t.String({ minLength: 1 }),
			logins: t.Array(t.String(), { maxItems: 10 })
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		await workService.setAssignees(
			projectId,
			data.accountId,
			data.kind as WorkItemKind,
			data.id,
			data.logins
		);
		announceWorkChanged(projectId);
		return { ok: true };
	})

	.http('work:create-issue', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			title: t.String({ minLength: 1, maxLength: 400 }),
			body: t.String({ maxLength: 65_536 }),
			assignees: t.Array(t.String(), { maxItems: 10 }),
			labels: t.Array(t.String(), { maxItems: 20 })
		}),
		response: WORK_ITEM_SCHEMA
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		const item = await workService.createIssue(projectId, data.accountId, {
			title: data.title,
			body: data.body,
			assignees: data.assignees,
			labels: data.labels
		});
		announceWorkChanged(projectId);
		return item;
	})

	.http('work:set-binding', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			locator: t.String({ minLength: 1, maxLength: 200 })
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		workService.setBinding(projectId, data.accountId, data.locator);
		announceWorkChanged(projectId);
		return { ok: true };
	})

	.http('work:set-config', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			config: BINDING_CONFIG_SCHEMA
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);
		workService.setBindingConfig(projectId, data.accountId, {
			transitionOnStartWork: data.config.transitionOnStartWork,
			transitionOnPrOpen: data.config.transitionOnPrOpen,
			// An empty template would render every branch name to the fallback,
			// which looks like the template silently not working.
			branchTemplate: data.config.branchTemplate.trim() || DEFAULT_BRANCH_TEMPLATE
		});
		announceWorkChanged(projectId);
		return { ok: true };
	})

	.emit('work:changed', t.Object({
		projectId: t.String()
	}));
