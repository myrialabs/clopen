/**
 * Tunnel Config Endpoints
 *
 * HTTP endpoints for managing tunnel configurations:
 * - Remote: list, add (token+label), remove
 * - Local: list configs
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import {
	getRemoteTunnelConfigs,
	addRemoteTunnelConfig,
	removeRemoteTunnelConfig,
	getLocalTunnelConfigs
} from '../../tunnel/tunnel-config';
import { globalTunnelManager } from '../../tunnel/global-tunnel-manager';

export const configHandler = createRouter()

	// ═══════════════════════════════════════
	// Remote Tunnel Configs
	// ═══════════════════════════════════════

	.http('tunnel:remote:config:list', {
		data: t.Object({}),
		response: t.Object({
			configs: t.Array(t.Object({
				id: t.String(),
				label: t.String(),
				isActive: t.Boolean(),
				ingress: t.Array(t.Object({
					hostname: t.Optional(t.String()),
					service: t.String()
				}))
			}))
		})
	}, async () => {
		const configs = getRemoteTunnelConfigs();
		return {
			// Never expose tokens to the frontend
			configs: configs.map((c) => ({
				id: c.id,
				label: c.label,
				isActive: globalTunnelManager.isRemoteTunnelActive(c.id),
				ingress: globalTunnelManager.getRemoteTunnelIngress(c.id)
			}))
		};
	})

	.http('tunnel:remote:config:add', {
		data: t.Object({
			label: t.String({ minLength: 1 }),
			token: t.String({ minLength: 1 })
		}),
		response: t.Object({
			id: t.String(),
			label: t.String()
		})
	}, async ({ data }) => {
		const entry = addRemoteTunnelConfig(data.label, data.token);
		return { id: entry.id, label: entry.label };
	})

	.http('tunnel:remote:config:remove', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		// Stop if running
		if (globalTunnelManager.isRemoteTunnelActive(data.id)) {
			await globalTunnelManager.stopRemoteTunnel(data.id);
		}
		const removed = removeRemoteTunnelConfig(data.id);
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
		const configs = getLocalTunnelConfigs();
		return {
			configs: configs.map((c) => ({
				id: c.id,
				name: c.name,
				tunnelId: c.tunnelId,
				ingress: c.ingress,
				isActive: globalTunnelManager.isLocalTunnelActive(c.id)
			}))
		};
	});
