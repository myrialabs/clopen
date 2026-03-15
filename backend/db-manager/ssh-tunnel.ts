/**
 * SSH Tunnel Service for Database Manager
 *
 * Creates a local TCP port forwarding over SSH (using `ssh2`).
 * The tunnel maps a random local port → remoteHost:remotePort through the SSH server.
 *
 * Usage pattern:
 *   const { localPort, close } = await openSSHTunnel(config, remoteHost, remotePort);
 *   try { ... use 127.0.0.1:localPort as DB host ... }
 *   finally { close(); }
 *
 * Higher-level:
 *   return withSSHTunnel(dbConfig, (resolvedConfig) => adapter.operation());
 */

import * as net from 'net';
import type { ConnectConfig } from 'ssh2';
import type { SSHTunnelConfig } from '$shared/types/ssh-tunnel';
import type { DBConnectionConfig } from '$shared/types/db-manager';
import { debug } from '$shared/utils/logger';

export interface ActiveTunnel {
	localPort: number;
	close: () => void;
}

/**
 * Open an SSH tunnel: local random port → remoteHost:remotePort via sshConfig.
 */
export async function openSSHTunnel(
	sshConfig: SSHTunnelConfig,
	remoteHost: string,
	remotePort: number
): Promise<ActiveTunnel> {
	const { Client: SSHClient } = await import('ssh2');

	return new Promise<ActiveTunnel>((resolve, reject) => {
		const ssh = new SSHClient();

		ssh.on('ready', () => {
			const server = net.createServer((socket) => {
				ssh.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (err, stream) => {
					if (err) {
						debug.error('database', 'SSH forwardOut error:', err.message);
						socket.end();
						return;
					}
					socket.pipe(stream);
					stream.pipe(socket);
					socket.on('error', () => stream.end());
					stream.on('error', () => socket.end());
					stream.on('close', () => socket.end());
					socket.on('close', () => stream.end());
				});
			});

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address() as net.AddressInfo;
				debug.log(
					'database',
					`SSH tunnel open: 127.0.0.1:${addr.port} → ${remoteHost}:${remotePort} via ${sshConfig.host}`
				);
				resolve({
					localPort: addr.port,
					close: () => {
						server.close();
						ssh.end();
						debug.log('database', `SSH tunnel closed (was 127.0.0.1:${addr.port})`);
					}
				});
			});

			server.on('error', (err) => {
				ssh.end();
				reject(err);
			});
		});

		ssh.on('error', (err) => {
			reject(new Error(`SSH connection failed (${sshConfig.host}): ${err.message}`));
		});

		// Build ssh2 connect options
		const connectOptions: ConnectConfig = {
			host: sshConfig.host,
			port: sshConfig.port ?? 22,
			username: sshConfig.username,
			readyTimeout: 15_000
		};

		if (sshConfig.authMethod === 'password') {
			connectOptions.password = sshConfig.password ?? '';
		} else {
			connectOptions.privateKey = sshConfig.privateKey ?? '';
			if (sshConfig.passphrase) {
				connectOptions.passphrase = sshConfig.passphrase;
			}
		}

		ssh.connect(connectOptions);
	});
}

/**
 * Run `fn` with an SSH-tunnelled version of `config`.
 *
 * If sshTunnel is not enabled, calls `fn(config)` directly.
 * When tunnelling, passes a resolved config with:
 *   host = '127.0.0.1', port = localPort, sshTunnel.enabled = false
 * The `enabled = false` prevents nested calls from re-opening a second tunnel.
 */
export async function withSSHTunnel<T>(
	config: DBConnectionConfig,
	fn: (resolvedConfig: DBConnectionConfig) => Promise<T>
): Promise<T> {
	if (!config.sshTunnel?.enabled) return fn(config);

	const tunnel = await openSSHTunnel(
		config.sshTunnel,
		config.sshTunnel.remoteHost ?? config.host ?? 'localhost',
		config.sshTunnel.remotePort ?? config.port ?? 5432
	);

	try {
		// Mark tunnel as resolved so nested withSSHTunnel calls are no-ops
		const resolvedConfig: DBConnectionConfig = {
			...config,
			host: '127.0.0.1',
			port: tunnel.localPort,
			sshTunnel: { ...config.sshTunnel, enabled: false }
		};
		return await fn(resolvedConfig);
	} finally {
		tunnel.close();
	}
}
