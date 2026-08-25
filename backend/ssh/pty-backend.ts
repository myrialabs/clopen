/**
 * ssh-client — a PtyKit backend whose "process" is a remote shell.
 *
 * `PtyBackend` is the seam PtyKit already uses to talk to bun-pty/node-pty:
 * spawn something, then write/resize/kill it and listen for data and exit. An
 * ssh2 shell channel answers all of that, so pointing PtyKit at this backend
 * gives the SSH terminal PtyKit's scrollback, serialized reattach, collaborative
 * rooms and reconnect without reimplementing any of it.
 *
 * The one impedance mismatch: `spawn` is synchronous while connecting is not.
 * The handle is returned immediately and queues writes and resizes until the
 * channel opens; a connection failure surfaces as terminal output followed by a
 * non-zero exit, which is exactly how a failed `ssh` invocation reads.
 */

import type {
	PtyBackend,
	PtyDisposable,
	PtyExitEvent,
	PtyProcessHandle,
	PtySpawnOptions
} from '@myrialabs/ptykit/core';
import type { ClientChannel } from 'ssh2';
import { sshConnectionQueries } from '../database/queries';
import { sshClientPool, type SshLease } from './client-pool';
import { debug } from '$shared/utils/logger';

/**
 * The `file` PtyKit passes to `spawn`. PtyKit hands `shell` through untouched,
 * so this is the one per-session channel available to name the target — and the
 * value is stamped server-side (never taken from the client) in ws/ssh/tunnel.ts.
 */
const TARGET_PREFIX = 'clopen-ssh:';

export function encodeSshTarget(connectionId: string): string {
	return `${TARGET_PREFIX}${connectionId}`;
}

function decodeSshTarget(file: string): string {
	if (!file.startsWith(TARGET_PREFIX)) {
		throw new Error('SSH terminal sessions must name a saved connection');
	}
	return file.slice(TARGET_PREFIX.length);
}

const ANSI_DIM = '\u001b[2m';
const ANSI_RED = '\u001b[31m';
const ANSI_RESET = '\u001b[0m';

/** Terminals expect CRLF; a lone \n leaves the cursor mid-line. */
function terminalLine(text: string): string {
	return `${text.replace(/\n/g, '\r\n')}\r\n`;
}

/** Single-quote a POSIX shell argument, escaping any embedded quote. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Distinct per-session ids so the tab list can tell sessions apart. */
let nextSyntheticPid = 1;

class SshShellHandle implements PtyProcessHandle {
	readonly pid: number;
	cols: number;
	rows: number;

	private readonly dataListeners = new Set<(data: string) => void>();
	private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
	private readonly pendingInput: string[] = [];

	private channel: ClientChannel | null = null;
	private lease: SshLease | null = null;
	private finished = false;

	constructor(connectionId: string, options: PtySpawnOptions) {
		this.pid = nextSyntheticPid++;
		this.cols = options.cols;
		this.rows = options.rows;
		// Deferred by one microtask on purpose: PtyKit subscribes to `onData` only
		// after `spawn` returns, so anything emitted from this constructor — the
		// "Connecting…" line, or an immediate failure — would go to nobody.
		queueMicrotask(() => void this.open(connectionId, options.name ?? 'xterm-256color'));
	}

	private emitData(data: string): void {
		for (const listener of this.dataListeners) listener(data);
	}

	private finish(exitCode: number, signal?: string): void {
		if (this.finished) return;
		this.finished = true;
		this.lease?.release();
		this.lease = null;
		for (const listener of this.exitListeners) listener({ exitCode, signal });
	}

	private async open(connectionId: string, term: string): Promise<void> {
		const connection = sshConnectionQueries.get(connectionId);
		if (!connection) {
			this.emitData(terminalLine(`${ANSI_RED}This SSH connection no longer exists.${ANSI_RESET}`));
			this.finish(1);
			return;
		}

		const address = `${connection.username}@${connection.host}:${connection.port || 22}`;
		this.emitData(terminalLine(`${ANSI_DIM}Connecting to ${address}…${ANSI_RESET}`));

		let lease: SshLease;
		try {
			lease = await sshClientPool.acquire(connectionId);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.emitData(terminalLine(`${ANSI_RED}${reason}${ANSI_RESET}`));
			this.finish(255);
			return;
		}

		// The session may have been killed while the handshake was in flight.
		if (this.finished) {
			lease.release();
			return;
		}
		this.lease = lease;

		lease.client.shell({ term, cols: this.cols, rows: this.rows }, (error, channel) => {
			if (error) {
				this.emitData(terminalLine(`${ANSI_RED}Could not open a shell: ${error.message}${ANSI_RESET}`));
				this.finish(1);
				return;
			}
			if (this.finished) {
				channel.end();
				return;
			}

			this.channel = channel;

			channel.on('data', (chunk: Buffer) => this.emitData(chunk.toString('utf8')));
			channel.stderr.on('data', (chunk: Buffer) => this.emitData(chunk.toString('utf8')));
			channel.on('close', (code?: number, signal?: string) => {
				this.channel = null;
				this.finish(typeof code === 'number' ? code : 0, signal);
			});
			channel.on('error', (channelError: Error) => {
				this.emitData(terminalLine(`${ANSI_RED}${channelError.message}${ANSI_RESET}`));
			});

			// Start where the connection says to. The `cd` is sent as ordinary
			// input so it lands in scrollback — the user can see where they are.
			if (connection.initialPath) {
				channel.write(`cd ${shellQuote(connection.initialPath)}\n`);
			}

			for (const queued of this.pendingInput) channel.write(queued);
			this.pendingInput.length = 0;

			// A resize that arrived during the handshake was recorded on the
			// handle; replay it so the remote pty matches the browser.
			channel.setWindow(this.rows, this.cols, 0, 0);
			debug.log('ssh', `shell opened on ${address}`);
		});
	}

	write(data: string): void {
		if (this.finished) return;
		if (this.channel) {
			this.channel.write(data);
			return;
		}
		this.pendingInput.push(data);
	}

	resize(cols: number, rows: number): void {
		this.cols = cols;
		this.rows = rows;
		this.channel?.setWindow(rows, cols, 0, 0);
	}

	kill(): void {
		// SSH has no signal to send a shell channel, so closing the channel is the
		// kill: the remote shell sees its pty go away and exits.
		const channel = this.channel;
		this.channel = null;
		try {
			channel?.end();
		} catch {
			// Already gone.
		}
		this.finish(0);
	}

	onData(listener: (data: string) => void): PtyDisposable {
		this.dataListeners.add(listener);
		return { dispose: () => this.dataListeners.delete(listener) };
	}

	onExit(listener: (event: PtyExitEvent) => void): PtyDisposable {
		this.exitListeners.add(listener);
		return { dispose: () => this.exitListeners.delete(listener) };
	}
}

/**
 * PtyKit's backend contract, satisfied by remote shells. The name has to be one
 * of PtyKit's two known backend identifiers — it is only used for diagnostics,
 * and the session engine never branches on it.
 */
export const sshPtyBackend: PtyBackend = {
	name: 'node-pty',
	experimental: false,
	spawn(file: string, _args: string[], options: PtySpawnOptions): PtyProcessHandle {
		return new SshShellHandle(decodeSshTarget(file), options);
	}
};
