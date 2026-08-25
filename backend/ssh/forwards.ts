/**
 * ssh-client — port forwarding, in all three shapes OpenSSH offers.
 *
 * - local   (-L) a TCP listener here; each connection becomes a channel to
 *                `dest` opened from the remote host.
 * - remote  (-R) the remote host listens; what arrives there is piped to a
 *                socket this process opens to `dest`.
 * - dynamic (-D) a SOCKS5 listener here; the destination comes per request.
 *
 * A running forward holds a pool lease, so the shared transport stays up for as
 * long as any forward on it is running, and stops being held the moment it is.
 */

import net, { type Socket } from 'node:net';
import type { Client as SshClient } from 'ssh2';
import { sshPortForwardQueries } from '../database/queries';
import { sshClientPool, type SshLease } from './client-pool';
import { readSocksRequest, socksReply, SOCKS_REPLY_HOST_UNREACHABLE, SOCKS_REPLY_SUCCESS } from './socks5';
import type { SshForward, SshForwardStatus } from '$shared/types/ssh';
import { debug } from '$shared/utils/logger';

interface RunningForward {
	forward: SshForward;
	lease: SshLease;
	/** Present for local and dynamic forwards; remote forwards listen remotely. */
	server: net.Server | null;
	boundPort: number;
	connectionCount: number;
	error: string | null;
	/** Sockets currently piped, so stopping a forward also drops its traffic. */
	sockets: Set<Socket>;
}

/**
 * ssh2 emits one `tcp connection` event per client for every remote forward on
 * it, so a shared transport needs a dispatcher rather than one listener per
 * forward. Keyed by connection id; the inner map is keyed by remote port.
 */
type RemoteRouter = Map<number, RunningForward>;

function pipeSockets(local: NodeJS.ReadWriteStream, remote: NodeJS.ReadWriteStream): void {
	local.pipe(remote);
	remote.pipe(local);
	const drop = (): void => {
		// Destroying both ends on either failure avoids a half-open pair that
		// holds a channel open forever.
		(local as Socket).destroy?.();
		(remote as Socket).destroy?.();
	};
	local.on('error', drop);
	remote.on('error', drop);
}

class SshForwardManager {
	private running = new Map<string, RunningForward>();
	private remoteRouters = new Map<string, RemoteRouter>();
	private remoteListenerInstalled = new Set<string>();

	isRunning(forwardId: string): boolean {
		return this.running.has(forwardId);
	}

	status(forward: SshForward): SshForwardStatus {
		const active = this.running.get(forward.id);
		if (!active) {
			return { id: forward.id, running: false, boundPort: null, connectionCount: 0, error: null };
		}
		return {
			id: forward.id,
			running: true,
			boundPort: active.boundPort,
			connectionCount: active.connectionCount,
			error: active.error
		};
	}

	statusesForConnection(connectionId: string): SshForwardStatus[] {
		return sshPortForwardQueries.listForConnection(connectionId).map((forward) => this.status(forward));
	}

	/** Start every forward on a host that is marked auto-start and is not up yet. */
	async startAutoForwards(connectionId: string): Promise<void> {
		const forwards = sshPortForwardQueries.listForConnection(connectionId);
		for (const forward of forwards) {
			if (!forward.autoStart || this.isRunning(forward.id)) continue;
			try {
				await this.start(forward);
			} catch (error) {
				debug.warn(
					'ssh',
					`auto-start failed for forward ${forward.name}: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
	}

	async start(forward: SshForward): Promise<SshForwardStatus> {
		if (this.running.has(forward.id)) {
			return this.status(forward);
		}

		const lease = await sshClientPool.acquire(forward.connectionId);
		const active: RunningForward = {
			forward,
			lease,
			server: null,
			boundPort: forward.listenPort,
			connectionCount: 0,
			error: null,
			sockets: new Set()
		};

		try {
			if (forward.type === 'remote') {
				await this.startRemote(active, lease.client);
			} else {
				await this.startLocalListener(active, lease.client);
			}
		} catch (error) {
			lease.release();
			throw error;
		}

		this.running.set(forward.id, active);
		debug.log('ssh', `forward ${forward.name} (${forward.type}) started on port ${active.boundPort}`);
		return this.status(forward);
	}

	/** Local and dynamic both listen here; only what happens per socket differs. */
	private async startLocalListener(active: RunningForward, client: SshClient): Promise<void> {
		const { forward } = active;

		const server = net.createServer((socket) => {
			active.sockets.add(socket);
			socket.on('close', () => active.sockets.delete(socket));

			if (forward.type === 'dynamic') {
				void this.handleSocksSocket(active, client, socket);
				return;
			}

			active.connectionCount++;
			client.forwardOut(
				socket.remoteAddress ?? '127.0.0.1',
				socket.remotePort ?? 0,
				forward.destHost ?? '127.0.0.1',
				forward.destPort ?? 0,
				(error, stream) => {
					if (error) {
						active.error = error.message;
						socket.destroy();
						return;
					}
					pipeSockets(socket, stream);
				}
			);
		});

		server.on('error', (error: Error) => {
			active.error = error.message;
		});

		await new Promise<void>((resolvePromise, rejectPromise) => {
			server.once('error', rejectPromise);
			server.listen(forward.listenPort, forward.listenHost || '127.0.0.1', () => {
				server.removeListener('error', rejectPromise);
				const address = server.address();
				if (address && typeof address === 'object') {
					active.boundPort = address.port;
				}
				resolvePromise();
			});
		});

		active.server = server;
	}

	private async handleSocksSocket(active: RunningForward, client: SshClient, socket: Socket): Promise<void> {
		let request;
		try {
			request = await readSocksRequest(socket);
		} catch (error) {
			active.error = error instanceof Error ? error.message : String(error);
			socket.destroy();
			return;
		}

		active.connectionCount++;
		client.forwardOut(
			socket.remoteAddress ?? '127.0.0.1',
			socket.remotePort ?? 0,
			request.host,
			request.port,
			(error, stream) => {
				if (error) {
					active.error = error.message;
					if (socket.writable) socket.end(socksReply(SOCKS_REPLY_HOST_UNREACHABLE));
					return;
				}
				socket.write(socksReply(SOCKS_REPLY_SUCCESS));
				pipeSockets(socket, stream);
			}
		);
	}

	private async startRemote(active: RunningForward, client: SshClient): Promise<void> {
		const { forward } = active;
		this.installRemoteListener(forward.connectionId, client);

		const boundPort = await new Promise<number>((resolvePromise, rejectPromise) => {
			client.forwardIn(forward.listenHost || '127.0.0.1', forward.listenPort, (error, port) => {
				if (error) {
					rejectPromise(new Error(`The host refused to listen on ${forward.listenPort}: ${error.message}`));
					return;
				}
				// Port 0 asks the host to choose; it reports the real one back.
				resolvePromise(forward.listenPort === 0 ? port : forward.listenPort);
			});
		});

		active.boundPort = boundPort;

		const router = this.remoteRouters.get(forward.connectionId) ?? new Map<number, RunningForward>();
		router.set(boundPort, active);
		this.remoteRouters.set(forward.connectionId, router);
	}

	/**
	 * One `tcp connection` handler per transport, dispatching by the port the
	 * remote side accepted on. Installed once — a second `client.on` per forward
	 * would deliver every connection to every forward.
	 */
	private installRemoteListener(connectionId: string, client: SshClient): void {
		if (this.remoteListenerInstalled.has(connectionId)) return;
		this.remoteListenerInstalled.add(connectionId);

		client.on('tcp connection', (info, accept, reject) => {
			const router = this.remoteRouters.get(connectionId);
			const active = router?.get(info.destPort);
			if (!active) {
				reject();
				return;
			}

			active.connectionCount++;
			const stream = accept();
			const socket = net.connect(
				active.forward.destPort ?? 0,
				active.forward.destHost ?? '127.0.0.1',
				() => pipeSockets(socket, stream)
			);
			active.sockets.add(socket);
			socket.on('close', () => active.sockets.delete(socket));
			socket.on('error', (error: Error) => {
				active.error = error.message;
				stream.destroy();
			});
		});

		// The transport can drop underneath us; forget the bookkeeping so a later
		// start reinstalls the handler on the new client.
		const forget = (): void => {
			this.remoteListenerInstalled.delete(connectionId);
			this.remoteRouters.delete(connectionId);
		};
		client.on('close', forget);
		client.on('end', forget);
	}

	async stop(forwardId: string): Promise<void> {
		const active = this.running.get(forwardId);
		if (!active) return;
		this.running.delete(forwardId);

		for (const socket of active.sockets) socket.destroy();
		active.sockets.clear();

		if (active.server) {
			await new Promise<void>((resolvePromise) => active.server?.close(() => resolvePromise()));
		}

		if (active.forward.type === 'remote') {
			const router = this.remoteRouters.get(active.forward.connectionId);
			router?.delete(active.boundPort);
			try {
				active.lease.client.unforwardIn(active.forward.listenHost || '127.0.0.1', active.boundPort);
			} catch {
				// The transport may already be gone; the remote listener dies with it.
			}
		}

		active.lease.release();
		debug.log('ssh', `forward ${active.forward.name} stopped`);
	}

	/** Stop every forward belonging to a host. Used on edit, delete and shutdown. */
	async stopForConnection(connectionId: string): Promise<void> {
		const ids = [...this.running.values()]
			.filter((active) => active.forward.connectionId === connectionId)
			.map((active) => active.forward.id);
		for (const id of ids) await this.stop(id);
	}

	async stopAll(): Promise<void> {
		for (const id of [...this.running.keys()]) await this.stop(id);
	}
}

export const sshForwardManager = new SshForwardManager();
