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
import { readSystemSetting } from '$backend/settings/system-settings';
import { debug } from '$shared/utils/logger';

export type PublicOriginSource = 'configured' | 'domain' | 'tunnel';

export interface PublicOrigin {
	/** Absolute origin, no trailing slash (e.g. https://foo.trycloudflare.com). */
	origin: string;
	source: PublicOriginSource;
}

/** Hostnames that are not reachable by another device — force a tunnel. */
export function isLocalHostname(hostname: string): boolean {
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
	return readSystemSetting((settings) => {
		const url = settings.publicBaseUrl;
		return typeof url === 'string' && url.trim() ? normalizeOrigin(url.trim()) : undefined;
	}, null);
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

/** The port another device must reach: Vite's in dev (it proxies to the backend), the server's in production. */
export function getClopenPublicPort(): number {
	return SERVER_ENV.isDevelopment ? SERVER_ENV.PORT_FRONTEND : SERVER_ENV.PORT;
}

/**
 * The public origin that already exists, if any — never starts anything.
 *
 * Same order as {@link resolvePublicOrigin}, minus the side effect. A caller
 * reacting to a tunnel going away needs to know whether something is still
 * reachable without restarting the very tunnel the user may just have stopped.
 */
export function findPublicOrigin(requestOrigin?: string): PublicOrigin | null {
	const configured = getConfiguredPublicBaseUrl();
	if (configured) return { origin: configured, source: 'configured' };

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

	const existing = findQuickTunnelForPort(getClopenPublicPort());
	return existing ? { origin: existing, source: 'tunnel' } : null;
}

/**
 * Resolve a public origin for Remote Access share links. `requestOrigin` is the
 * browser's own `window.location.origin` (passed by the client), used to detect
 * the already-public `domain` case.
 */
export async function resolvePublicOrigin(requestOrigin?: string): Promise<PublicOrigin> {
	const found = findPublicOrigin(requestOrigin);
	if (found) return found;

	// Local install — tunnel Clopen's own port. In dev the app is served by
	// Vite on PORT_FRONTEND (which proxies to the backend), so tunnel that; in
	// production frontend and backend share PORT.
	const port = getClopenPublicPort();

	debug.log('tunnel', `[remote-access] Starting quick tunnel for Clopen port ${port}`);
	await tunnelKit.bin.ensure();
	const { publicUrl } = await tunnelKit.quick.start({ service: port, autoStopMinutes: 0 });
	if (!publicUrl) {
		throw new Error('Failed to establish a public tunnel');
	}
	return { origin: normalizeOrigin(publicUrl), source: 'tunnel' };
}
