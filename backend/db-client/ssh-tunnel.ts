/**
 * SSH tunnel — opens a local TCP listener that forwards to a remote
 * host:port through an authenticated `ssh2` client. Used by the
 * connection manager to reach databases that sit behind a bastion.
 *
 * Pattern verified end-to-end in PHASE 0 (`test-ssh-mysql.ts`):
 *   1. ssh2.Client.connect with password / privateKey + optional passphrase
 *   2. net.createServer on an ephemeral port
 *   3. for each accepted socket → client.forwardOut → pipe both directions
 *   4. close() shuts down the local listener and ends the ssh client
 */

import net from 'net';
import { Client as SshClient, type ConnectConfig } from 'ssh2';
import type { DbClientSshConfig } from '$shared/types/db-client';
import { debug } from '$shared/utils/logger';

export interface SshTunnel {
	localPort: number;
	close(): Promise<void>;
}

export async function openSshTunnel(
	ssh: DbClientSshConfig,
	remoteHost: string,
	remotePort: number
): Promise<SshTunnel> {
	if (!ssh.enabled) {
		throw new Error('SSH tunnel requested but ssh.enabled is false');
	}
	if (!ssh.host || !ssh.username) {
		throw new Error('SSH tunnel requires host and username');
	}

	const connectConfig: ConnectConfig = {
		host: ssh.host,
		port: ssh.port || 22,
		username: ssh.username,
		readyTimeout: 15_000,
		keepaliveInterval: 30_000
	};

	if (ssh.authMethod === 'key') {
		if (!ssh.privateKey) {
			throw new Error('SSH key auth requires privateKey');
		}
		connectConfig.privateKey = ssh.privateKey;
		if (ssh.passphrase) connectConfig.passphrase = ssh.passphrase;
	} else {
		if (!ssh.password) {
			throw new Error('SSH password auth requires password');
		}
		connectConfig.password = ssh.password;
	}

	const client = new SshClient();

	await new Promise<void>((resolve, reject) => {
		const onReady = (): void => {
			client.removeListener('error', onError);
			resolve();
		};
		const onError = (err: Error): void => {
			client.removeListener('ready', onReady);
			reject(err);
		};
		client.once('ready', onReady);
		client.once('error', onError);
		try {
			client.connect(connectConfig);
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});

	const server = net.createServer((socket) => {
		client.forwardOut(
			socket.remoteAddress ?? '127.0.0.1',
			socket.remotePort ?? 0,
			remoteHost,
			remotePort,
			(err, stream) => {
				if (err) {
					debug.warn('db-client', 'SSH forwardOut failed:', err.message);
					socket.destroy();
					return;
				}
				socket.pipe(stream).pipe(socket);
				stream.on('error', () => socket.destroy());
				socket.on('error', () => stream.destroy());
			}
		);
	});

	const localPort = await new Promise<number>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			if (addr && typeof addr === 'object') {
				resolve(addr.port);
			} else {
				reject(new Error('Failed to obtain ephemeral port for SSH tunnel'));
			}
		});
	});

	debug.log('db-client', `SSH tunnel up: 127.0.0.1:${localPort} → ${remoteHost}:${remotePort} via ${ssh.host}`);

	return {
		localPort,
		async close() {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			try {
				client.end();
			} catch {
				// noop — already closed
			}
		}
	};
}
