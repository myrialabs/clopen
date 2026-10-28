/**
 * Workspace State Handlers
 *
 * Persist per-project workspace state (dock layout/ratios/preset, git dock UI
 * state, preview prefs, terminal active tab, and other dock view state). Single
 * source of truth in DB so each project's workspace survives browser refresh
 * and follows across devices.
 *
 * Mirrors the files:*-panel-state pattern.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { projectQueries } from '../../database/queries/project-queries';
import { requireProjectAccess } from '../access';

export const workspaceStateHandler = createRouter()
	.http('workspace:get-state', {
		data: t.Object({
			projectId: t.String()
		}),
		response: t.Object({
			state: t.Union([t.String(), t.Null()])
		})
	}, async ({ data }) => {
		requireProjectAccess(data.projectId);
		const state = projectQueries.getWorkspaceState(data.projectId);
		return { state };
	})

	.http('workspace:save-state', {
		data: t.Object({
			projectId: t.String(),
			state: t.Union([t.String(), t.Null()])
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		requireProjectAccess(data.projectId);
		projectQueries.setWorkspaceState(data.projectId, data.state);
		return { ok: true };
	});
