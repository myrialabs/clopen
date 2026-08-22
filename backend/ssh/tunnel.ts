/**
 * ssh-client — local port forwards opened on behalf of other features.
 *
 * The database client reaches a database behind a bastion through one of these.
 * Pointing it at a saved SSH connection (rather than at credentials copied into
 * the database connection) means the host, its jump chain and its trusted host
 * key are configured once and shared.
 *
 * The tunnel holds a pool lease for its whole life, so the transport it rides
 * cannot be swept out from under an open database connection.
 */

import net from 'node:net';
import { sshClientPool, type SshLease } from './client-pool';
import { debug } from '$shared/utils/logger';

export interface SshManagedTunnel {
	localPort: number;
	close(): Promise<void>;
}

/**
 * Open `127.0.0.1:<ephemeral>` forwarding to `remoteHost:remotePort` through
 * the saved SSH connection `connectionId`.
 */
export async function openTunnelViaSavedConnection(
	connectionId: string,
	remoteHost: string,
	remotePort: number
): Promise<SshManagedTunnel> {
	const lease: SshLease = await sshClientPool.acquire(connectionId);

	const sockets = new Set<net.Socket>();

	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));

		lease.client.forwardOut(
			socket.remoteAddress ?? '127.0.0.1',
			socket.remotePort ?? 0,
			remoteHost,
			remotePort,
			(error, stream) => {
				if (error) {
					debug.warn('ssh', `tunnel forwardOut failed: ${error.message}`);
					socket.destroy();
					return;
				}
				socket.pipe(stream).pipe(socket);
				stream.on('error', () => socket.destroy());
				socket.on('error', () => stream.destroy());
			}
		);
	});

	let localPort: number;
	try {
		localPort = await new Promise<number>((resolvePromise, rejectPromise) => {
			server.once('error', rejectPromise);
			server.listen(0, '127.0.0.1', () => {
				server.removeListener('error', rejectPromise);
				const address = server.address();
				if (address && typeof address === 'object') {
					resolvePromise(address.port);
				} else {
					rejectPromise(new Error('Failed to obtain a local port for the SSH tunnel'));
				}
			});
		});
	} catch (error) {
		lease.release();
		throw error;
	}

	debug.log('ssh', `tunnel up: 127.0.0.1:${localPort} → ${remoteHost}:${remotePort} via saved host`);

	return {
		localPort,
		async close() {
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
			lease.release();
		}
	};
}
