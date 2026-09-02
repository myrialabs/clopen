/**
 * Containers — changing something. Admin only, all of it.
 *
 * The routes are listed in ADMIN_ONLY_ROUTES; these handlers still check host
 * access against the caller's real role rather than a hardcoded one, because a
 * gate that trusts its caller is no gate at all.
 *
 * Stopping a container takes down whatever it serves, for everyone — the same
 * reason stopping a port is admin-only — and removing an image or a volume
 * takes down something nobody can bring back by pressing start.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { LOCAL_HOST_ID } from '$shared/types/host';
import { removeResource, runContainerAction } from '../../containers/actions';
import { dismissPrune, pruneJobFor, startPrune } from '../../containers/prune-job';
import { requireHostAccess } from './list';
import { containerMonitor } from '../../containers/monitor';
import { sshConnectionQueries } from '../../database/queries';
import { ws } from '../../utils/ws';

function requireManageAccess(conn: Parameters<typeof ws.getUserId>[0], hostId: string): void {
	if (hostId === LOCAL_HOST_ID) return;
	sshConnectionQueries.ensureAccess(hostId, ws.getUserId(conn), ws.getRole(conn) === 'admin');
}

const ACTIONS = [
	t.Literal('start'),
	t.Literal('stop'),
	t.Literal('restart'),
	t.Literal('pause'),
	t.Literal('unpause'),
	t.Literal('remove'),
	t.Literal('force-remove')
];

const PRUNE_KINDS = [
	t.Literal('containers'),
	t.Literal('dangling-images'),
	t.Literal('images'),
	t.Literal('volumes'),
	t.Literal('networks'),
	t.Literal('build-cache')
];

export const containersActionHandler = createRouter()
	.http(
		'containers:action',
		{
			data: t.Object({
				hostId: t.String({ minLength: 1 }),
				containerId: t.String({ minLength: 12 }),
				action: t.Union(ACTIONS)
			}),
			response: t.Any()
		},
		async ({ data, conn }) => {
			requireManageAccess(conn, data.hostId);

			// Re-read before acting rather than trusting the row the client clicked:
			// a listing is a second or two old, and a container can be removed and
			// its name reused in that time.
			const container = await containerMonitor.findContainer(data.hostId, data.containerId);
			if (!container) {
				return { result: { ok: false, error: null }, gone: true };
			}
			if (!container.canManage) {
				return {
					result: { ok: false, error: `${container.name} cannot be changed from here right now.` },
					gone: false
				};
			}

			return {
				result: await runContainerAction(data.hostId, data.containerId, data.action),
				gone: false
			};
		}
	)

	/**
	 * Remove one image, volume or network.
	 *
	 * Containers go through `containers:action` instead, because removing one is
	 * part of its lifecycle and the confirmation has to know whether it is still
	 * running. Everything else has no lifecycle — it exists or it does not.
	 */
	.http(
		'containers:remove',
		{
			data: t.Object({
				hostId: t.String({ minLength: 1 }),
				kind: t.Union([t.Literal('image'), t.Literal('volume'), t.Literal('network')]),
				id: t.String({ minLength: 1 }),
				force: t.Optional(t.Boolean())
			}),
			response: t.Any()
		},
		async ({ data, conn }) => {
			requireManageAccess(conn, data.hostId);
			return { result: await removeResource(data.hostId, data.kind, data.id, data.force === true) };
		}
	)

	/**
	 * Clear up whatever is not in use.
	 *
	 * Takes a list rather than doing everything, because the kinds differ by what
	 * they cost to get back: a stopped container is nothing, an unused image is a
	 * pull or a build. The caller decides; each kind reports separately.
	 *
	 * Returns as soon as the sweep has started, not when it ends. A prune runs
	 * for minutes and belongs to the host rather than to the dialog that asked
	 * for it — the result arrives on `containers:prune-changed`.
	 */
	.http(
		'containers:prune',
		{
			data: t.Object({
				hostId: t.String({ minLength: 1 }),
				kinds: t.Array(t.Union(PRUNE_KINDS), { minItems: 1, maxItems: 6 })
			}),
			response: t.Any()
		},
		async ({ data, conn }) => {
			requireManageAccess(conn, data.hostId);
			return { job: startPrune(data.hostId, data.kinds, ws.getUserId(conn)) };
		}
	)

	/**
	 * The host's current sweep, or the last one nobody has acknowledged.
	 *
	 * What a dialog reads when it opens, so a sweep started before a refresh —
	 * or on another device — is still visible as the thing it is.
	 */
	.http(
		'containers:prune-status',
		{ data: t.Object({ hostId: t.String({ minLength: 1 }) }), response: t.Any() },
		async ({ data, conn }) => {
			requireHostAccess(conn, data.hostId);
			return { job: pruneJobFor(data.hostId, ws.getUserId(conn)) };
		}
	)

	/** Acknowledge a finished sweep, so its report stops being offered. */
	.http(
		'containers:prune-dismiss',
		{ data: t.Object({ hostId: t.String({ minLength: 1 }) }), response: t.Any() },
		async ({ data, conn }) => {
			requireManageAccess(conn, data.hostId);
			dismissPrune(data.hostId);
			return { ok: true };
		}
	);
