/**
 * TypeBox shapes for the Deployments surface.
 *
 * Kept in one file because three handler modules serialise the same deployment,
 * and a schema copied per handler is a schema that drifts per handler — the
 * client's generated types then disagree with each other rather than with the
 * server, which is much harder to notice.
 */

import { t } from 'elysia';

export const DEPLOYMENT_STATE_SCHEMA = t.Union([
	t.Literal('queued'),
	t.Literal('building'),
	t.Literal('ready'),
	t.Literal('error'),
	t.Literal('canceled')
]);

export const ENVIRONMENT_SCHEMA = t.Union([
	t.Literal('production'),
	t.Literal('preview'),
	t.Literal('custom')
]);

export const ENVIRONMENT_FILTER_SCHEMA = t.Union([ENVIRONMENT_SCHEMA, t.Literal('all')]);

export const STATUS_SCHEMA = t.Union([
	t.Literal('ok'),
	t.Literal('needs_auth'),
	t.Literal('needs_config'),
	t.Literal('error'),
	t.Literal('unknown')
]);

export const DEPLOY_ACTION_SCHEMA = t.Union([
	t.Literal('redeploy'),
	t.Literal('cancel'),
	t.Literal('rollback'),
	t.Literal('promote'),
	t.Literal('delete')
]);

export const RATE_LIMIT_SCHEMA = t.Object({
	remaining: t.Number(),
	limit: t.Number(),
	resetAt: t.Union([t.String(), t.Null()])
});

export const DEPLOYMENT_SCHEMA = t.Object({
	id: t.String(),
	name: t.String(),
	url: t.Union([t.String(), t.Null()]),
	inspectorUrl: t.Union([t.String(), t.Null()]),
	state: DEPLOYMENT_STATE_SCHEMA,
	stateDetail: t.String(),
	environment: ENVIRONMENT_SCHEMA,
	isCurrent: t.Boolean(),
	isRollbackCandidate: t.Union([t.Boolean(), t.Null()]),
	branch: t.Union([t.String(), t.Null()]),
	commitSha: t.Union([t.String(), t.Null()]),
	commitMessage: t.Union([t.String(), t.Null()]),
	creator: t.Union([t.String(), t.Null()]),
	createdAt: t.String(),
	buildingAt: t.Union([t.String(), t.Null()]),
	readyAt: t.Union([t.String(), t.Null()]),
	errorCode: t.Union([t.String(), t.Null()]),
	errorMessage: t.Union([t.String(), t.Null()]),
	source: t.Union([t.String(), t.Null()])
});

export const DEPLOYMENT_DETAIL_SCHEMA = t.Composite([
	DEPLOYMENT_SCHEMA,
	t.Object({
		aliases: t.Array(t.String()),
		framework: t.Union([t.String(), t.Null()]),
		durationMs: t.Union([t.Number(), t.Null()])
	})
]);

export const DEPLOY_TARGET_SCHEMA = t.Object({
	id: t.String(),
	name: t.String(),
	teamId: t.Union([t.String(), t.Null()]),
	teamName: t.Union([t.String(), t.Null()]),
	framework: t.Union([t.String(), t.Null()]),
	gitRepo: t.Union([t.String(), t.Null()])
});

export const DEPLOY_CONFIG_SCHEMA = t.Object({
	environment: ENVIRONMENT_FILTER_SCHEMA,
	autoRefresh: t.Boolean()
});

export const DEPLOY_BINDING_SCHEMA = t.Object({
	locator: t.String(),
	displayName: t.String(),
	detected: t.Boolean(),
	teamId: t.Union([t.String(), t.Null()]),
	config: DEPLOY_CONFIG_SCHEMA
});

export const DEPLOY_CAPABILITIES_SCHEMA = t.Object({
	logs: t.Boolean(),
	createDeployment: t.Boolean(),
	createProject: t.Boolean(),
	connectRepository: t.Boolean(),
	deleteDeployment: t.Boolean(),
	streamLogs: t.Boolean(),
	redeploy: t.Boolean(),
	cancel: t.Boolean(),
	rollback: t.Boolean(),
	promote: t.Boolean(),
	environments: t.Boolean(),
	branchFilter: t.Boolean()
});

export const DEPLOY_SOURCE_SCHEMA = t.Object({
	accountId: t.String(),
	provider: t.String(),
	providerName: t.String(),
	label: t.String(),
	viewer: t.Union([t.String(), t.Null()]),
	capabilities: DEPLOY_CAPABILITIES_SCHEMA,
	binding: t.Union([DEPLOY_BINDING_SCHEMA, t.Null()]),
	suggestedTargets: t.Array(DEPLOY_TARGET_SCHEMA),
	status: STATUS_SCHEMA,
	statusDetail: t.Union([t.String(), t.Null()])
});

export const LOG_BUNDLE_SCHEMA = t.Object({
	deploymentId: t.String(),
	text: t.String(),
	truncated: t.Boolean()
});

export const ACTION_RESULT_SCHEMA = t.Object({
	action: DEPLOY_ACTION_SCHEMA,
	status: t.Union([t.Literal('done'), t.Literal('pending')]),
	deploymentId: t.Union([t.String(), t.Null()]),
	message: t.String()
});

export const DEPLOY_INFO_SCHEMA = t.Object({
	gitRepo: t.Union([t.String(), t.Null()]),
	productionBranch: t.Union([t.String(), t.Null()]),
	canDeploy: t.Boolean(),
	reason: t.Union([t.String(), t.Null()]),
	suggestedRepo: t.Union([t.String(), t.Null()]),
	connectState: t.Union([
		t.Literal('ready'),
		t.Literal('blocked'),
		t.Literal('unknown'),
		t.Literal('unavailable')
	]),
	connectHint: t.Union([t.String(), t.Null()]),
	connectUrl: t.Union([t.String(), t.Null()]),
	currentBranch: t.Union([t.String(), t.Null()])
});

export const NEW_PROJECT_DEFAULTS_SCHEMA = t.Object({
	suggestedName: t.String(),
	gitRepo: t.Union([t.String(), t.Null()]),
	gitProvider: t.Union([t.String(), t.Null()])
});

export const PROJECT_STATUS_SCHEMA = t.Object({
	paused: t.Boolean(),
	aliasRequest: t.Union([
		t.Object({
			type: t.Union([t.Literal('rollback'), t.Literal('promote')]),
			status: t.Union([
				t.Literal('pending'),
				t.Literal('in-progress'),
				t.Literal('succeeded'),
				t.Literal('failed'),
				t.Literal('skipped')
			]),
			toDeploymentId: t.Union([t.String(), t.Null()])
		}),
		t.Null()
	])
});
