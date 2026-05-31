/**
 * Workspace State Handlers
 *
 * Persist per-user-per-project workspace state (dock layout/ratios/preset,
 * git dock UI state, preview prefs, terminal active tab, and other dock view
 * state). Single source of truth in DB so each project's workspace survives
 * browser refresh and follows the user across devices.
 *
 * Mirrors the files:*-panel-state pattern.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { projectQueries } from '../../database/queries/project-queries';
import { ws as wsServer } from '../../utils/ws';
import { requireProjectAccess } from '../access';

export const workspaceStateHandler = createRouter()
	.http('workspace:get-state', {
		data: t.Object({
			projectId: t.String()
		}),
		response: t.Object({
			state: t.Union([t.String(), t.Null()])
		})
	}, async ({ data, conn }) => {
		requireProjectAccess(conn, data.projectId);
		const userId = wsServer.getUserId(conn);
		const state = projectQueries.getWorkspaceState(userId, data.projectId);
		return { state };
	})

	.http('workspace:save-state', {
		data: t.Object({
			projectId: t.String(),
			state: t.Union([t.String(), t.Null()])
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		requireProjectAccess(conn, data.projectId);
		const userId = wsServer.getUserId(conn);
		projectQueries.setWorkspaceState(userId, data.projectId, data.state);
		return { ok: true };
	});
