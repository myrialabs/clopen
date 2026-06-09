/**
 * Tunnel config & runtime — owns the single `TunnelKit` instance and the
 * `TunnelStore` it auto-saves to (`~/.clopen/tunnel/config.json`). The WS layer
 * reads/writes the store directly and calls `tunnelKit.*` for lifecycle
 * operations (start/stop/create/login/…), so we don't need a separate manager.
 */

import { join } from 'path';
import { TunnelKit, TunnelStore, type ActiveTunnel, type IngressInfo, type TunnelType } from 'tunnelkit';
import { getClopenDir } from '../utils/paths';
import { debug } from '$shared/utils/logger';

/**
 * Narrow tunnelkit's `IngressInfo[]` (where `hostname` is optional, to allow
 * catch-all remote rules) to the hostname-bearing rules local tunnels always
 * have — the shape the local WS responses declare.
 */
export function namedIngress(ingress: IngressInfo[]): { hostname: string; service: string }[] {
	return ingress.filter((r): r is { hostname: string; service: string } => typeof r.hostname === 'string');
}

// --- Paths ---

const TUNNEL_DIR = join(getClopenDir(), 'tunnel');

export function getTunnelDir(): string {
	return TUNNEL_DIR;
}

// --- Shared logger ---

const tunnelLogger = {
	log: (...args: unknown[]) => debug.log('tunnel', ...args),
	warn: (...args: unknown[]) => debug.warn('tunnel', ...args),
	error: (...args: unknown[]) => debug.error('tunnel', ...args)
};

// --- Singleton store + kit ---

export const tunnelStore = new TunnelStore({ dataDir: TUNNEL_DIR, logger: tunnelLogger });

/**
 * The shared `TunnelKit` instance the WS layer uses. Persistence is on (via
 * `tunnelStore`), and tunnelkit's default `isTunnelKnown` predicate
 * automatically treats any tunnel in the store as known, so name-conflict
 * recovery won't delete tunnels we already track.
 */
export const tunnelKit = new TunnelKit({
	dataDir: TUNNEL_DIR,
	store: tunnelStore,
	logger: tunnelLogger
});

// --- ActiveTunnel adapter ---

export interface ActiveTunnelInfo {
	port: number;
	publicUrl: string;
	startedAt: string;
	autoStopMinutes: number;
	type: TunnelType;
	name?: string;
	id?: string;
	ingress?: IngressInfo[];
	/** Number of live edge connections cloudflared has to Cloudflare; > 0 means the tunnel is publicly reachable. */
	connections: number;
}

/** Recover the local port from a quick tunnel's resolved service URL (Clopen only ever exposes localhost ports). */
export function portFromService(service?: string): number {
	if (!service) return 0;
	try {
		return Number(new URL(service).port) || 0;
	} catch {
		return 0;
	}
}

/** Flatten tunnelkit's `ActiveTunnel` into the UI-facing shape (port extraction, connection count, etc.). */
export function mapActiveTunnel(t: ActiveTunnel): ActiveTunnelInfo {
	return t.type === 'quick'
		? {
				port: portFromService(t.service),
				publicUrl: t.publicUrl,
				startedAt: t.startedAt,
				autoStopMinutes: t.autoStopMinutes ?? 0,
				type: t.type,
				connections: t.connections.length
			}
		: {
				port: 0,
				publicUrl: t.publicUrl,
				startedAt: t.startedAt,
				autoStopMinutes: 0,
				type: t.type,
				name: t.name,
				id: t.id,
				ingress: t.ingress,
				connections: t.connections.length
			};
}
