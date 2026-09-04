/**
 * Files Panel State Handlers
 *
 * Persist per-user-per-workspace files panel state (expanded folders, open
 * tabs, scroll positions, view mode). Single source of truth in DB so that the
 * state survives browser refresh and follows the user across devices.
 *
 * The row is per (user, project), but the state inside it is per workspace: a
 * project and each of its worktrees keep separate entries. Sharing one entry
 * carried open tabs — including unsaved buffers — from the main tree into a
 * worktree, which read as the edit having crossed between them.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { projectQueries } from '../../database/queries/project-queries';
import { ws as wsServer } from '../../utils/ws';
import { requireProjectAccess } from '../access';

/** Stored shape: opaque per-scope state strings under one version marker. */
interface ScopedPanelState {
	v: 2;
	scopes: Record<string, string>;
}

function parseStored(raw: string | null): ScopedPanelState {
	if (!raw) return { v: 2, scopes: {} };

	try {
		const parsed = JSON.parse(raw) as ScopedPanelState | Record<string, unknown>;
		if (
			typeof parsed === 'object' && parsed !== null &&
			(parsed as ScopedPanelState).v === 2 &&
			typeof (parsed as ScopedPanelState).scopes === 'object'
		) {
			return parsed as ScopedPanelState;
		}
	} catch {
		// Fall through — anything unparseable is treated as absent.
	}

	// Pre-worktree state was a bare panel-state document; it belongs to the main
	// tree, so existing users keep their tabs instead of starting empty.
	return { v: 2, scopes: {} };
}

/** Whether `raw` is legacy (flat) state rather than the scoped envelope. */
function isLegacyState(raw: string | null): boolean {
	if (!raw) return false;
	try {
		const parsed = JSON.parse(raw) as { v?: number };
		return parsed?.v !== 2;
	} catch {
		return false;
	}
}

export const filesStateHandler = createRouter()
	.http('files:get-panel-state', {
		data: t.Object({
			projectId: t.String(),
			// Absent means the main tree, which is also where legacy state lives.
			scopeKey: t.Optional(t.String())
		}),
		response: t.Object({
			state: t.Union([t.String(), t.Null()])
		})
	}, async ({ data, conn }) => {
		requireProjectAccess(conn, data.projectId);
		const userId = wsServer.getUserId(conn);
		const raw = projectQueries.getFilesPanelState(userId, data.projectId);

		const scopeKey = data.scopeKey || data.projectId;
		if (isLegacyState(raw)) {
			return { state: scopeKey === data.projectId ? raw : null };
		}

		return { state: parseStored(raw).scopes[scopeKey] ?? null };
	})

	.http('files:set-panel-state', {
		data: t.Object({
			projectId: t.String(),
			scopeKey: t.Optional(t.String()),
			state: t.Union([t.String(), t.Null()])
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		requireProjectAccess(conn, data.projectId);
		const userId = wsServer.getUserId(conn);

		const raw = projectQueries.getFilesPanelState(userId, data.projectId);
		const scopeKey = data.scopeKey || data.projectId;

		// Read-modify-write so writing one workspace never drops another's entry.
		const stored = parseStored(raw);
		if (isLegacyState(raw) && raw) stored.scopes[data.projectId] = raw;

		if (data.state === null) delete stored.scopes[scopeKey];
		else stored.scopes[scopeKey] = data.state;

		projectQueries.setFilesPanelState(userId, data.projectId, JSON.stringify(stored));
		return { ok: true };
	});
