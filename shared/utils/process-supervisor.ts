/**
 * Keep a long-running child process (the Clopen server, the dev frontend) up.
 *
 * Shared by the production launcher (bin/clopen.ts) and the dev runner
 * (scripts/dev.ts) so both stop and recover the same way:
 *
 * - **Its own process group** (POSIX). A signal aimed at one process group —
 *   by an agent's tooling, a terminal, anything — no longer reaches the
 *   others. Windows has no process groups to speak of and `detached` there
 *   means a new console, so it is left as is.
 * - **Restarted when it exits without being asked to.** Exit codes cannot tell
 *   the difference: a server that received a stray SIGTERM shuts down cleanly
 *   and exits 0. What can is whether this supervisor asked it to stop. A child
 *   that keeps dying (5 times in 60 s) is given up on instead of looping.
 * - **Stopped on request.** SIGINT/SIGTERM to the supervisor are forwarded to
 *   the child's whole group — what a terminal did before the child had a group
 *   of its own — then it gets 15 s to finish before SIGKILL. A second signal
 *   forces it; a second programmatic `stop()` does not. SIGHUP is ignored,
 *   matching the server, which deliberately keeps running when its terminal or
 *   SSH session closes; the supervisor stays with it, and writes to a terminal
 *   that is gone are dropped instead of crashing.
 * - **Diagnosed.** Each unrequested exit is logged with its code or signal and
 *   the processes started shortly before it (pid, ppid, pgid, command), to the
 *   console and to `reportFile`, so the next occurrence leaves a trail. The OS
 *   never says who sent a signal; what was running when it arrived is the
 *   best available evidence.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type Subprocess = ReturnType<typeof Bun.spawn>;

export interface SupervisedProcessOptions {
	/** Short label for log lines, e.g. `server`. */
	name: string;
	cmd: string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
	/** Where each chunk of the child's output goes. Defaults to inheriting. */
	onStdout?: (chunk: Uint8Array) => void;
	onStderr?: (chunk: Uint8Array) => void;
	/** Lines the supervisor itself prints (restarts, diagnostics). */
	log?: (line: string) => void;
	/** Append-only file for unrequested-exit diagnostics. */
	reportFile?: string;
	/** Defaults: 5 restarts per 60 s, 15 s to stop, 1 s first restart delay. */
	maxRestarts?: number;
	restartWindowMs?: number;
	stopTimeoutMs?: number;
	restartDelayMs?: number;
}

export interface Supervisor {
	/** Resolves with the child's final exit code once it is stopped or given up on. */
	readonly done: Promise<number>;
	/** Ask the child to stop (forwarding `signal` to its group). Idempotent. */
	stop(signal?: NodeJS.Signals): Promise<number>;
	/** Stop now: SIGKILL the child's group. */
	kill(): Promise<number>;
}

const IS_WINDOWS = process.platform === 'win32';

/** Run `options.cmd` under supervision until it is stopped. */
export function supervise(options: SupervisedProcessOptions): Supervisor {
	const log = options.log ?? ((line: string) => console.error(line));
	const maxRestarts = options.maxRestarts ?? 5;
	const restartWindowMs = options.restartWindowMs ?? 60_000;
	const stopTimeoutMs = options.stopTimeoutMs ?? 15_000;
	const baseDelayMs = options.restartDelayMs ?? 1000;

	let child: Subprocess | null = null;
	let stopping = false;
	const restarts: number[] = [];
	let resolveDone!: (code: number) => void;
	const done = new Promise<number>((resolve) => (resolveDone = resolve));

	const spawnChild = () => {
		child = Bun.spawn(options.cmd, {
			cwd: options.cwd,
			env: options.env as Record<string, string>,
			stdin: 'ignore',
			stdout: options.onStdout ? 'pipe' : 'inherit',
			stderr: options.onStderr ? 'pipe' : 'inherit',
			// Own process group on POSIX — see the module comment.
			...(IS_WINDOWS ? {} : { detached: true })
		} as Parameters<typeof Bun.spawn>[1]) as Subprocess;

		const current = child;
		if (options.onStdout) void pump(current.stdout as ReadableStream<Uint8Array>, options.onStdout);
		if (options.onStderr) void pump(current.stderr as ReadableStream<Uint8Array>, options.onStderr);

		void current.exited.then(async (code) => {
			if (child !== current) return;
			const signal = current.signalCode ?? null;
			if (stopping) {
				resolveDone(code ?? 0);
				return;
			}

			const now = Date.now();
			while (restarts.length > 0 && now - restarts[0] > restartWindowMs) restarts.shift();
			const description = signal ? `signal ${signal}` : `code ${code}`;
			const report = await diagnose(options.name, description, current.pid);
			log(report);
			if (options.reportFile) writeReport(options.reportFile, report);

			if (restarts.length >= maxRestarts) {
				log(`[${options.name}] exited ${restarts.length + 1} times within ${restartWindowMs / 1000}s — not restarting.`);
				resolveDone(code ?? 1);
				return;
			}
			restarts.push(now);
			const delay = Math.min(baseDelayMs * 2 ** (restarts.length - 1), 10_000);
			log(`[${options.name}] stopped unexpectedly (${description}); restarting in ${delay / 1000}s…`);
			setTimeout(() => {
				if (!stopping) spawnChild();
			}, delay);
		});
	};

	const signalGroup = (signal: NodeJS.Signals) => {
		const pid = child?.pid;
		if (!pid || child?.exitCode !== null) return;
		try {
			// The whole group — the child and whatever it started — like a terminal would.
			if (IS_WINDOWS) process.kill(pid, signal);
			else process.kill(-pid, signal);
		} catch {
			try {
				process.kill(pid, signal);
			} catch {
				// Already gone.
			}
		}
	};

	const stop = (signal: NodeJS.Signals = 'SIGTERM'): Promise<number> => {
		if (stopping) return done;
		stopping = true;
		if (!child || child.exitCode !== null) {
			resolveDone(child?.exitCode ?? 0);
		} else {
			// On Windows the child shares the console, so Ctrl+C already reached it;
			// forwarding would terminate it outright instead of letting it shut down.
			if (!(IS_WINDOWS && signal === 'SIGINT')) signalGroup(signal);
			const timer = setTimeout(() => signalGroup('SIGKILL'), stopTimeoutMs);
			timer.unref?.();
			void done.then(() => clearTimeout(timer));
		}
		return done;
	};

	const kill = (): Promise<number> => {
		void stop('SIGKILL');
		signalGroup('SIGKILL');
		return done;
	};

	spawnChild();
	return { done, stop, kill };
}

/**
 * Forward termination signals to a set of supervisors and exit once they are
 * all down, with the first non-zero code. Returns a function that stops them
 * the same way (for callers that end on their own terms).
 */
export function stopOnSignals(supervisors: Supervisor[]): (signal?: NodeJS.Signals) => Promise<number> {
	const stopAll = async (signal: NodeJS.Signals = 'SIGTERM') => {
		const codes = await Promise.all(supervisors.map((s) => s.stop(signal)));
		return codes.find((code) => code !== 0) ?? 0;
	};
	let received = 0;
	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.on(signal, () => {
			received++;
			// A second Ctrl+C means "stop waiting".
			if (received > 1) {
				for (const supervisor of supervisors) void supervisor.kill();
				return;
			}
			void stopAll(signal).then((code) => process.exit(code));
		});
	}
	// The terminal closed: keep supervising (the server keeps running too).
	process.on('SIGHUP', () => {});
	for (const stream of [process.stdout, process.stderr]) {
		stream.on('error', () => {
			// EIO/EPIPE once the terminal is gone — nothing left to write to.
		});
	}
	return stopAll;
}

async function pump(stream: ReadableStream<Uint8Array>, sink: (chunk: Uint8Array) => void): Promise<void> {
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			if (value) sink(value);
		}
	} catch {
		// The stream closes with the process.
	} finally {
		reader.releaseLock();
	}
}

/** What was running when a child died — processes started in the last 10 minutes. */
async function diagnose(name: string, description: string, pid: number): Promise<string> {
	const lines = [`[${name}] pid ${pid} exited without being asked to (${description}) at ${new Date().toISOString()}.`];
	if (IS_WINDOWS) return lines.join('\n');
	try {
		const ps = Bun.spawn(['ps', '-A', '-o', 'pid=,ppid=,pgid=,etime=,command='], { stdout: 'pipe', stderr: 'ignore' });
		const output = await new Response(ps.stdout).text();
		const recent = output
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
			.filter((line) => {
				const etime = line.split(/\s+/)[3] ?? '';
				return elapsedSeconds(etime) <= 600;
			})
			.map((line) => (line.length > 220 ? `${line.slice(0, 220)}…` : line));
		lines.push('Processes started in the last 10 minutes (pid ppid pgid elapsed command):', ...recent.map((line) => `  ${line}`));
	} catch {
		lines.push('(process list unavailable)');
	}
	return lines.join('\n');
}

/** `ps` elapsed time ([[dd-]hh:]mm:ss) in seconds. */
export function elapsedSeconds(etime: string): number {
	const [daysPart, clock] = etime.includes('-') ? etime.split('-') : ['0', etime];
	const parts = clock.split(':').map(Number);
	if (parts.some((part) => !Number.isFinite(part))) return Number.POSITIVE_INFINITY;
	const [h, m, s] = parts.length === 3 ? parts : [0, parts[0] ?? 0, parts[1] ?? 0];
	return Number(daysPart) * 86_400 + h * 3600 + m * 60 + s;
}

function writeReport(file: string, report: string): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${report}\n\n`);
	} catch {
		// A report that cannot be written must not take the supervisor down.
	}
}
