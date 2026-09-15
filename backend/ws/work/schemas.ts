/**
 * TypeBox shapes for the Issues & PRs surface.
 *
 * Kept in one file because three handler modules serialise the same work item,
 * and a schema copied per handler is a schema that drifts per handler — the
 * client's generated types then disagree with each other rather than with the
 * server, which is much harder to notice.
 */

import { t } from 'elysia';

export const KIND_SCHEMA = t.Union([t.Literal('issue'), t.Literal('pull-request')]);

export const STATE_CATEGORY_SCHEMA = t.Union([
	t.Literal('open'),
	t.Literal('closed'),
	t.Literal('merged'),
	t.Literal('draft')
]);

export const STATUS_SCHEMA = t.Union([
	t.Literal('ok'),
	t.Literal('needs_auth'),
	t.Literal('needs_config'),
	t.Literal('error'),
	t.Literal('unknown')
]);

export const WORK_ITEM_SCHEMA = t.Object({
	id: t.String(),
	identifier: t.String(),
	kind: KIND_SCHEMA,
	title: t.String(),
	url: t.String(),
	state: t.String(),
	stateCategory: STATE_CATEGORY_SCHEMA,
	labels: t.Array(t.String()),
	assignees: t.Array(t.String()),
	author: t.Union([t.String(), t.Null()]),
	commentCount: t.Number(),
	createdAt: t.String(),
	updatedAt: t.String(),
	headBranch: t.Optional(t.String()),
	headSha: t.Optional(t.String()),
	baseBranch: t.Optional(t.String()),
	isDraft: t.Optional(t.Boolean())
});

export const COMMENT_SOURCE_SCHEMA = t.Union([
	t.Literal('conversation'),
	t.Literal('review'),
	t.Literal('review-summary')
]);

export const COMMENT_SCHEMA = t.Object({
	id: t.String(),
	author: t.String(),
	body: t.String(),
	createdAt: t.String(),
	url: t.Optional(t.String()),
	source: COMMENT_SOURCE_SCHEMA,
	canModify: t.Boolean(),
	path: t.Optional(t.String()),
	line: t.Optional(t.Union([t.Number(), t.Null()]))
});

export const MERGE_METHOD_SCHEMA = t.Union([
	t.Literal('merge'),
	t.Literal('squash'),
	t.Literal('rebase')
]);

export const MERGEABILITY_SCHEMA = t.Object({
	mergeable: t.Union([t.Boolean(), t.Null()]),
	state: t.String(),
	allowedMethods: t.Array(MERGE_METHOD_SCHEMA),
	merged: t.Boolean()
});

export const COMMIT_SCHEMA = t.Object({
	hash: t.String(),
	subject: t.String(),
	author: t.Union([t.String(), t.Null()]),
	date: t.String(),
	url: t.String()
});

export const FILE_CHANGE_SCHEMA = t.Object({
	path: t.String(),
	status: t.String(),
	additions: t.Number(),
	deletions: t.Number(),
	patch: t.Optional(t.String()),
	url: t.String(),
	sha: t.Optional(t.String()),
	previousPath: t.Optional(t.String())
});

export const COMMIT_DETAIL_SCHEMA = t.Object({
	commit: COMMIT_SCHEMA,
	body: t.String(),
	additions: t.Number(),
	deletions: t.Number(),
	files: t.Array(FILE_CHANGE_SCHEMA)
});

export const TIMELINE_EVENT_SCHEMA = t.Object({
	id: t.String(),
	kind: t.Union([
		t.Literal('labeled'),
		t.Literal('unlabeled'),
		t.Literal('assigned'),
		t.Literal('unassigned'),
		t.Literal('renamed'),
		t.Literal('referenced'),
		t.Literal('cross-referenced'),
		t.Literal('closed'),
		t.Literal('reopened'),
		t.Literal('merged'),
		t.Literal('review-requested')
	]),
	actor: t.Union([t.String(), t.Null()]),
	createdAt: t.String(),
	subject: t.Optional(t.String()),
	referenceTitle: t.Optional(t.String()),
	referenceUrl: t.Optional(t.String()),
	referenceIdentifier: t.Optional(t.String())
});

export const WORK_ITEM_DETAIL_SCHEMA = t.Composite([
	WORK_ITEM_SCHEMA,
	t.Object({
		body: t.String(),
		comments: t.Array(COMMENT_SCHEMA),
		events: t.Array(TIMELINE_EVENT_SCHEMA),
		mergeability: t.Optional(MERGEABILITY_SCHEMA)
	})
]);

export const RATE_LIMIT_SCHEMA = t.Object({
	remaining: t.Number(),
	limit: t.Number(),
	resetAt: t.Union([t.String(), t.Null()])
});

export const BINDING_CONFIG_SCHEMA = t.Object({
	transitionOnStartWork: t.Union([t.String(), t.Null()]),
	transitionOnPrOpen: t.Union([t.String(), t.Null()]),
	branchTemplate: t.String()
});

export const BINDING_SCHEMA = t.Object({
	locator: t.String(),
	displayName: t.String(),
	detected: t.Boolean(),
	defaultBranch: t.Union([t.String(), t.Null()]),
	config: BINDING_CONFIG_SCHEMA
});

export const SOURCE_SCHEMA = t.Object({
	accountId: t.String(),
	provider: t.String(),
	providerName: t.String(),
	label: t.String(),
	viewer: t.Union([t.String(), t.Null()]),
	capabilities: t.Object({
		pullRequests: t.Boolean(),
		checks: t.Boolean(),
		comments: t.Boolean(),
		editComments: t.Boolean(),
		transitions: t.Boolean(),
		editTitle: t.Boolean(),
		createPullRequest: t.Boolean(),
		createIssue: t.Boolean(),
		merge: t.Boolean(),
		assign: t.Boolean(),
		diff: t.Boolean()
	}),
	binding: t.Union([BINDING_SCHEMA, t.Null()]),
	suggestedLocators: t.Array(t.String()),
	status: STATUS_SCHEMA,
	statusDetail: t.Union([t.String(), t.Null()])
});

export const CHECK_RUN_SCHEMA = t.Object({
	id: t.String(),
	name: t.String(),
	status: t.Union([
		t.Literal('queued'),
		t.Literal('running'),
		t.Literal('success'),
		t.Literal('failure'),
		t.Literal('cancelled'),
		t.Literal('skipped'),
		t.Literal('unknown')
	]),
	url: t.String(),
	headBranch: t.Union([t.String(), t.Null()]),
	headSha: t.String(),
	event: t.String(),
	startedAt: t.Union([t.String(), t.Null()]),
	finishedAt: t.Union([t.String(), t.Null()]),
	canFetchLogs: t.Boolean()
});

export const WORK_LINK_SCHEMA = t.Object({
	itemKind: KIND_SCHEMA,
	itemIdentifier: t.String(),
	worktreeId: t.Union([t.String(), t.Null()]),
	worktreeName: t.Union([t.String(), t.Null()]),
	sessionId: t.Union([t.String(), t.Null()]),
	branch: t.Union([t.String(), t.Null()]),
	createdAt: t.String()
});

export const PR_CONTEXT_SCHEMA = t.Object({
	head: t.String(),
	base: t.String(),
	baseCandidates: t.Array(t.String()),
	headCandidates: t.Array(t.String()),
	isPushed: t.Boolean(),
	pushRemote: t.String(),
	commits: t.Array(t.Object({ hash: t.String(), subject: t.String() })),
	existing: t.Union([WORK_ITEM_SCHEMA, t.Null()]),
	linkedItem: t.Union([WORK_LINK_SCHEMA, t.Null()])
});
