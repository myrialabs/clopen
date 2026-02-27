/**
 * Tunnel Operations
 *
 * HTTP endpoints for tunnel management:
 * - Start tunnel
 * - Stop tunnel
 * - Get tunnel status
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { globalTunnelManager } from '../../lib/tunnel/global-tunnel-manager';
import { debug } from '$shared/utils/logger';

export const operationsHandler = createRouter()
	// Start tunnel
	.http('tunnel:start', {
		data: t.Object({
			port: t.Number({ minimum: 1, maximum: 65535 }),
			autoStopMinutes: t.Optional(t.Number())
		}),
		response: t.Any()
	}, async ({ data }) => {
		const startTime = Date.now();
		const { port, autoStopMinutes } = data;

		debug.log('tunnel', `[WS] ====== Starting global tunnel request ======`);
		debug.log('tunnel', `[WS] Port: ${port}`);
		debug.log('tunnel', `[WS] Auto-stop: ${autoStopMinutes || 60} minutes`);

		// Validate port
		if (!port || port < 1 || port > 65535) {
			debug.error('tunnel', `[WS] Invalid port number: ${port}`);
			throw new Error('Invalid port number');
		}

		// Start tunnel without progress callback (HTTP-like pattern doesn't support progress)
		const result = await globalTunnelManager.startTunnel(
			port,
			autoStopMinutes || 60,
			undefined // No progress callback for HTTP pattern
		);

		debug.log('tunnel', `[WS] ✅ Tunnel started successfully in ${Date.now() - startTime}ms`);

		return result;
	})

	// Stop tunnel
	.http('tunnel:stop', {
		data: t.Object({
			port: t.Number({ minimum: 1, maximum: 65535 })
		}),
		response: t.Object({
			stopped: t.Boolean()
		})
	}, async ({ data }) => {
		const { port } = data;

		debug.log('tunnel', `[WS] Stop tunnel request for port ${port}`);

		// Validate port
		if (!port || port < 1 || port > 65535) {
			debug.error('tunnel', `[WS] Invalid port number: ${port}`);
			throw new Error('Invalid port number');
		}

		// Stop tunnel
		await globalTunnelManager.stopTunnel(port);

		debug.log('tunnel', `[WS] ✅ Tunnel stopped on port ${port}`);

		return { stopped: true };
	})

	// Get tunnel status
	.http('tunnel:status', {
		data: t.Object({}),
		response: t.Object({
			tunnels: t.Array(t.Any())
		})
	}, async () => {
		debug.log('tunnel', '[WS] Get tunnel status request');

		// Get all active tunnels
		const tunnels = globalTunnelManager.getActiveTunnels();

		debug.log('tunnel', `[WS] Found ${tunnels.length} active tunnel(s)`);

		return { tunnels };
	});
