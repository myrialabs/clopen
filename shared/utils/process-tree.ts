/**
 * The processes below a pid, and waiting for them to be gone.
 *
 * A supervised child (the server, the dev frontend) starts processes of its
 * own — engine CLIs, the preview's Chrome, cloudflared — and some of those sit
 * in other process groups, so a signal to the child's group does not reach
 * them. Collected BEFORE anything is signalled: once their parent exits they
 * are re-parented and can no longer be found by parent id.
 *
 * POSIX only (`ps`); on Windows the lists are empty and callers fall back to
 * the single pid.
 */

const IS_WINDOWS = process.platform === 'win32';

/** Every descendant of `rootPid` (not `rootPid` itself). */
export function collectDescendants(rootPid: number): number[] {
	if (IS_WINDOWS || !Number.isInteger(rootPid) || rootPid <= 0) return [];
	let output: string;
	try {
		output = new TextDecoder().decode(Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid='], { stdout: 'pipe', stderr: 'ignore' }).stdout);
	} catch {
		return [];
	}
	const children = new Map<number, number[]>();
	for (const line of output.split('\n')) {
		const [pid, ppid] = line.trim().split(/\s+/).map(Number);
		if (!pid || ppid === undefined || Number.isNaN(ppid)) continue;
		const list = children.get(ppid);
		if (list) list.push(pid);
		else children.set(ppid, [pid]);
	}
	const found = new Set<number>();
	const queue = [rootPid];
	while (queue.length > 0) {
		const pid = queue.pop()!;
		for (const child of children.get(pid) ?? []) {
			if (found.has(child) || child === rootPid || child === process.pid) continue;
			found.add(child);
			queue.push(child);
		}
	}
	return [...found];
}

/** Whether `pid` still exists (one we may not signal counts as existing). */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Send `signal` to every pid still there. */
export function signalAll(pids: number[], signal: NodeJS.Signals): void {
	for (const pid of pids) {
		try {
			process.kill(pid, signal);
		} catch {
			// Already gone.
		}
	}
}

/** Resolves once none of `pids` exists, or after `timeoutMs`; returns the survivors. */
export async function waitForExit(pids: number[], timeoutMs: number, pollMs = 50): Promise<number[]> {
	const deadline = Date.now() + timeoutMs;
	let alive = pids.filter(isAlive);
	while (alive.length > 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, pollMs));
		alive = alive.filter(isAlive);
	}
	return alive;
}

/**
 * Whether this process's parent forwards terminal signals to it: a script
 * runner (`bun run`, `bun x`) in the same process group. A Ctrl+C reaches the
 * whole foreground group — runner and child — and the runner then forwards its
 * copy, so the child receives the FIRST Ctrl+C twice (measured: 1 ms apart;
 * later presses arrive once). A plain shell does not forward.
 */
export function parentForwardsSignals(): boolean {
	if (IS_WINDOWS) return false;
	try {
		const read = (pid: number, field: string) =>
			new TextDecoder().decode(Bun.spawnSync(['ps', '-o', `${field}=`, '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' }).stdout).trim();
		const ownGroup = read(process.pid, 'pgid');
		const parentGroup = read(process.ppid, 'pgid');
		if (!ownGroup || ownGroup !== parentGroup) return false;
		const command = read(process.ppid, 'command');
		const program = command.split(/\s+/)[0]?.split('/').pop() ?? '';
		return program === 'bun' || program === 'bunx' || program === 'bun.exe';
	} catch {
		return false;
	}
}
