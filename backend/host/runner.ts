/**
 * Host commands — one command interface, two transports.
 *
 * Every host-scoped feature in Clopen — the port table, and the container list
 * that followed it — is built out of small POSIX/Windows commands, and the same
 * command has to run on the machine hosting Clopen and on a saved SSH host. So
 * they are written once against `CommandRunner` and the transport is swapped
 * underneath: `Bun.spawn` locally, an exec channel remotely.
 *
 * Commands are argv arrays rather than shell strings. Locally that removes
 * quoting from the picture entirely; remotely each argument is quoted by
 * `shellQuote` on the way out, so a hostile process or container name in an
 * argument can never turn into a second command.
 *
 * This lives outside `ports/` because `local` is not a special case and neither
 * is any one feature: whatever asks a host a question asks it through here.
 */

import type { Client as SshClient } from 'ssh2';
import { runCommandDetailed, shellQuote } from '../ssh/connect';
import { sshClientPool } from '../ssh/client-pool';
import { debug } from '$shared/utils/logger';

/**
 * The directories a probe might live in, prepended for every POSIX command.
 *
 * A non-interactive SSH exec channel gets whatever PATH the account's shell
 * sets up, and on shared hosting that routinely omits `/usr/sbin` and `/sbin`
 * — which is exactly where `ss`, `netstat` and `lsof` are installed. Without
 * this, a host with every tool present still reports having none.
 */
const PROBE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/homebrew/bin';

/**
 * Wrap a POSIX command so it runs with a predictable PATH and locale.
 *
 * Going through `env` rather than a shell keeps the no-shell rule intact —
 * arguments stay arguments — while fixing both problems a bare command has on
 * a remote host: a PATH too narrow to find the tool, and a locale that renders
 * dates in words nothing can parse.
 *
 * `locale: null` drops the `LC_ALL=C` half. A probe wants a machine-readable
 * locale; an interactive shell opened through the same PATH fix does not —
 * forcing C on one would leave the user unable to type a non-ASCII character.
 */
export function posixArgv(argv: string[], options: { locale?: string | null } = {}): string[] {
	const locale = options.locale === undefined ? 'C' : options.locale;
	return ['env', ...(locale === null ? [] : [`LC_ALL=${locale}`]), `PATH=${PROBE_PATH}`, ...argv];
}

export interface RunResult {
	stdout: string;
	stderr: string;
	code: number;
}

/** Platforms the probes know how to interrogate. */
export type ProbePlatform = 'darwin' | 'linux' | 'win32' | 'unknown';

export interface CommandRunner {
	/** Human label for logs and errors ("this machine", the host name). */
	readonly label: string;
	run(argv: string[], timeoutMs?: number): Promise<RunResult>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Runs probes on the machine Clopen itself is running on. */
export class LocalCommandRunner implements CommandRunner {
	readonly label = 'this machine';

	async run(argv: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
		const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
		// A probe that hangs must not wedge the poll loop; kill it and report
		// the timeout as a failed command so the caller can fall back.
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				// Already gone — nothing to do.
			}
		}, timeoutMs);
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited
			]);
			return { stdout, stderr, code };
		} finally {
			clearTimeout(timer);
		}
	}
}

/**
 * Runs probes on a saved SSH host over the shared pooled transport, so the
 * scan reuses whatever connection the terminal and file browser already hold
 * open instead of dialing its own.
 */
export class SshCommandRunner implements CommandRunner {
	/**
	 * Commands run one at a time on a connection.
	 *
	 * Every `exec` opens an SSH channel, and sshd caps how many a connection may
	 * hold at once — `MaxSessions`, ten by default. A scan issues several
	 * commands, and the terminal, SFTP browser and forwards share the same
	 * transport, so letting them overlap exhausts that budget and the server
	 * answers `Unable to exec` before dropping the connection outright. Queueing
	 * costs a little latency and removes the ceiling entirely.
	 */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		readonly label: string,
		private readonly client: SshClient
	) {}

	async run(argv: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
		const command = argv.map(shellQuote).join(' ');
		// Chained on the tail whether or not the previous command succeeded, so
		// one failure cannot wedge every command behind it.
		const result = this.queue.then(
			() => runCommandDetailed(this.client, command, timeoutMs),
			() => runCommandDetailed(this.client, command, timeoutMs)
		);
		this.queue = result.catch(() => undefined);

		const { stdout, stderr, code } = await result;
		return { stdout, stderr, code };
	}
}

/** Borrow a pooled SSH transport for the duration of `fn`. */
export async function withSshRunner<T>(
	connectionId: string,
	label: string,
	fn: (runner: CommandRunner) => Promise<T>
): Promise<T> {
	const lease = await sshClientPool.acquire(connectionId);
	try {
		return await fn(new SshCommandRunner(label, lease.client));
	} finally {
		lease.release();
	}
}

/**
 * Which OS a runner is talking to. Local is known outright; a remote host is
 * asked once and remembered, because `uname` per scan tick is a round-trip
 * spent on an answer that cannot change while the connection lives.
 */
const remotePlatforms = new Map<string, ProbePlatform>();

export function localPlatform(): ProbePlatform {
	switch (process.platform) {
		case 'darwin':
			return 'darwin';
		case 'linux':
			return 'linux';
		case 'win32':
			return 'win32';
		default:
			// The BSDs answer the Linux probes closely enough to be worth trying.
			return process.platform === 'freebsd' || process.platform === 'openbsd' ? 'linux' : 'unknown';
	}
}

export async function detectRemotePlatform(cacheKey: string, runner: CommandRunner): Promise<ProbePlatform> {
	const cached = remotePlatforms.get(cacheKey);
	if (cached) return cached;

	let platform: ProbePlatform = 'unknown';
	try {
		const result = await runner.run(['uname', '-s'], 5_000);
		const name = result.stdout.trim().toLowerCase();
		if (result.code === 0 && name) {
			if (name.includes('darwin')) platform = 'darwin';
			else if (name.includes('linux')) platform = 'linux';
			else if (name.includes('bsd')) platform = 'linux';
		}
	} catch (error) {
		debug.log('host', `uname failed on ${runner.label}:`, error);
	}

	// No `uname` usually means a Windows host answering over OpenSSH, where the
	// shell is cmd and `ver` is the equivalent question.
	if (platform === 'unknown') {
		try {
			const result = await runner.run(['cmd', '/c', 'ver'], 5_000);
			if (result.code === 0 && /windows/i.test(result.stdout)) platform = 'win32';
		} catch {
			// Leave it unknown — the caller reports that honestly.
		}
	}

	remotePlatforms.set(cacheKey, platform);
	return platform;
}

/** Drop a host's cached platform when its connection goes away. */
export function forgetRemotePlatform(cacheKey: string): void {
	remotePlatforms.delete(cacheKey);
}
