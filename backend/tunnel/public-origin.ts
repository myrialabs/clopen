/**
 * Public origin resolution for Remote Access.
 *
 * "Make this Clopen reachable from another device" needs a public origin to
 * build share links against. Where that origin comes from is adaptive, so the
 * caller never has to think about tunnels vs domains:
 *
 *   1. `configured` — an admin-set public URL (system setting `publicBaseUrl`),
 *      for VPS/reverse-proxy deployments where the browser can't see the real
 *      hostname.
 *   2. `domain` — the browser is already hitting Clopen on a non-local origin
 *      (a real deployment), so reuse that origin directly. No tunnel needed.
 *   3. `tunnel` — local install: start (or reuse) a Cloudflare quick tunnel to
 *      Clopen's own server port and use its `*.trycloudflare.com` URL.
 */

import { tunnelKit, portFromService } from './tunnel-config';
import { SERVER_ENV } from '../utils/env';
import { settingsQueries } from '$backend/database/queries';
import { debug } from '$shared/utils/logger';

export type PublicOriginSource = 'configured' | 'domain' | 'tunnel';

export interface PublicOrigin {
	/** Absolute origin, no trailing slash (e.g. https://foo.trycloudflare.com). */
	origin: string;
	source: PublicOriginSource;
}

/** Hostnames that are not reachable by another device — force a tunnel. */
function isLocalHostname(hostname: string): boolean {
	const h = hostname.toLowerCase();
	if (h === 'localhost' || h.endsWith('.localhost')) return true;
	if (h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true;
	// Private LAN ranges (RFC1918 + link-local + CGNAT).
	if (/^10\./.test(h)) return true;
	if (/^192\.168\./.test(h)) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
	if (/^169\.254\./.test(h)) return true;
	if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
	// `.local` mDNS names resolve on-LAN only.
	if (h.endsWith('.local')) return true;
	return false;
}

/** Strip a trailing slash so callers can append `/#invite/...` cleanly. */
function normalizeOrigin(url: string): string {
	return url.replace(/\/+$/, '');
}

/** Read the admin-configured public base URL from system settings, if any. */
function getConfiguredPublicBaseUrl(): string | null {
	try {
		const setting = settingsQueries.get('system:settings');
		if (!setting?.value) return null;
		const parsed = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
		const url = parsed?.publicBaseUrl;
		if (typeof url === 'string' && url.trim()) {
			return normalizeOrigin(url.trim());
		}
	} catch {
		// Settings may not exist yet.
	}
	return null;
}

/** Find an already-running quick tunnel pointing at the given local port. */
function findQuickTunnelForPort(port: number): string | null {
	for (const t of tunnelKit.list()) {
		if (t.type === 'quick' && portFromService(t.service) === port && t.publicUrl) {
			return normalizeOrigin(t.publicUrl);
		}
	}
	return null;
}

/**
 * Resolve a public origin for Remote Access share links. `requestOrigin` is the
 * browser's own `window.location.origin` (passed by the client), used to detect
 * the already-public `domain` case.
 */
export async function resolvePublicOrigin(requestOrigin?: string): Promise<PublicOrigin> {
	// 1. Explicitly configured public URL wins.
	const configured = getConfiguredPublicBaseUrl();
	if (configured) {
		return { origin: configured, source: 'configured' };
	}

	// 2. Already served on a real (non-local) origin — reuse it.
	if (requestOrigin) {
		try {
			const url = new URL(requestOrigin);
			if (!isLocalHostname(url.hostname)) {
				return { origin: normalizeOrigin(requestOrigin), source: 'domain' };
			}
		} catch {
			// Malformed origin — fall through to tunnel.
		}
	}

	// 3. Local install — tunnel Clopen's own port. In dev the app is served by
	// Vite on PORT_FRONTEND (which proxies to the backend), so tunnel that; in
	// production frontend and backend share PORT.
	const port = SERVER_ENV.isDevelopment ? SERVER_ENV.PORT_FRONTEND : SERVER_ENV.PORT;

	const existing = findQuickTunnelForPort(port);
	if (existing) {
		return { origin: existing, source: 'tunnel' };
	}

	debug.log('tunnel', `[remote-access] Starting quick tunnel for Clopen port ${port}`);
	await tunnelKit.bin.ensure();
	const { publicUrl } = await tunnelKit.quick.start({ service: port, autoStopMinutes: 0 });
	if (!publicUrl) {
		throw new Error('Failed to establish a public tunnel');
	}
	return { origin: normalizeOrigin(publicUrl), source: 'tunnel' };
}
