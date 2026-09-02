/**
 * Port manager — recognising Clopen's own work on an SSH host.
 *
 * On the machine Clopen runs on, a port is traced to Clopen by walking parent
 * pids up to a Clopen process. A remote host needs the same fact established
 * from the other end: PtyKit addresses remote shells through an internal id,
 * and ssh2 never learns what the far side numbered anything.
 *
 * The answer is in the environment, not the process tree. sshd sets
 * `SSH_CONNECTION` for every session it opens, holding the client address and
 * source port of the TCP connection behind it. Every channel Clopen opens —
 * shells, SFTP, forwards, the probes in this file — rides one connection, so
 * they all carry the same value, and every process started from any of them
 * inherits it. Reading it back off a listening process therefore says whether
 * Clopen started it, with no privileges and no guesswork.
 *
 * Two earlier attempts are worth not repeating:
 *
 * - Matching `SSH_CONNECTION` against the host's *socket table* to find the
 *   sshd holding the connection. That socket belongs to root's sshd, so an
 *   unprivileged account never sees its pid.
 * - Walking up from a probe's `$PPID` to the outermost process calling itself
 *   `sshd:`. That depends on how a host labels its sshd processes and on where
 *   the daemon sits in the tree, and it found nothing on a real cPanel host.
 *
 * Both tried to identify a process Clopen has no right to see. Asking what
 * connection a process belongs to sidesteps that entirely.
 *
 * macOS is the exception, and only because it cannot answer the question:
 * `ps -E` returns no environment there at all under SIP, verified rather than
 * assumed. A macOS host therefore falls back to the process-tree walk, which
 * is sound there — its sshd labels sessions the same way. This mirrors how the
 * port probes already differ per platform: one question, asked the way each
 * operating system will answer it.
 */

import type { PortProcess } from '$shared/types/ports';
import { posixArgv, type CommandRunner, type ProbePlatform } from '../host/runner';
import { parsePsOutput } from './processes';
import { debug } from '$shared/utils/logger';

/** `SSH_CONNECTION` is `<client ip> <client port> <server ip> <server port>`. */
export function parseSshConnection(value: string): { address: string; port: number } | null {
	const parts = value.trim().split(/\s+/);
	if (parts.length < 2) return null;
	const port = Number.parseInt(parts[1], 10);
	if (!Number.isFinite(port) || port <= 0) return null;
	return { address: parts[0], port };
}

/**
 * Two `SSH_CONNECTION` values describing the same connection.
 *
 * The source port carries the match: it is unique per connection for as long
 * as that connection is open. The address is compared only as a guard against
 * a port number colliding across interfaces.
 */
export function sameConnection(a: string, b: string): boolean {
	const left = parseSshConnection(a);
	const right = parseSshConnection(b);
	if (!left || !right) return false;
	return left.port === right.port && left.address === right.address;
}

/** Pids are interpolated into a shell script, so they must be exactly numbers. */
function safePids(pids: number[]): number[] {
	return pids.filter((pid) => Number.isInteger(pid) && pid > 0 && pid < 4_294_967_296);
}

/**
 * Read `SSH_CONNECTION` out of each process's environment.
 *
 * On Linux that is `/proc/<pid>/environ`, a NUL-separated blob readable for
 * one's own processes — which is exactly the set that could have come from
 * Clopen. macOS exposes the same thing through `ps -E`. Neither needs any
 * privilege beyond owning the process.
 */
function environProbeArgv(pids: number[]): string[] | null {
	if (pids.length === 0) return null;
	const list = pids.join(' ');

	// A fixed script; only vetted integers are interpolated into it.
	return posixArgv([
		'sh',
		'-c',
		// `cat` rather than a `<` redirect: a redirect that fails is reported by
		// the shell itself, before `2>/dev/null` on that command can apply.
		`for p in ${list}; do printf '@%s ' "$p"; cat /proc/$p/environ 2>/dev/null | ` +
			`tr '\\0' '\\n' | grep '^SSH_CONNECTION=' || printf '\\n'; done`
	]);
}

/** `@42802 SSH_CONNECTION=1.2.3.4 55 5.6.7.8 22` → pid and value. */
export function parseEnvironProbe(stdout: string): Map<number, string> {
	const found = new Map<number, string>();

	for (const line of stdout.split('\n')) {
		const marked = line.match(/^@(\d+)\s*(.*)$/);
		if (!marked) continue;
		const pid = Number.parseInt(marked[1], 10);
		const value = marked[2].replace(/^.*?SSH_CONNECTION=/, '');
		if (Number.isFinite(pid) && value && marked[2].includes('SSH_CONNECTION=')) {
			found.set(pid, value.trim());
		}
	}

	return found;
}

/**
 * A per-connection sshd, which announces itself as `sshd: user@ttys000`,
 * `sshd: user@pts/0` or `sshd: user [priv]`. The listening daemon
 * (`/usr/sbin/sshd -D`) deliberately does not match: it parents every session
 * on the host, so treating it as the root would hand Clopen credit for every
 * other user's processes.
 */
function isSessionSshd(process: PortProcess | null): boolean {
	return process ? /(^|\s)sshd:\s/.test(process.command) : false;
}

/**
 * From the sshd serving one channel, the sshd serving the whole connection.
 *
 * sshd forks a child per channel, so the chain from a command runs shell →
 * channel sshd → connection sshd → listening daemon. The outermost link still
 * calling itself `sshd:` is the one every channel shares, which makes it the
 * root of everything Clopen does on that host.
 */
export function findConnectionSshd(
	execParentPid: number,
	processes: Map<number, PortProcess>
): number | null {
	let best: number | null = null;
	let current: number | null = execParentPid;
	const seen = new Set<number>();

	for (let depth = 0; depth < 20 && current !== null && current > 1; depth++) {
		if (seen.has(current)) break;
		seen.add(current);

		const process = processes.get(current);
		if (!process || !isSessionSshd(process)) break;

		best = current;
		current = process.parentPid;
	}

	return best;
}

/**
 * The pid and the process list must come from the *same* command: sshd reaps
 * the exec channel's child the moment the command exits, so a pid read by one
 * exec is already gone before a second could run `ps` against it.
 */
async function probeTreeRoot(runner: CommandRunner): Promise<number | null> {
	try {
		const result = await runner.run(
			posixArgv(['sh', '-c', 'echo "$PPID"; ps -eo pid=,ppid=,user=,lstart=,args=']),
			10_000
		);

		const newline = result.stdout.indexOf('\n');
		if (newline === -1) return null;

		const execParentPid = Number.parseInt(result.stdout.slice(0, newline).trim(), 10);
		if (!Number.isFinite(execParentPid) || execParentPid <= 1) return null;

		const processes = new Map<number, PortProcess>();
		for (const entry of parsePsOutput(result.stdout.slice(newline + 1))) processes.set(entry.pid, entry);

		return findConnectionSshd(execParentPid, processes);
	} catch (error) {
		debug.log('ports', `SSH tree probe failed on ${runner.label}:`, error);
		return null;
	}
}

/**
 * What connection Clopen's own commands run on. Cached per host: it cannot
 * change while the pooled transport lives, and re-asking would spend a round
 * trip per tick on a constant.
 */
const ownConnections = new Map<string, string>();

async function readOwnConnection(
	hostId: string,
	runner: CommandRunner,
	platform: ProbePlatform
): Promise<string | null> {
	const cached = ownConnections.get(hostId);
	if (cached) return cached;
	if (platform === 'win32') return null;

	try {
		const result = await runner.run(posixArgv(['sh', '-c', 'printf %s "$SSH_CONNECTION"']), 5_000);
		const value = result.stdout.trim();
		// Judged on output, not exit status: a restricted shell can report a
		// non-zero status and still have answered the question.
		if (!parseSshConnection(value)) return null;
		ownConnections.set(hostId, value);
		return value;
	} catch (error) {
		debug.log('ports', `could not read SSH_CONNECTION on ${runner.label}:`, error);
		return null;
	}
}

/**
 * Which of these listening processes belong to Clopen's own SSH connection.
 *
 * Answers per pid rather than by finding one root process, so a server that
 * was disowned or reparented is still recognised — the environment survives
 * what the process tree does not.
 */
/**
 * What has already been decided about a process, keyed by pid *and* start time
 * so a recycled pid is judged afresh. A live process's environment does not
 * change, so re-reading it every tick would be a round trip spent confirming a
 * constant.
 */
const verdicts = new Map<string, Map<string, boolean>>();

function verdictKey(pid: number, processes: Map<number, PortProcess>): string {
	return `${pid}:${processes.get(pid)?.startedAt ?? ''}`;
}

export async function resolveClopenPids(
	hostId: string,
	runner: CommandRunner,
	platform: ProbePlatform,
	pids: number[],
	processes: Map<number, PortProcess>
): Promise<Set<number>> {
	const ours = new Set<number>();
	if (platform === 'win32') return ours;

	// macOS will not report a process's environment, so its connection has to
	// be identified through the process tree instead. Adding the session sshd
	// is enough: the ancestry walk downstream reaches it from every descendant.
	if (platform === 'darwin') {
		const root = await resolveTreeRoot(hostId, runner);
		if (root !== null) ours.add(root);
		return ours;
	}

	const own = await readOwnConnection(hostId, runner, platform);
	if (!own) return ours;

	// Ancestors count too: a process that cleared its own environment is still
	// ours if the shell that spawned it is.
	const candidates = new Set<number>();
	for (const pid of pids) {
		let current: number | null = pid;
		const seen = new Set<number>();
		for (let depth = 0; depth < 20 && current !== null && current > 1; depth++) {
			if (seen.has(current)) break;
			seen.add(current);
			candidates.add(current);
			current = processes.get(current)?.parentPid ?? null;
		}
	}

	let known = verdicts.get(hostId);
	if (!known) {
		known = new Map();
		verdicts.set(hostId, known);
	}

	// Only ask about processes never judged before; the rest are already settled.
	const unknown: number[] = [];
	for (const pid of candidates) {
		const decided = known.get(verdictKey(pid, processes));
		if (decided === undefined) unknown.push(pid);
		else if (decided) ours.add(pid);
	}

	const argv = environProbeArgv(safePids(unknown));
	if (!argv) return ours;

	try {
		const result = await runner.run(argv, 10_000);
		const values = parseEnvironProbe(result.stdout);

		for (const pid of unknown) {
			const value = values.get(pid);
			// A process whose environment could not be read is recorded as not
			// ours, so it is not asked about again — unreadable will not become
			// readable while it lives.
			const mine = value !== undefined && sameConnection(value, own);
			known.set(verdictKey(pid, processes), mine);
			if (mine) ours.add(pid);
		}
	} catch (error) {
		debug.log('ports', `environment probe failed on ${runner.label}:`, error);
	}

	return ours;
}

/** Resolved once per host; a failure is not cached, so a later tick retries. */
const treeRoots = new Map<string, number>();

async function resolveTreeRoot(hostId: string, runner: CommandRunner): Promise<number | null> {
	const cached = treeRoots.get(hostId);
	if (cached !== undefined) return cached;

	const root = await probeTreeRoot(runner);
	if (root !== null) treeRoots.set(hostId, root);
	return root;
}

/** Drop a host's cached connection identity when its transport goes away. */
export function forgetClopenRootPid(hostId: string): void {
	ownConnections.delete(hostId);
	treeRoots.delete(hostId);
	verdicts.delete(hostId);
}
