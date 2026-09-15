/**
 * Opening a pull request from the branch in front of you.
 *
 *   work:pr-context   everything the composer needs, in one call
 *   work:pr-draft     an AI-written title and body for this branch
 *   work:pr-create    create it
 *
 * `pr-create` is the only outward-facing write in this surface: it publishes to
 * a repository other people watch. It is deliberately three steps rather than
 * one button — context, then a draft the user reads and edits, then create —
 * because "open a PR" is not an action anyone should be able to take by
 * mis-clicking, and a description nobody read is worse than no description.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import {
	applyConfiguredTransition,
	buildPullRequestContext,
	draftPullRequestDescription,
	pushPullRequestHead,
	workService,
	readBinding
} from '$backend/work';
import { workLinkQueries } from '$backend/database/queries';
import type { EngineType } from '$shared/types/unified';
import { resolveWorkProject } from './context';
import { announceWorkChanged } from './crud';
import { MERGE_METHOD_SCHEMA, PR_CONTEXT_SCHEMA, WORK_ITEM_SCHEMA } from './schemas';
import { debug } from '$shared/utils/logger';

export const workPullRequestHandler = createRouter()
	.http('work:pr-context', {
		data: t.Object({
			projectId: t.Optional(t.String()),
			accountId: t.String({ minLength: 1 }),
			/** Re-read for another local branch, when the composer's head changes. */
			head: t.Optional(t.String({ maxLength: 250 }))
		}),
		response: PR_CONTEXT_SCHEMA
	}, async ({ data, conn }) => {
		// The VIEWED workspace when this is the current project: a pull request is
		// opened from the branch the user is looking at, which in a worktree
		// session is not the main tree. For any other project it is that
		// project's own root, since this connection's worktree is not there.
		const { projectId, root } = resolveWorkProject(conn, data.projectId);
		return buildPullRequestContext(projectId, data.accountId, root, data.head);
	})

	/**
	 * Push the head branch, then answer with the context again.
	 *
	 * A write, but the mildest one in this file: it publishes commits the user
	 * already made to a branch that tracks nothing, which is the step the
	 * composer would otherwise send them to another panel to perform.
	 */
	.http('work:pr-push', {
		data: t.Object({
			projectId: t.Optional(t.String()),
			accountId: t.String({ minLength: 1 }),
			head: t.String({ minLength: 1, maxLength: 250 })
		}),
		response: PR_CONTEXT_SCHEMA
	}, async ({ data, conn }) => {
		const { projectId, root } = resolveWorkProject(conn, data.projectId);
		return pushPullRequestHead(projectId, data.accountId, root, data.head);
	})

	.http('work:pr-draft', {
		data: t.Object({
			projectId: t.Optional(t.String()),
			accountId: t.String({ minLength: 1 }),
			base: t.String({ minLength: 1 }),
			head: t.String({ minLength: 1 }),
			engine: t.String({ minLength: 1 }),
			/** Hint only — the backend re-derives it from the engine catalog. */
			providerSlug: t.Optional(t.String()),
			modelId: t.String({ minLength: 1 })
		}),
		response: t.Object({
			title: t.String(),
			body: t.String()
		})
	}, async ({ data, conn }) => {
		const { projectId, root } = resolveWorkProject(conn, data.projectId);

		return draftPullRequestDescription({
			projectId,
			cwd: root,
			base: data.base,
			head: data.head,
			engine: data.engine as EngineType,
			...(data.providerSlug && { providerSlug: data.providerSlug }),
			modelId: data.modelId
		});
	})

	.http('work:pr-create', {
		data: t.Object({
			projectId: t.Optional(t.String()),
			accountId: t.String({ minLength: 1 }),
			title: t.String({ minLength: 1, maxLength: 400 }),
			body: t.String({ maxLength: 65_536 }),
			base: t.String({ minLength: 1 }),
			head: t.String({ minLength: 1 }),
			isDraft: t.Boolean()
		}),
		response: t.Object({
			item: WORK_ITEM_SCHEMA,
			transitionedTo: t.Union([t.String(), t.Null()]),
			transitionError: t.Union([t.String(), t.Null()])
		})
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);

		const item = await workService.createPullRequest(projectId, data.accountId, {
			title: data.title,
			body: data.body,
			base: data.base,
			head: data.head,
			isDraft: data.isDraft
		});

		// If this branch came from an issue, the configured "on PR open"
		// transition applies to THAT issue, not to the pull request we just
		// created. Off by default, and a failure is reported rather than thrown —
		// the pull request exists either way, and hiding it behind an error about
		// a label would be the wrong headline.
		const binding = readBinding(projectId, data.accountId);
		const link = workLinkQueries.getByBranch(projectId, data.head);
		const transition = link && link.item_kind === 'issue'
			? await applyConfiguredTransition(
				projectId,
				data.accountId,
				'issue',
				link.item_identifier,
				binding?.config.transitionOnPrOpen ?? null
			)
			: { applied: null, error: null };

		announceWorkChanged(projectId);
		debug.log('work', `Opened pull request ${item.identifier} from ${data.head}`);

		return { item, transitionedTo: transition.applied, transitionError: transition.error };
	})

	/**
	 * Merge a pull request.
	 *
	 * The most outward-facing action in this surface — it changes what is on the
	 * default branch for everyone. The client confirms, names the method
	 * explicitly, and the method is validated against what the repository
	 * actually allows on the provider's side rather than trusted from here.
	 */
	.http('work:pr-merge', {
		data: t.Object({
			projectId: t.Optional(t.String()),
			accountId: t.String({ minLength: 1 }),
			id: t.String({ minLength: 1 }),
			method: MERGE_METHOD_SCHEMA,
			title: t.Optional(t.String({ maxLength: 400 })),
			message: t.Optional(t.String({ maxLength: 65_536 }))
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const { projectId } = resolveWorkProject(conn, data.projectId);

		await workService.mergePullRequest(projectId, data.accountId, data.id, {
			method: data.method,
			...(data.title && { title: data.title }),
			...(data.message && { message: data.message })
		});

		announceWorkChanged(projectId);
		debug.log('work', `Merged pull request ${data.id} with ${data.method}`);
		return { ok: true };
	});
