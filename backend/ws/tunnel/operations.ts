/**
 * Tunnel Operations
 *
 * HTTP endpoints for tunnel management:
 * - Quick tunnel: start/stop with random URL
 * - Remote tunnel: start/stop dashboard-managed tunnels
 * - Local tunnel: auth, create, delete, ingress, route-dns, start/stop
 *
 * Each handler that needs cloudflared calls `tunnelKit.bin.ensure()` first
 * (it resolves from the managed dir or PATH, downloading on first use); the
 * remaining calls are direct passthroughs to `tunnelKit.*` and the singleton
 * `tunnelStore` for persistence.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { tunnelKit, tunnelStore, namedIngress, mapActiveTunnel } from '../../tunnel/tunnel-config';
import { debug } from '$shared/utils/logger';
import { ws } from '$backend/utils/ws';

// Wire up ingress update callback to push via WS
tunnelKit.on('ingress-update', ({ id, ingress }) => {
	ws.emit.global('tunnel:remote:ingress-update', { id, ingress });
});

// Wire up status changed callback to push tunnel list via WS
tunnelKit.on('status-changed', () => {
	ws.emit.global('tunnel:status-changed', { tunnels: tunnelKit.list().map(mapActiveTunnel) });
});

export const operationsHandler = createRouter()

	// ═══════════════════════════════════════
	// Quick Tunnel
	// ═══════════════════════════════════════

	.http('tunnel:quick:start', {
		data: t.Object({
			port: t.Number({ minimum: 1, maximum: 65535 }),
			autoStopMinutes: t.Optional(t.Number({ minimum: 0 }))
		}),
		response: t.Any()
	}, async ({ data }) => {
		const { port, autoStopMinutes = 60 } = data;
		debug.log('tunnel', `[WS] Quick tunnel start: port=${port}, autoStop=${autoStopMinutes}`);

		await tunnelKit.bin.ensure();
		const { publicUrl, timings } = await tunnelKit.quick.start({ service: port, autoStopMinutes });
		return { publicUrl, timings };
	})

	.http('tunnel:quick:stop', {
		data: t.Object({
			port: t.Number()
		}),
		response: t.Object({ stopped: t.Boolean() })
	}, async ({ data }) => {
		await tunnelKit.quick.stop(data.port);
		return { stopped: true };
	})

	// ═══════════════════════════════════════
	// Remote Tunnel (Dashboard-managed)
	// ═══════════════════════════════════════

	.http('tunnel:remote:start', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Any()
	}, async ({ data }) => {
		const config = tunnelStore.getRemote(data.id);
		if (!config) throw new Error('Remote tunnel config not found');

		debug.log('tunnel', `[WS] Remote tunnel start: ${config.name}`);
		await tunnelKit.bin.ensure();
		const { timings } = await tunnelKit.remote.start(
			{ id: config.id, token: config.token, name: config.name }
		);
		return { timings };
	})

	.http('tunnel:remote:stop', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Object({ stopped: t.Boolean() })
	}, async ({ data }) => {
		await tunnelKit.stop(data.id);
		return { stopped: true };
	})

	.http('tunnel:remote:ingress', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Object({
			ingress: t.Array(t.Object({
				hostname: t.Optional(t.String()),
				service: t.String()
			}))
		})
	}, async ({ data }) => {
		return { ingress: tunnelKit.remote.ingress(data.id) };
	})

	// ═══════════════════════════════════════
	// Local Tunnel (Locally-managed)
	// ═══════════════════════════════════════

	.http('tunnel:local:auth-status', {
		data: t.Object({}),
		response: t.Object({
			authenticated: t.Boolean(),
			certPath: t.String(),
			zone: t.Nullable(t.String())
		})
	}, async () => {
		return { ...tunnelKit.local.checkAuth(), zone: tunnelStore.getZone() };
	})

	.http('tunnel:local:logout', {
		data: t.Object({}),
		response: t.Object({ success: t.Boolean() })
	}, async () => {
		tunnelKit.local.logout();
		tunnelStore.clearZone();
		return { success: true };
	})

	.http('tunnel:local:set-zone', {
		data: t.Object({
			zone: t.String({ minLength: 1 })
		}),
		response: t.Object({ success: t.Boolean(), zone: t.String() })
	}, async ({ data }) => {
		tunnelStore.setZone(data.zone);
		return { success: true, zone: data.zone };
	})

	// Login is event-driven (push URL back via WS event)
	.on('tunnel:local:login-start', {
		data: t.Object({})
	}, async ({ conn }) => {
		const userId = ws.getUserId(conn);

		await tunnelKit.bin.ensure();
		tunnelKit.local.login({
			onUrl: (url) => {
				ws.emit.user(userId, 'tunnel:local:login-url', { url });
			},
			onComplete: () => {
				ws.emit.user(userId, 'tunnel:local:login-complete', {});
			},
			onError: (message) => {
				ws.emit.user(userId, 'tunnel:local:login-error', { message });
			}
		});
	})

	.on('tunnel:local:login-cancel', {
		data: t.Object({})
	}, async () => {
		tunnelKit.local.cancelLogin();
	})

	.http('tunnel:local:create', {
		data: t.Object({
			name: t.String({ minLength: 1, maxLength: 100 })
		}),
		response: t.Object({
			id: t.String(),
			name: t.String(),
			tunnelId: t.String()
		})
	}, async ({ data }) => {
		debug.log('tunnel', `[WS] Creating local tunnel: ${data.name}`);

		await tunnelKit.bin.ensure();
		const result = await tunnelKit.local.create(data.name);
		const config = tunnelStore.addLocal(data.name, result.tunnelId, result.credentialsFile);

		return { id: config.id, name: config.name, tunnelId: config.tunnelId };
	})

	.http('tunnel:local:delete', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		const config = tunnelStore.getLocal(data.id);
		if (!config) throw new Error('Local tunnel config not found');

		// Stop if running (tunnelKit.stop is a no-op for unknown ids).
		await tunnelKit.stop(data.id);

		// Delete from Cloudflare
		try {
			await tunnelKit.bin.ensure();
			await tunnelKit.local.delete(config.tunnelId, config.credentialsFile);
		} catch (error) {
			debug.warn('tunnel', `Could not delete tunnel from Cloudflare (may already be deleted):`, error);
		}

		tunnelStore.removeLocal(data.id);
		tunnelKit.local.cleanupFiles(config.tunnelId);
		return { success: true };
	})

	.http('tunnel:local:ingress:add', {
		data: t.Object({
			id: t.String({ minLength: 1 }),
			hostname: t.String({ minLength: 1 }),
			service: t.String({ minLength: 1 })
		}),
		response: t.Object({
			success: t.Boolean(),
			ingress: t.Array(t.Object({
				hostname: t.String(),
				service: t.String()
			})),
			dnsRouted: t.Boolean(),
			dnsError: t.Nullable(t.String())
		})
	}, async ({ data }) => {
		const tunnelConfig = tunnelStore.getLocal(data.id);
		if (!tunnelConfig) throw new Error('Local tunnel config not found');

		const config = tunnelStore.addLocalIngress(data.id, data.hostname, data.service);
		if (!config) throw new Error('Failed to add ingress rule');

		// Auto route DNS using tunnel UUID (more reliable than name)
		let dnsRouted = false;
		let dnsError: string | null = null;
		try {
			await tunnelKit.bin.ensure();
			await tunnelKit.local.routeDns(tunnelConfig.tunnelId, data.hostname);
			dnsRouted = true;
			debug.log('tunnel', `DNS routed for ${data.hostname} -> tunnel ${tunnelConfig.tunnelId}`);
		} catch (error) {
			dnsError = error instanceof Error ? error.message : String(error);
			debug.warn('tunnel', `Auto route-dns for ${data.hostname} failed:`, dnsError);
		}

		return { success: true, ingress: namedIngress(config.ingress), dnsRouted, dnsError };
	})

	.http('tunnel:local:ingress:remove', {
		data: t.Object({
			id: t.String({ minLength: 1 }),
			hostname: t.String({ minLength: 1 })
		}),
		response: t.Object({
			success: t.Boolean(),
			ingress: t.Array(t.Object({
				hostname: t.String(),
				service: t.String()
			}))
		})
	}, async ({ data }) => {
		const config = tunnelStore.removeLocalIngress(data.id, data.hostname);
		if (!config) throw new Error('Local tunnel config not found');

		// Regenerate config.yml to stay in sync
		tunnelKit.local.writeConfig(config);

		return { success: true, ingress: namedIngress(config.ingress) };
	})

	.http('tunnel:local:start', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Any()
	}, async ({ data }) => {
		const config = tunnelStore.getLocal(data.id);
		if (!config) throw new Error('Local tunnel config not found');

		debug.log('tunnel', `[WS] Starting local tunnel: ${config.name}`);
		await tunnelKit.bin.ensure();
		const { timings } = await tunnelKit.local.start(config);
		return { timings };
	})

	.http('tunnel:local:stop', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Object({ stopped: t.Boolean() })
	}, async ({ data }) => {
		await tunnelKit.stop(data.id);
		return { stopped: true };
	})

	// ═══════════════════════════════════════
	// Global Status
	// ═══════════════════════════════════════

	.http('tunnel:status', {
		data: t.Object({}),
		response: t.Object({
			tunnels: t.Array(t.Any())
		})
	}, async () => {
		return { tunnels: tunnelKit.list().map(mapActiveTunnel) };
	})

	// ═══════════════════════════════════════
	// Event declarations (Server → Client)
	// ═══════════════════════════════════════

	.emit('tunnel:status-changed', t.Object({
		tunnels: t.Array(t.Any())
	}))

	.emit('tunnel:remote:ingress-update', t.Object({
		id: t.String(),
		ingress: t.Array(t.Object({
			hostname: t.Optional(t.String()),
			service: t.String()
		}))
	}))

	.emit('tunnel:local:login-url', t.Object({
		url: t.String()
	}))

	.emit('tunnel:local:login-complete', t.Object({}))

	.emit('tunnel:local:login-error', t.Object({
		message: t.String()
	}));
