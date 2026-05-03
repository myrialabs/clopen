/**
 * Files Panel State Handlers
 *
 * Persist per-user-per-project files panel state (expanded folders,
 * open tabs, scroll positions, view mode). Single source of truth in DB
 * so that the state survives browser refresh and follows the user across
 * devices.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { projectQueries } from '../../database/queries/project-queries';
import { ws as wsServer } from '../../utils/ws';
import { requireProjectAccess } from '../access';

export const filesStateHandler = createRouter()
	.http('files:get-panel-state', {
		data: t.Object({
			projectId: t.String()
		}),
		response: t.Object({
			state: t.Union([t.String(), t.Null()])
		})
	}, async ({ data, conn }) => {
		requireProjectAccess(conn, data.projectId);
		const userId = wsServer.getUserId(conn);
		const state = projectQueries.getFilesPanelState(userId, data.projectId);
		return { state };
	})

	.http('files:set-panel-state', {
		data: t.Object({
			projectId: t.String(),
			state: t.Union([t.String(), t.Null()])
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		requireProjectAccess(conn, data.projectId);
		const userId = wsServer.getUserId(conn);
		projectQueries.setFilesPanelState(userId, data.projectId, data.state);
		return { ok: true };
	});
