/**
 * Tunnel Config Endpoints
 *
 * HTTP endpoints for managing tunnel configurations:
 * - Remote: list, add (token+name), remove
 * - Local: list configs
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { tunnelKit, tunnelStore, namedIngress } from '../../tunnel/tunnel-config';

export const configHandler = createRouter()

	// ═══════════════════════════════════════
	// Remote Tunnel Configs
	// ═══════════════════════════════════════

	.http('tunnel:remote:config:list', {
		data: t.Object({}),
		response: t.Object({
			configs: t.Array(t.Object({
				id: t.String(),
				name: t.String(),
				isActive: t.Boolean(),
				ingress: t.Array(t.Object({
					hostname: t.Optional(t.String()),
					service: t.String()
				}))
			}))
		})
	}, async () => {
		const configs = tunnelStore.getRemotes();
		return {
			// Never expose tokens to the frontend
			configs: configs.map((c) => ({
				id: c.id,
				name: c.name,
				isActive: tunnelKit.remote.isActive(c.id),
				ingress: tunnelKit.remote.ingress(c.id)
			}))
		};
	})

	.http('tunnel:remote:config:add', {
		data: t.Object({
			name: t.String({ minLength: 1 }),
			token: t.String({ minLength: 1 })
		}),
		response: t.Object({
			id: t.String(),
			name: t.String()
		})
	}, async ({ data }) => {
		const entry = tunnelStore.addRemote(data.name, data.token);
		return { id: entry.id, name: entry.name };
	})

	.http('tunnel:remote:config:remove', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		// Stop if running (tunnelKit.stop is a no-op for unknown ids).
		await tunnelKit.stop(data.id);
		const removed = tunnelStore.removeRemote(data.id);
		return { success: removed };
	})

	// ═══════════════════════════════════════
	// Local Tunnel Configs
	// ═══════════════════════════════════════

	.http('tunnel:local:config:list', {
		data: t.Object({}),
		response: t.Object({
			configs: t.Array(t.Object({
				id: t.String(),
				name: t.String(),
				tunnelId: t.String(),
				ingress: t.Array(t.Object({
					hostname: t.String(),
					service: t.String()
				})),
				isActive: t.Boolean()
			}))
		})
	}, async () => {
		const configs = tunnelStore.getLocals();
		return {
			configs: configs.map((c) => ({
				id: c.id,
				name: c.name,
				tunnelId: c.tunnelId,
				ingress: namedIngress(c.ingress),
				isActive: tunnelKit.local.isActive(c.id)
			}))
		};
	});
