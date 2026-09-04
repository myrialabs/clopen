/**
 * Port manager — answering "where did this come from, and what is it for".
 *
 * Three tiers, ordered by how much Clopen actually knows, and the tier itself
 * travels with the answer so the UI never dresses a guess up as a fact:
 *
 * 1. `clopen`   Clopen opened the listener. The label comes from the feature
 *               that owns it, so it is exact.
 * 2. `session`  The process descends from a Clopen terminal session. Walking
 *               the parent chain proves the lineage; the purpose is still read
 *               off the command line, but "you started this in tab X" is fact.
 * 3. `external` Everything else. Only the command line, the user and the
 *               working directory are known, so the label is a guess and is
 *               marked as one.
 *
 * On an SSH host tier 2 is not available. Clopen's remote shells are addressed
 * through a synthetic id rather than the host's real pid (see
 * `backend/ssh/pty-backend.ts`), so a lineage ending at *our* shell cannot be
 * told apart from one ending at any other. The walk still reports that the
 * process descends from an sshd session and for which user, which is true, and
 * stops there rather than claiming a tab.
 */

import type { PortOrigin, PortProcess, PortSocket } from '$shared/types/ports';
import type { ProbePlatform } from '../host/runner';
import { collectSessionPids, type ProjectShell } from '../projects/shell-ownership';
import { collectOwnedPorts, ownedPortKey, type OwnedPort } from './registry';

/** Guard against a malformed parent chain looping forever. */
const MAX_ANCESTRY_DEPTH = 40;

/**
 * A Clopen server process, by the shape of its command line.
 *
 * Deliberately anchored on files that only exist inside a Clopen install —
 * the published package path, or the repo's own entry points — rather than on
 * the word "clopen" appearing anywhere. A user with a directory of that name
 * should not have their processes claimed.
 */
const CLOPEN_PROCESS = new RegExp(
	[
		'@myrialabs[/\\\\]clopen[/\\\\]',
		'clopen[/\\\\]scripts[/\\\\]start\\.ts',
		'clopen[/\\\\]backend[/\\\\]index\\.ts',
		'clopen[/\\\\]bin[/\\\\]clopen',
		'clopen[/\\\\]dist[/\\\\]'
	].join('|')
);

export function isClopenProcess(process: PortProcess | null): boolean {
	return process ? CLOPEN_PROCESS.test(process.command) : false;
}

/**
 * Every Clopen process on this machine, this one included.
 *
 * These are the roots tier-2 attribution walks up to. Anything descended from
 * one was started by Clopen — a terminal shell, an engine, a command an agent
 * ran, an MCP server, a dev server launched from any of them. Keying on the
 * process tree rather than on terminal sessions is what makes that hold for
 * all of them instead of only the shells.
 *
 * Other Clopen instances count too: a port opened from a second install's
 * terminal is still a port Clopen opened, and the user reads it that way.
 */
export function findClopenPids(
	processes: Map<number, PortProcess>,
	selfPid: number | null
): Set<number> {
	const pids = new Set<number>();
	if (selfPid !== null) pids.add(selfPid);
	for (const [pid, process] of processes) {
		if (isClopenProcess(process)) pids.add(pid);
	}
	return pids;
}

export interface Ancestry {
	/** The chain from the process itself up to init, self first. */
	chain: PortProcess[];
	/** The Clopen terminal session it descends from, if any. */
	session: ProjectShell | null;
	/**
	 * True when the chain reaches a process Clopen is: one of its own instances
	 * locally, or the sshd session it is using on a remote host.
	 */
	fromClopen: boolean;
	/** The user of the sshd session it descends from, on a remote host. */
	sshdUser: string | null;
}

/** `sshd: arga@pts/0` and `sshd: arga [priv]` both name the session's user. */
function sshdUserOf(command: string): string | null {
	const match = command.match(/^sshd:\s+([^\s@[]+)/);
	return match ? match[1] : null;
}

export function traceAncestry(
	pid: number,
	processes: Map<number, PortProcess>,
	sessions: Map<number, ProjectShell>,
	clopenRootPids: ReadonlySet<number> = new Set()
): Ancestry {
	const chain: PortProcess[] = [];
	const seen = new Set<number>();

	let session: ProjectShell | null = null;
	let sshdUser: string | null = null;
	let fromClopen = false;
	let current: number | null = pid;

	for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && current !== null && current > 0; depth++) {
		if (seen.has(current)) break;
		seen.add(current);

		const found = sessions.get(current);
		if (found && !session) session = found;
		if (clopenRootPids.has(current)) fromClopen = true;

		const process = processes.get(current);
		if (!process) break;
		chain.push(process);

		if (!sshdUser) sshdUser = sshdUserOf(process.command);

		current = process.parentPid;
	}

	return { chain, session, fromClopen, sshdUser };
}

/**
 * What an unattributed process most likely is. Matched against the full
 * command line so `node .../vite/bin/vite.js` reads as Vite rather than Node.
 * Deliberately shallow: the raw command is always shown next to this, and a
 * confident wrong answer is worse than "Listening process".
 */
const COMMAND_HINTS: Array<{ pattern: RegExp; label: string }> = [
	{ pattern: /\bvite\b/, label: 'Vite dev server' },
	{ pattern: /\bnext(-server)?\b|\bnext\/dist\b/, label: 'Next.js' },
	{ pattern: /\bnuxt\b/, label: 'Nuxt' },
	{ pattern: /\bastro\b/, label: 'Astro' },
	{ pattern: /webpack-dev-server|react-scripts/, label: 'Webpack dev server' },
	{ pattern: /\bng\s+serve\b|@angular\/cli/, label: 'Angular dev server' },
	{ pattern: /\bstorybook\b/, label: 'Storybook' },
	{ pattern: /\bpostgres\b|\bpostmaster\b/, label: 'PostgreSQL' },
	{ pattern: /\bmysqld\b|\bmariadbd\b/, label: 'MySQL / MariaDB' },
	{ pattern: /\bredis-server\b/, label: 'Redis' },
	{ pattern: /\bmongod\b/, label: 'MongoDB' },
	{ pattern: /\bdocker-proxy\b|com\.docker/, label: 'Docker published port' },
	{ pattern: /\bnginx\b/, label: 'nginx' },
	{ pattern: /\bcaddy\b/, label: 'Caddy' },
	{ pattern: /\bhttpd\b|\bapache2\b/, label: 'Apache' },
	{ pattern: /\bsshd\b/, label: 'SSH server' },
	{ pattern: /\bcloudflared\b/, label: 'Cloudflare tunnel' },
	{ pattern: /\bollama\b/, label: 'Ollama' },
	{ pattern: /python[0-9.]*\s+-m\s+http\.server/, label: 'Python http.server' },
	{ pattern: /\bphp\b.*\s-S\s/, label: 'PHP built-in server' },
	{ pattern: /\brails\b|\bpuma\b/, label: 'Rails / Puma' }
];

function guessLabel(process: PortProcess | null, fallbackName: string | null): string {
	const command = process?.command ?? '';
	for (const hint of COMMAND_HINTS) {
		if (hint.pattern.test(command)) return hint.label;
	}
	if (fallbackName) return fallbackName;
	if (command) return command.split(/\s+/)[0].split('/').pop() || 'Listening process';
	return 'Listening process';
}

/** Trim a command line to something a table cell can hold. */
function shorten(command: string, max = 140): string {
	return command.length <= max ? command : `${command.slice(0, max - 1)}…`;
}

export interface AttributionContext {
	platform: ProbePlatform;
	/** Ports Clopen opened on this host, whichever host it is. */
	owned: Map<string, OwnedPort>;
	/** Shell pids of local terminal sessions; empty on an SSH host. */
	sessions: Map<number, ProjectShell>;
	/**
	 * The processes that count as "Clopen" on this host: its own instances
	 * locally, and remotely everything found to belong to Clopen's own SSH
	 * connection. One field for both, because it answers the same question
	 * either way — is this Clopen's doing.
	 */
	clopenRootPids: ReadonlySet<number>;
	/** Host label, so remote attributions can name where they were found. */
	hostName: string;
	processes: Map<number, PortProcess>;
	isLocal: boolean;
}

export function buildContext(input: {
	platform: ProbePlatform;
	processes: Map<number, PortProcess>;
	hostId: string;
	hostName: string;
	isLocal: boolean;
	clopenPids: ReadonlySet<number>;
}): AttributionContext {
	// A Clopen install is recognised the same way wherever it runs, and on a
	// remote host every process on Clopen's own SSH connection counts too. One
	// set, built from whichever of those apply to this host.
	const clopenRootPids = findClopenPids(input.processes, input.isLocal ? process.pid : null);
	for (const pid of input.clopenPids) clopenRootPids.add(pid);

	return {
		platform: input.platform,
		owned: collectOwnedPorts(input.hostId),
		sessions: input.isLocal ? collectSessionPids() : new Map(),
		clopenRootPids,
		hostName: input.hostName,
		processes: input.processes,
		isLocal: input.isLocal
	};
}

/** Decide where a listening socket came from. */
export function attribute(socket: PortSocket, context: AttributionContext): PortOrigin {
	const owned = context.owned.get(ownedPortKey(socket.protocol, socket.port));
	if (owned) {
		return {
			kind: 'clopen',
			confidence: 'certain',
			label: owned.label,
			detail: owned.detail,
			ownerFeature: owned.feature,
			ownerId: owned.ownerId ?? undefined
		};
	}

	const process = socket.pid !== null ? (context.processes.get(socket.pid) ?? null) : null;

	// Another Clopen install listening on its own port. The registry only knows
	// the ports of *this* process, so without this the other instance would be
	// filed under "outside Clopen" — which is not how anyone reads it. A Clopen
	// on an SSH host is recognised by the same signature, on purpose.
	if (isClopenProcess(process)) {
		return {
			kind: 'clopen',
			confidence: 'certain',
			label: 'Clopen server',
			detail: context.isLocal
				? 'Another Clopen instance running on this machine'
				: `A Clopen instance running on ${context.hostName}`,
			ownerFeature: 'server'
		};
	}

	const ancestry =
		socket.pid !== null
			? traceAncestry(socket.pid, context.processes, context.sessions, context.clopenRootPids)
			: null;

	if (ancestry?.session) {
		const { session } = ancestry;
		const where = session.projectName ? `project ${session.projectName}` : session.cwd;
		return {
			kind: 'session',
			confidence: 'certain',
			label: guessLabel(process, socket.processName),
			detail: `Started from a terminal session in ${where}`,
			sessionId: session.sessionId,
			projectId: session.projectId
		};
	}

	if (ancestry?.fromClopen) {
		return {
			kind: 'session',
			confidence: 'certain',
			label: guessLabel(process, socket.processName),
			// Which tab is not knowable here — every channel Clopen opens shares
			// one sshd connection — but that Clopen started it is not in doubt.
			detail: `Started through Clopen on ${context.hostName}`
		};
	}

	if (ancestry?.sshdUser) {
		return {
			kind: 'session',
			confidence: 'certain',
			label: guessLabel(process, socket.processName),
			// Someone else's SSH session: real lineage, but not Clopen's doing.
			detail: `Started from an SSH session as ${ancestry.sshdUser}`,
			remoteSessionUser: ancestry.sshdUser
		};
	}

	const detail = process?.command ? shorten(process.command) : null;
	return {
		kind: 'external',
		confidence: 'guess',
		label: guessLabel(process, socket.processName),
		detail: detail ?? (socket.pid === null ? 'Owner not visible without elevated privileges' : null)
	};
}

/**
 * The program a command line belongs to, used to tell a worker pool apart from
 * unrelated processes that merely share a parent. `nginx: worker process` and
 * `nginx: master process` both reduce to `nginx`.
 */
function programKey(command: string): string {
	const first = command.trim().split(/\s+/)[0] ?? '';
	return (first.replace(/:$/, '').split('/').pop() ?? '').toLowerCase();
}

export interface PidGroup {
	/** The process that represents the port. */
	owner: number;
	/** Every listening pid in the group, the owner included when it listens. */
	members: number[];
}

/**
 * Group the pids holding one port by the process that actually owns it.
 *
 * A server that pre-forks workers has every worker inherit the listening
 * socket, so a plain listing shows eight identical rows for one port. Two
 * shapes of that are collapsed here:
 *
 * 1. One candidate is an ancestor of the others — a master that also listens.
 * 2. The candidates are siblings of one parent and all run the same program as
 *    that parent, which is what a worker pool looks like when the master holds
 *    no socket of its own (nginx on macOS). The parent becomes the owner even
 *    though it is not listening, because it is the process a user means when
 *    they say "nginx".
 *
 * Everything else stays separate. Unrelated programs can hold the same port
 * number on different addresses, and merging those would invent a relationship.
 */
export function groupListenerPids(pids: number[], processes: Map<number, PortProcess>): PidGroup[] {
	const candidates = new Set(pids);

	/** Highest ancestor that also holds this port, else the pid itself. */
	const ancestorRoot = (pid: number): number => {
		let root = pid;
		let current: number | null = processes.get(pid)?.parentPid ?? null;
		const seen = new Set<number>([pid]);

		for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && current !== null && current > 0; depth++) {
			if (seen.has(current)) break;
			seen.add(current);
			if (candidates.has(current)) root = current;
			current = processes.get(current)?.parentPid ?? null;
		}

		return root;
	};

	const byRoot = new Map<number, number[]>();
	for (const pid of pids) {
		const root = ancestorRoot(pid);
		const members = byRoot.get(root);
		if (members) members.push(pid);
		else byRoot.set(root, [pid]);
	}

	// Second pass: fold sibling roots onto a shared parent running the same
	// program. Roots with no such parent are emitted untouched.
	const bySharedParent = new Map<number, number[]>();
	const groups: PidGroup[] = [];

	for (const root of byRoot.keys()) {
		const parentPid = processes.get(root)?.parentPid ?? null;
		if (parentPid === null || parentPid <= 1) continue;
		const siblings = bySharedParent.get(parentPid);
		if (siblings) siblings.push(root);
		else bySharedParent.set(parentPid, [root]);
	}

	const folded = new Set<number>();
	for (const [parentPid, roots] of bySharedParent) {
		if (roots.length < 2) continue;

		const parent = processes.get(parentPid);
		if (!parent) continue;
		const parentProgram = programKey(parent.command);
		if (!parentProgram) continue;

		const sameProgram = roots.every((root) => {
			const process = processes.get(root);
			return process ? programKey(process.command) === parentProgram : false;
		});
		if (!sameProgram) continue;

		const members: number[] = [];
		for (const root of roots) {
			members.push(...(byRoot.get(root) ?? [root]));
			folded.add(root);
		}
		groups.push({ owner: parentPid, members: [...new Set(members)].sort((a, b) => a - b) });
	}

	for (const [root, members] of byRoot) {
		if (folded.has(root)) continue;
		groups.push({ owner: root, members: [...new Set(members)].sort((a, b) => a - b) });
	}

	return groups;
}
