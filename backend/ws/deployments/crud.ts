/**
 * Reading deployments.
 *
 *   deployments:sources      which connected accounts serve a project
 *   deployments:list         deployments for one source
 *   deployments:get          one deployment, with aliases and timings
 *   deployments:targets      remote projects this account can be pointed at
 *   deployments:set-binding  point a project at a different remote project
 *   deployments:set-config   per-binding behaviour (environment, auto-refresh)
 *   deployments:logs         build logs as one budgeted bundle
 *
 * NOT admin-gated, unlike `integrations:*`. The distinction is what the route
 * can reach: an integrations route changes a credential every project and every
 * engine depends on, while these act inside one project the caller was already
 * granted access to — the same reasoning that leaves `git:push` open.
 *
 * Every route takes an optional `projectId`, because this surface is global.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { deployService } from '$backend/deployments';
import type { DeploymentEnvironmentFilter } from '$shared/types/deployments';
import { ws } from '$backend/utils/ws';
import { resolveDeployProject } from './context';
import {
	DEPLOYMENT_DETAIL_SCHEMA,
	DEPLOYMENT_SCHEMA,
	DEPLOY_CONFIG_SCHEMA,
	DEPLOY_SOURCE_SCHEMA,
	DEPLOY_TARGET_SCHEMA,
	ENVIRONMENT_FILTER_SCHEMA,
	LOG_BUNDLE_SCHEMA,
	RATE_LIMIT_SCHEMA
} from './schemas';

/**
 * Tell a project's viewers that one of its sources changed.
 *
 * Project-scoped rather than global: a binding belongs to one project, and two
 * people looking at different projects have no reason to refetch because of
 * each other.
 */
export function announceDeploymentsChanged(projectId: string): void {
	ws.emit.project(projectId, 'deployments:changed', { projectId });
}

/** Present on every route in this surface. Empty means "the current project". */
const PROJECT_FIELD = { projectId: t.Optional(t.String()) };

export const deploymentsCrudHandler = createRouter()
	.http('deployments:sources', {
		data: t.Object({ ...PROJECT_FIELD }),
		response: t.Array(DEPLOY_SOURCE_SCHEMA)
	}, async ({ data, conn }) => {
		const { projectId, root } = resolveDeployProject(conn, data.projectId);
		return deployService.listSources(projectId, root);
	})

	.http('deployments:list', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			environment: ENVIRONMENT_FILTER_SCHEMA,
			branch: t.Optional(t.String()),
			cursor: t.Optional(t.String())
		}),
		response: t.Object({
			items: t.Array(DEPLOYMENT_SCHEMA),
			hasMore: t.Boolean(),
			nextCursor: t.Union([t.String(), t.Null()]),
			rateLimit: t.Union([RATE_LIMIT_SCHEMA, t.Null()])
		})
	}, async ({ data, conn }) => {
		const { projectId } = resolveDeployProject(conn, data.projectId);
		return deployService.list(projectId, data.accountId, {
			environment: data.environment as DeploymentEnvironmentFilter,
			...(data.branch && { branch: data.branch }),
			...(data.cursor && { cursor: data.cursor })
		});
	})

	.http('deployments:get', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			deploymentId: t.String({ minLength: 1 })
		}),
		response: DEPLOYMENT_DETAIL_SCHEMA
	}, async ({ data, conn }) => {
		const { projectId } = resolveDeployProject(conn, data.projectId);
		return deployService.get(projectId, data.accountId, data.deploymentId);
	})

	.http('deployments:targets', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 })
		}),
		response: t.Array(DEPLOY_TARGET_SCHEMA)
	}, async ({ data, conn }) => {
		const { projectId, root } = resolveDeployProject(conn, data.projectId);
		return deployService.listTargets(projectId, data.accountId, root);
	})

	.http('deployments:set-binding', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			locator: t.String({ minLength: 1 }),
			teamId: t.Optional(t.Union([t.String(), t.Null()]))
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const { projectId } = resolveDeployProject(conn, data.projectId);
		await deployService.setBinding(projectId, data.accountId, data.locator, data.teamId ?? null);
		announceDeploymentsChanged(projectId);
		return { ok: true };
	})

	.http('deployments:set-config', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			config: DEPLOY_CONFIG_SCHEMA
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const { projectId } = resolveDeployProject(conn, data.projectId);
		deployService.setConfig(projectId, data.accountId, {
			environment: data.config.environment as DeploymentEnvironmentFilter,
			autoRefresh: data.config.autoRefresh
		});
		announceDeploymentsChanged(projectId);
		return { ok: true };
	})

	.http('deployments:logs', {
		data: t.Object({
			...PROJECT_FIELD,
			accountId: t.String({ minLength: 1 }),
			deploymentId: t.String({ minLength: 1 })
		}),
		response: LOG_BUNDLE_SCHEMA
	}, async ({ data, conn }) => {
		const { projectId } = resolveDeployProject(conn, data.projectId);
		return deployService.fetchLogs(projectId, data.accountId, data.deploymentId);
	})

	.emit('deployments:changed', t.Object({
		projectId: t.String()
	}));
