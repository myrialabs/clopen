/**
 * Containers — a PtyKit backend whose "process" is a shell inside a container.
 *
 * `PtyBackend` is the seam PtyKit already uses to talk to bun-pty, and the SSH
 * client has shown it will just as happily front a remote channel. A container
 * shell is the third case, and the only one that has to be both: on this
 * machine it is `docker exec -it` under a real pty, and on a saved SSH host it
 * is the same command run through an exec channel with a pty requested. One
 * backend serves both so the local and remote shells are not two features that
 * drift apart — the only difference is which of the two `open` paths runs.
 *
 * Two things are deliberately not trusted here. The target is decoded from the
 * session namespace, which the server stamps and `authorize` has already
 * checked, so a client cannot name one host and open a shell on another. And
 * the container is verified against a live listing before anything is spawned,
 * because an id that existed when the panel rendered may since have been
 * removed and reused.
 */

import type {
	PtyBackend,
	PtyDisposable,
	PtyExitEvent,
	PtyProcessHandle,
	PtySpawnOptions
} from '@myrialabs/ptykit/core';
import { loadBackend } from '@myrialabs/ptykit/core';
import type { ClientChannel } from 'ssh2';
import { LOCAL_HOST_ID } from '$shared/types/host';
import { containerMonitor } from './monitor';
import { containerArgv, detectRuntime } from './runtime';
import { isContainerId } from './actions';
import { detectRemotePlatform, localPlatform } from '../host/runner';
import { shellQuote } from '../ssh/connect';
import { sshClientPool, type SshLease } from '../ssh/client-pool';
import { sshConnectionQueries } from '../database/queries';
import { debug } from '$shared/utils/logger';

/**
 * The `file` PtyKit passes to `spawn`. PtyKit hands `shell` through untouched,
 * so this is the one per-session channel available to name the target — and the
 * value is stamped server-side (never taken from the client) in
 * ws/containers/tunnel.ts.
 */
const TARGET_PREFIX = 'clopen-container:';

export interface ContainerTarget {
	hostId: string;
	containerId: string;
}

export function encodeContainerTarget(target: ContainerTarget): string {
	return `${TARGET_PREFIX}${target.hostId}:${target.containerId}`;
}

function decodeContainerTarget(file: string): ContainerTarget {
	if (!file.startsWith(TARGET_PREFIX)) {
		throw new Error('Container shells must name a container.');
	}
	const rest = file.slice(TARGET_PREFIX.length);
	const split = rest.lastIndexOf(':');
	if (split <= 0) throw new Error('Container shells must name a container.');
	return { hostId: rest.slice(0, split), containerId: rest.slice(split + 1) };
}

/**
 * Pick a shell inside the container without a probe round trip.
 *
 * Images built on Alpine have no `bash` and images built on Debian usually do;
 * asking first would cost an extra exec and still race a container that is
 * shutting down. `sh` is the one binary a container image can be relied on to
 * have, so it is used to choose — and then replaced, so the user's shell is the
 * process, not a child of one.
 */
const SHELL_PICK = 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi';

const ANSI_DIM = '\u001b[2m';
const ANSI_RED = '\u001b[31m';
const ANSI_RESET = '\u001b[0m';

/** Terminals expect CRLF; a lone \n leaves the cursor mid-line. */
function terminalLine(text: string): string {
	return `${text.replace(/\n/g, '\r\n')}\r\n`;
}

/** Distinct per-session ids so the tab list can tell sessions apart. */
let nextSyntheticPid = 1;

class ContainerShellHandle implements PtyProcessHandle {
	readonly pid: number;
	cols: number;
	rows: number;

	private readonly dataListeners = new Set<(data: string) => void>();
	private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
	private readonly pendingInput: string[] = [];

	/** Set on this machine: the real pty running `docker exec`. */
	private local: PtyProcessHandle | null = null;
	/** Set on a saved SSH host: the exec channel running the same command. */
	private channel: ClientChannel | null = null;
	private lease: SshLease | null = null;
	private finished = false;

	constructor(target: ContainerTarget, options: PtySpawnOptions) {
		this.pid = nextSyntheticPid++;
		this.cols = options.cols;
		this.rows = options.rows;
		// Deferred by one microtask on purpose: PtyKit subscribes to `onData` only
		// after `spawn` returns, so anything emitted from this constructor — the
		// "Attaching…" line, or an immediate failure — would go to nobody.
		queueMicrotask(() => void this.open(target, options));
	}

	private emitData(data: string): void {
		for (const listener of this.dataListeners) listener(data);
	}

	private finish(exitCode: number, signal?: string | number): void {
		if (this.finished) return;
		this.finished = true;
		this.lease?.release();
		this.lease = null;
		for (const listener of this.exitListeners) listener({ exitCode, signal });
	}

	private fail(message: string, exitCode = 1): void {
		this.emitData(terminalLine(`${ANSI_RED}${message}${ANSI_RESET}`));
		this.finish(exitCode);
	}

	private async open(target: ContainerTarget, options: PtySpawnOptions): Promise<void> {
		if (!isContainerId(target.containerId)) {
			this.fail('That is not a container id.');
			return;
		}

		let container;
		try {
			container = await containerMonitor.findContainer(target.hostId, target.containerId);
		} catch (error) {
			this.fail(error instanceof Error ? error.message : String(error));
			return;
		}
		if (!container) {
			this.fail('That container no longer exists on this host.');
			return;
		}
		if (container.state !== 'running') {
			// Stated rather than attempted: `exec` on a stopped container fails with
			// a message about the daemon, which reads like a bug rather than the
			// obvious thing it is.
			this.fail(`${container.name} is not running, so there is nothing to attach to.`);
			return;
		}

		this.emitData(terminalLine(`${ANSI_DIM}Attaching to ${container.name}…${ANSI_RESET}`));

		try {
			if (target.hostId === LOCAL_HOST_ID) await this.openLocal(target, options);
			else await this.openRemote(target, options);
		} catch (error) {
			this.fail(error instanceof Error ? error.message : String(error));
		}
	}

	/** The argv both paths run: an interactive shell inside the container. */
	private async execArgv(target: ContainerTarget, platform: ReturnType<typeof localPlatform>): Promise<string[]> {
		const info = await containerMonitor.withHost(target.hostId, (runner) =>
			detectRuntime(target.hostId, runner, platform)
		);
		if (info.problem !== 'none' || !info.runtime) {
			throw new Error('This host has no container runtime available right now.');
		}
		// `locale: null` because this one is a shell a person types into: forcing
		// the C locale on it would break every non-ASCII character they enter.
		return containerArgv(
			info.runtime,
			platform,
			['exec', '--interactive', '--tty', target.containerId, 'sh', '-c', SHELL_PICK],
			{ locale: null }
		);
	}

	private async openLocal(target: ContainerTarget, options: PtySpawnOptions): Promise<void> {
		const argv = await this.execArgv(target, localPlatform());
		if (this.finished) return;

		// PtyKit's own backend, borrowed: this is a real local process and deserves
		// the real pty, rather than a second implementation of one.
		const backend = await loadBackend();
		if (this.finished) return;

		const handle = backend.spawn(argv[0], argv.slice(1), {
			...options,
			cols: this.cols,
			rows: this.rows
		});
		this.local = handle;

		handle.onData((data) => this.emitData(data));
		handle.onExit((event) => {
			this.local = null;
			this.finish(event.exitCode, event.signal);
		});

		for (const queued of this.pendingInput) handle.write(queued);
		this.pendingInput.length = 0;
		handle.resize(this.cols, this.rows);
	}

	private async openRemote(target: ContainerTarget, options: PtySpawnOptions): Promise<void> {
		const connection = sshConnectionQueries.get(target.hostId);
		if (!connection) throw new Error('That SSH host no longer exists.');

		const platform = await containerMonitor.withHost(target.hostId, (runner) =>
			detectRemotePlatform(target.hostId, runner)
		);
		const argv = await this.execArgv(target, platform);
		if (this.finished) return;

		// Its own lease rather than the shared queued runner: this channel stays
		// open for as long as the shell does, and everything queued behind it
		// would wait just as long.
		const lease = await sshClientPool.acquire(target.hostId);
		if (this.finished) {
			lease.release();
			return;
		}
		this.lease = lease;

		const command = argv.map(shellQuote).join(' ');
		const term = options.name ?? 'xterm-256color';

		await new Promise<void>((resolve, reject) => {
			lease.client.exec(
				command,
				{ pty: { term, cols: this.cols, rows: this.rows, width: 0, height: 0 } },
				(error, channel) => {
					if (error) {
						reject(new Error(`Could not open a shell in the container: ${error.message}`));
						return;
					}
					if (this.finished) {
						channel.end();
						resolve();
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

					for (const queued of this.pendingInput) channel.write(queued);
					this.pendingInput.length = 0;
					channel.setWindow(this.rows, this.cols, 0, 0);
					debug.log('containers', `shell opened in ${target.containerId} on ${connection.name}`);
					resolve();
				}
			);
		});
	}

	write(data: string): void {
		if (this.finished) return;
		if (this.local) {
			this.local.write(data);
			return;
		}
		if (this.channel) {
			this.channel.write(data);
			return;
		}
		this.pendingInput.push(data);
	}

	resize(cols: number, rows: number): void {
		this.cols = cols;
		this.rows = rows;
		this.local?.resize(cols, rows);
		this.channel?.setWindow(rows, cols, 0, 0);
	}

	kill(signal?: string): void {
		const local = this.local;
		this.local = null;
		try {
			local?.kill(signal);
		} catch {
			// Already gone.
		}

		// SSH has no signal to send an exec channel, so closing it is the kill:
		// the remote `docker exec` sees its pty go away and exits, taking the
		// shell inside the container with it.
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
 * PtyKit's backend contract, satisfied by container shells. The name has to be
 * one of PtyKit's two known backend identifiers — it is only used for
 * diagnostics, and the session engine never branches on it.
 */
export const containerPtyBackend: PtyBackend = {
	name: 'node-pty',
	experimental: false,
	spawn(file: string, _args: string[], options: PtySpawnOptions): PtyProcessHandle {
		return new ContainerShellHandle(decodeContainerTarget(file), options);
	}
};
