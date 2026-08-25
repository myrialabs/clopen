/**
 * Port manager — the listeners Clopen itself is responsible for.
 *
 * This is the tier where a label is a fact rather than a guess, so it is built
 * by asking each feature what it currently holds open instead of keeping a
 * second list that features must remember to update. A registration that
 * drifts is worse than none: it would confidently mislabel someone else's port.
 *
 * A Cloudflare tunnel is deliberately not an owner. `cloudflared` dials the
 * local service rather than binding it, so the port still belongs to whatever
 * is listening — the tunnel only means that port is also reachable from the
 * public internet, which is recorded separately as an exposure.
 */

import type { PortOwnerFeature, PortProtocol } from '$shared/types/ports';
import { LOCAL_PORT_HOST } from '$shared/types/ports';
import { SERVER_ENV } from '../utils/env';
import { sshForwardManager } from '../ssh/forwards';
import { connectionManager } from '../db-client/connection-manager';
import { sshConnectionQueries } from '../database/queries';
import { tunnelKit, portFromService } from '../tunnel/tunnel-config';
import { debug } from '$shared/utils/logger';

export interface OwnedPort {
	protocol: PortProtocol;
	port: number;
	feature: PortOwnerFeature;
	/** The record this port belongs to, so the UI can offer the right stop path. */
	ownerId: string | null;
	label: string;
	detail: string | null;
	/** Clopen's own socket must never be offered as something to kill. */
	isClopenItself: boolean;
}

/** A port that is reachable publicly, keyed the same way as owned ports. */
export interface ExposedPort {
	port: number;
	publicUrl: string;
}

function key(protocol: PortProtocol, port: number): string {
	return `${protocol}:${port}`;
}

/**
 * Ports Clopen opened on a given host, keyed `protocol:port`.
 *
 * Both kinds of host are answered here so neither is a special case: on the
 * machine Clopen runs on that means its own socket, its local forwards and its
 * database tunnels; on an SSH host it means the ports Clopen asked that host's
 * sshd to bind. A remote forward is Clopen's doing just as much as a local one,
 * and the panel says so in the same words.
 */
export function collectOwnedPorts(hostId: string): Map<string, OwnedPort> {
	return hostId === LOCAL_PORT_HOST ? collectLocalOwnedPorts() : collectRemoteOwnedPorts(hostId);
}

function collectRemoteOwnedPorts(connectionId: string): Map<string, OwnedPort> {
	const owned = new Map<string, OwnedPort>();

	try {
		for (const { forward, boundPort } of sshForwardManager.remoteListeners(connectionId)) {
			owned.set(key('tcp', boundPort), {
				protocol: 'tcp',
				port: boundPort,
				feature: 'ssh-forward',
				ownerId: forward.id,
				label: `SSH forward — ${forward.name}`,
				detail: `Clopen asked this host to listen, and forwards to ${forward.destHost}:${forward.destPort}`,
				isClopenItself: false
			});
		}
	} catch (error) {
		debug.log('ports', 'could not read remote SSH forwards:', error);
	}

	return owned;
}

function collectLocalOwnedPorts(): Map<string, OwnedPort> {
	const owned = new Map<string, OwnedPort>();

	owned.set(key('tcp', SERVER_ENV.PORT), {
		protocol: 'tcp',
		port: SERVER_ENV.PORT,
		feature: 'server',
		ownerId: null,
		label: 'Clopen server',
		detail: 'The app you are looking at right now',
		isClopenItself: true
	});

	// In development the UI is served by Vite on its own port, in a process
	// Clopen does not parent. It is still Clopen as far as anyone using it is
	// concerned — and stopping it would take away the page they are reading.
	if (SERVER_ENV.isDevelopment) {
		owned.set(key('tcp', SERVER_ENV.PORT_FRONTEND), {
			protocol: 'tcp',
			port: SERVER_ENV.PORT_FRONTEND,
			feature: 'server',
			ownerId: null,
			label: 'Clopen frontend',
			detail: 'Vite dev server for the interface you are looking at',
			isClopenItself: true
		});
	}

	try {
		for (const { forward, boundPort } of sshForwardManager.localListeners()) {
			const host = sshConnectionQueries.get(forward.connectionId);
			const via = host ? ` via ${host.name}` : '';
			owned.set(key('tcp', boundPort), {
				protocol: 'tcp',
				port: boundPort,
				feature: 'ssh-forward',
				ownerId: forward.id,
				label: `SSH forward — ${forward.name}`,
				detail:
					forward.type === 'dynamic'
						? `SOCKS5 proxy${via}`
						: `Forwards to ${forward.destHost}:${forward.destPort}${via}`,
				isClopenItself: false
			});
		}
	} catch (error) {
		debug.log('ports', 'could not read SSH forwards:', error);
	}

	try {
		for (const { connectionId, localPort } of connectionManager.activeTunnelPorts()) {
			owned.set(key('tcp', localPort), {
				protocol: 'tcp',
				port: localPort,
				feature: 'db-client-tunnel',
				ownerId: connectionId,
				label: 'DB Client SSH tunnel',
				detail: 'Carries one database connection over SSH',
				isClopenItself: false
			});
		}
	} catch (error) {
		debug.log('ports', 'could not read DB Client tunnels:', error);
	}

	return owned;
}

/** Local ports currently published through a Cloudflare tunnel. */
export function collectExposedPorts(): Map<number, string> {
	const exposed = new Map<number, string>();

	try {
		for (const tunnel of tunnelKit.list()) {
			const port = portFromService(tunnel.service);
			if (port > 0 && tunnel.publicUrl) exposed.set(port, tunnel.publicUrl);
		}
	} catch (error) {
		debug.log('ports', 'could not read tunnels:', error);
	}

	return exposed;
}

export const ownedPortKey = key;
