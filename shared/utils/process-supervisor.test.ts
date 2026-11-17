/**
 * The supervisor that keeps the Clopen server (and the dev frontend/backend)
 * running: a child killed from outside comes back, a requested stop does not,
 * and the child lives in its own process group so a signal aimed at it cannot
 * reach the supervisor.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { elapsedSeconds, supervise } from './process-supervisor';

const posix = process.platform !== 'win32';
const dir = mkdtempSync(join(tmpdir(), 'clopen-supervisor-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A child that prints its pid and process group, then waits. */
const LONG_RUNNING = ['sh', '-c', 'echo "pid=$$ pgid=$(ps -o pgid= -p $$ | tr -d " ")"; sleep 30'];

function collect() {
	const lines: string[] = [];
	const decoder = new TextDecoder();
	return { lines, sink: (chunk: Uint8Array) => lines.push(...decoder.decode(chunk).split('\n').filter(Boolean)) };
}

async function waitFor(check: () => boolean, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('timed out');
		await sleep(20);
	}
}

const pidsIn = (lines: string[]) =>
	lines.map((line) => /pid=(\d+) pgid=(\d+)/.exec(line)).filter(Boolean).map((m) => ({ pid: Number(m![1]), pgid: Number(m![2]) }));

describe.if(posix)('supervise', () => {
	test('runs the child in its own process group', async () => {
		const out = collect();
		const s = supervise({ name: 't', cmd: LONG_RUNNING, onStdout: out.sink, log: () => {} });
		await waitFor(() => pidsIn(out.lines).length > 0);
		const [{ pid, pgid }] = pidsIn(out.lines);
		expect(pgid).toBe(pid);
		expect(pgid).not.toBe(Number(Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(process.pid)]).stdout.toString().trim()));
		await s.stop();
	});

	test('restarts a child killed from outside, and writes a report', async () => {
		const out = collect();
		const logs: string[] = [];
		const reportFile = join(dir, 'report.log');
		const s = supervise({
			name: 'server',
			cmd: LONG_RUNNING,
			onStdout: out.sink,
			log: (line) => logs.push(line),
			reportFile,
			restartDelayMs: 50
		});
		await waitFor(() => pidsIn(out.lines).length === 1);
		const [first] = pidsIn(out.lines);

		// A stray SIGTERM to the child's whole group — what took the server down.
		process.kill(-first.pgid, 'SIGTERM');

		await waitFor(() => pidsIn(out.lines).length === 2);
		const [, second] = pidsIn(out.lines);
		expect(second.pid).not.toBe(first.pid);
		expect(logs.some((line) => line.includes('restarting'))).toBe(true);
		expect(existsSync(reportFile)).toBe(true);
		expect(readFileSync(reportFile, 'utf8')).toContain('exited without being asked to (signal SIGTERM)');
		await s.stop();
	});

	test('a requested stop reaches the whole group and is not restarted', async () => {
		const out = collect();
		const s = supervise({
			name: 't',
			// The child starts a grandchild that reports its pid, then both wait.
			cmd: ['sh', '-c', 'sleep 30 & echo "grandchild=$!"; wait'],
			onStdout: out.sink,
			log: () => {},
			restartDelayMs: 50
		});
		await waitFor(() => out.lines.some((line) => line.startsWith('grandchild=')));
		const grandchild = Number(out.lines.find((line) => line.startsWith('grandchild='))!.split('=')[1]);

		const code = await s.stop('SIGTERM');
		expect(typeof code).toBe('number');
		await sleep(150);
		expect(out.lines.filter((line) => line.startsWith('grandchild='))).toHaveLength(1); // not restarted
		expect(() => process.kill(grandchild, 0)).toThrow(); // the grandchild went with it
	});

	test('gives up on a child that keeps dying', async () => {
		const s = supervise({ name: 't', cmd: ['sh', '-c', 'exit 3'], log: () => {}, restartDelayMs: 10, maxRestarts: 2 });
		expect(await s.done).toBe(3);
	});
});

describe('elapsedSeconds', () => {
	test('reads the ps elapsed-time formats', () => {
		expect(elapsedSeconds('00:05')).toBe(5);
		expect(elapsedSeconds('01:02:03')).toBe(3723);
		expect(elapsedSeconds('2-00:00:01')).toBe(172_801);
		expect(elapsedSeconds('garbage')).toBe(Number.POSITIVE_INFINITY);
	});
});

/**
 * The launcher as a whole, in its own process: SIGHUP leaves the server
 * running, a stray SIGTERM to the server's group brings it back, and Ctrl+C
 * to the launcher stops it with a graceful shutdown.
 */
describe.if(posix)('a supervising launcher', () => {
	test('survives SIGHUP, recovers from a stray SIGTERM, stops on SIGINT', async () => {
		const server = join(dir, 'fake-server.ts');
		const launcher = join(dir, 'launcher.ts');
		await Bun.write(
			server,
			`console.log('up pid=' + process.pid);
process.on('SIGHUP', () => console.log('ignored SIGHUP'));
const shutdown = (sig) => { console.log('graceful ' + sig); process.exit(0); };
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
setInterval(() => {}, 1000);
`
		);
		await Bun.write(
			launcher,
			`import { supervise, stopOnSignals } from ${JSON.stringify(join(import.meta.dir, 'process-supervisor.ts'))};
const s = supervise({ name: 'server', cmd: ['bun', ${JSON.stringify(server)}], restartDelayMs: 50, log: (l) => console.log(l.split('\\n')[0]) });
stopOnSignals([s]);
process.exit(await s.done);
`
		);

		const proc = Bun.spawn(['bun', launcher], { stdout: 'pipe', stderr: 'pipe' });
		const out = collect();
		void (async () => {
			const reader = proc.stdout.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				out.sink(value);
			}
		})();

		const ups = () => out.lines.filter((line) => line.startsWith('up pid='));
		await waitFor(() => ups().length === 1, 10_000);
		const firstPid = Number(ups()[0].split('=')[1]);

		process.kill(proc.pid, 'SIGHUP');
		await sleep(300);
		expect(proc.exitCode).toBeNull();
		expect(() => process.kill(firstPid, 0)).not.toThrow(); // server still running

		process.kill(-firstPid, 'SIGTERM'); // stray signal to the server's group
		await waitFor(() => ups().length === 2, 10_000);
		expect(proc.exitCode).toBeNull();

		process.kill(proc.pid, 'SIGINT');
		const code = await proc.exited;
		expect(code).toBe(0);
		expect(out.lines.some((line) => line === 'graceful SIGINT')).toBe(true);
		expect(ups()).toHaveLength(2); // not restarted after the requested stop
	}, 30_000);
});
