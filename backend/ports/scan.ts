/**
 * Port manager — reading the socket table on any supported platform.
 *
 * Each platform gets the probe that actually answers the question there, and
 * every probe is normalised into the same `PortSocket` row so nothing
 * downstream has to care which one ran:
 *
 * - macOS   `lsof -F`      — pid, login name and full bind address in one pass
 * - Linux   `ss -tuna -p`  — falls back to `netstat`, then to `lsof`
 * - Windows `netstat -ano` — pid only; the process name comes from the table
 *                            built in processes.ts
 *
 * Two honest limits are reported rather than papered over. On Linux the kernel
 * only names the owning process for sockets belonging to the calling user, so
 * an unprivileged scan legitimately returns rows with no pid. And when a
 * primary probe is missing and a fallback ran, the caller is told, because the
 * fallbacks carry less detail.
 */

import type {
	PortIpVersion,
	PortLimitation,
	PortProtocol,
	PortSocket,
	PortSocketState
} from '$shared/types/ports';
import { posixArgv, type CommandRunner, type ProbePlatform } from '../host/runner';
import { debug } from '$shared/utils/logger';

/** Per-host memory of which probe answered, held by the host's scanner. */
export interface ProbeMemo {
	probe?: string;
	argv?: string[];
	parse?: (stdout: string) => PortSocket[];
	limitations?: PortLimitation[];
}

export interface SocketScan {
	sockets: PortSocket[];
	limitations: PortLimitation[];
	/** The probe that produced these rows, for the panel to report. */
	probe: string;
}

/** Split `addr:port` where addr may be IPv6, bracketed, wildcard, or scoped. */
function splitAddressPort(value: string): { address: string; port: number } | null {
	const trimmed = value.trim();
	if (!trimmed || trimmed === '*') return null;

	const lastColon = trimmed.lastIndexOf(':');
	if (lastColon <= 0) return null;

	let address = trimmed.slice(0, lastColon);
	const portText = trimmed.slice(lastColon + 1);

	// A wildcard port belongs to the peer column of a listening socket, which
	// carries no information — the caller drops these.
	if (portText === '*' || portText === '') return null;
	const port = Number.parseInt(portText, 10);
	if (!Number.isFinite(port) || port < 0 || port > 65535) return null;

	if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
	if (address === '' || address === '*') address = '*';

	return { address, port };
}

/** `0.0.0.0` and `::` mean the same thing as `*` and read worse in a table. */
function normaliseAddress(address: string): string {
	if (address === '0.0.0.0' || address === '::' || address === '[::]') return '*';
	return address;
}

function ipVersionOf(address: string, hint?: PortIpVersion): PortIpVersion {
	if (hint) return hint;
	return address.includes(':') ? 'v6' : 'v4';
}

/**
 * Collapse the TCP state machine to the three states the UI acts on. A UDP
 * socket has no state; a bound one with no peer is what "port in use" means,
 * so it is reported as listening.
 */
function normaliseState(raw: string | null, protocol: PortProtocol, hasPeer: boolean): PortSocketState {
	// UDP is connectionless, so whatever the probe puts in the state column is
	// not a TCP state: `ss` says UNCONN, netstat leaves it blank. A bound socket
	// with no peer is precisely what "this port is in use" means, so the peer
	// decides and the reported state is ignored.
	if (protocol === 'udp') return hasPeer ? 'established' : 'listen';

	const state = (raw ?? '').toUpperCase();
	if (state === 'LISTEN' || state === 'LISTENING') return 'listen';
	if (state === 'ESTABLISHED' || state === 'ESTAB') return 'established';
	return 'other';
}

function makeSocket(input: {
	protocol: PortProtocol;
	local: { address: string; port: number };
	peer: { address: string; port: number } | null;
	state: string | null;
	pid: number | null;
	processName: string | null;
	user: string | null;
	ipVersion?: PortIpVersion;
}): PortSocket {
	const address = normaliseAddress(input.local.address);
	return {
		protocol: input.protocol,
		ipVersion: ipVersionOf(address, input.ipVersion),
		address,
		port: input.local.port,
		state: normaliseState(input.state, input.protocol, Boolean(input.peer)),
		pid: input.pid,
		processName: input.processName,
		user: input.user,
		peerAddress: input.peer ? normaliseAddress(input.peer.address) : null,
		peerPort: input.peer ? input.peer.port : null
	};
}

// ---------------------------------------------------------------------------
// lsof — macOS primary, Unix last resort
// ---------------------------------------------------------------------------

const LSOF_ARGV = posixArgv(['lsof', '-nP', '-iTCP', '-iUDP', '-FpcLfPntT']);

/**
 * `lsof -F` emits one field per line, tagged by its first character: a process
 * block (`p`id, `c`ommand, `L`ogin) followed by that process's file blocks
 * (`f`d, `t`ype, `P`rotocol, `n`ame, `T`CP state). Fields carry forward until
 * replaced, so the parser tracks the current process and flushes a socket each
 * time a new `f` block or process block begins.
 */
export function parseLsof(stdout: string): PortSocket[] {
	const sockets: PortSocket[] = [];

	let pid: number | null = null;
	let processName: string | null = null;
	let user: string | null = null;

	let protocol: PortProtocol | null = null;
	let name: string | null = null;
	let state: string | null = null;
	let ipVersion: PortIpVersion | undefined;

	const flush = (): void => {
		if (!protocol || !name) return;
		const [localText, peerText] = name.split('->');
		const local = splitAddressPort(localText);
		if (local) {
			sockets.push(
				makeSocket({
					protocol,
					local,
					peer: peerText ? splitAddressPort(peerText) : null,
					state,
					pid,
					processName,
					user,
					ipVersion
				})
			);
		}
		protocol = null;
		name = null;
		state = null;
		ipVersion = undefined;
	};

	for (const line of stdout.split('\n')) {
		if (!line) continue;
		const tag = line[0];
		const value = line.slice(1);

		switch (tag) {
			case 'p':
				flush();
				pid = Number.parseInt(value, 10) || null;
				break;
			case 'c':
				processName = value || null;
				break;
			case 'L':
				user = value || null;
				break;
			case 'f':
				flush();
				break;
			case 't':
				ipVersion = value === 'IPv6' ? 'v6' : value === 'IPv4' ? 'v4' : undefined;
				break;
			case 'P':
				protocol = value.toLowerCase() === 'udp' ? 'udp' : 'tcp';
				break;
			case 'n':
				name = value;
				break;
			case 'T':
				// Only the state matters; queue depths share this tag.
				if (value.startsWith('ST=')) state = value.slice(3);
				break;
			default:
				break;
		}
	}
	flush();

	return sockets;
}

// ---------------------------------------------------------------------------
// ss — Linux primary
// ---------------------------------------------------------------------------

const SS_ARGV = posixArgv(['ss', '-tuna', '-p']);

/** `users:(("nginx",pid=800,fd=6),("nginx",pid=801,fd=6))` → first pid + name. */
function parseSsProcess(field: string | undefined): { pid: number | null; name: string | null } {
	if (!field) return { pid: null, name: null };
	const match = field.match(/\("([^"]+)",pid=(\d+)/);
	if (!match) return { pid: null, name: null };
	return { name: match[1], pid: Number.parseInt(match[2], 10) || null };
}

export function parseSs(stdout: string): PortSocket[] {
	const sockets: PortSocket[] = [];

	for (const rawLine of stdout.split('\n')) {
		const line = rawLine.trim();
		if (!line) continue;
		// Older iproute2 has no -H, so the header is skipped by content.
		if (line.startsWith('Netid') || line.startsWith('State')) continue;

		const columns = line.split(/\s+/);
		if (columns.length < 5) continue;

		const netid = columns[0].toLowerCase();
		if (netid !== 'tcp' && netid !== 'udp') continue;
		const protocol: PortProtocol = netid === 'udp' ? 'udp' : 'tcp';

		const local = splitAddressPort(columns[4]);
		if (!local) continue;
		const peer = columns.length > 5 ? splitAddressPort(columns[5]) : null;
		const owner = parseSsProcess(columns.find((column) => column.startsWith('users:(')));

		sockets.push(
			makeSocket({
				protocol,
				local,
				peer,
				state: columns[1],
				pid: owner.pid,
				processName: owner.name,
				user: null
			})
		);
	}

	return sockets;
}

// ---------------------------------------------------------------------------
// netstat — Linux fallback and Windows primary
// ---------------------------------------------------------------------------

const NETSTAT_UNIX_ARGV = posixArgv(['netstat', '-tunap']);
const NETSTAT_WINDOWS_ARGV = ['netstat', '-ano'];

/** `800/sshd` → pid and name; a bare `-` means the kernel withheld the owner. */
function parseNetstatProcess(field: string | undefined): { pid: number | null; name: string | null } {
	if (!field || field === '-') return { pid: null, name: null };
	const [pidText, ...rest] = field.split('/');
	const pid = Number.parseInt(pidText, 10);
	return {
		pid: Number.isFinite(pid) ? pid : null,
		name: rest.length ? rest.join('/').split(' ')[0] || null : null
	};
}

export function parseNetstatUnix(stdout: string): PortSocket[] {
	const sockets: PortSocket[] = [];

	for (const rawLine of stdout.split('\n')) {
		const line = rawLine.trim();
		if (!line) continue;

		const columns = line.split(/\s+/);
		const proto = columns[0]?.toLowerCase() ?? '';
		if (!proto.startsWith('tcp') && !proto.startsWith('udp')) continue;
		const protocol: PortProtocol = proto.startsWith('udp') ? 'udp' : 'tcp';
		// `tcp6`/`udp6` name the family directly, which beats guessing from the
		// address — a wildcard bind looks identical in both families.
		const ipVersion: PortIpVersion = proto.endsWith('6') ? 'v6' : 'v4';

		const local = splitAddressPort(columns[3]);
		if (!local) continue;
		const peer = splitAddressPort(columns[4] ?? '');
		// UDP rows have no state column, so the owner shifts one place left.
		const state = protocol === 'tcp' ? (columns[5] ?? null) : null;
		const owner = parseNetstatProcess(protocol === 'tcp' ? columns[6] : columns[5]);

		sockets.push({
			...makeSocket({
				protocol,
				local,
				peer,
				state,
				pid: owner.pid,
				processName: owner.name,
				user: null,
				ipVersion
			})
		});
	}

	return sockets;
}

export function parseNetstatWindows(stdout: string): PortSocket[] {
	const sockets: PortSocket[] = [];

	for (const rawLine of stdout.split('\n')) {
		const line = rawLine.trim();
		if (!line) continue;

		const columns = line.split(/\s+/);
		const proto = columns[0]?.toUpperCase() ?? '';
		if (proto !== 'TCP' && proto !== 'UDP') continue;
		const protocol: PortProtocol = proto === 'UDP' ? 'udp' : 'tcp';

		const local = splitAddressPort(columns[1]);
		if (!local) continue;
		const peer = splitAddressPort(columns[2] ?? '');
		// TCP: proto local peer state pid. UDP: proto local peer pid.
		const state = protocol === 'tcp' ? (columns[3] ?? null) : null;
		const pidText = protocol === 'tcp' ? columns[4] : columns[3];
		const pid = Number.parseInt(pidText ?? '', 10);

		sockets.push(
			makeSocket({
				protocol,
				local,
				peer,
				state,
				pid: Number.isFinite(pid) && pid > 0 ? pid : null,
				// netstat never names the process; processes.ts fills this in.
				processName: null,
				user: null
			})
		);
	}

	return sockets;
}

// ---------------------------------------------------------------------------
// /proc/net — the Linux probe that needs nothing installed
// ---------------------------------------------------------------------------

/**
 * Every file the kernel publishes its socket tables in. `grep ''` over all four
 * prints each line prefixed with the file it came from, so one command returns
 * every family and protocol already labelled — and files that do not exist are
 * simply absent from the output.
 */
const PROC_NET_ARGV = posixArgv([
	'grep',
	'',
	'/proc/net/tcp',
	'/proc/net/tcp6',
	'/proc/net/udp',
	'/proc/net/udp6'
]);

/**
 * Sockets held open by processes we can see, as `inode → pid`.
 *
 * This is the one place a shell is used, because matching `/proc/<pid>/fd`
 * across every process needs a glob and there is no way to expand one without
 * it. The command is a fixed string with nothing interpolated into it.
 */
const PROC_FD_ARGV = ['sh', '-c', 'ls -l /proc/[0-9]*/fd/ 2>/dev/null'];

/** `0100007F` → `127.0.0.1`: four little-endian bytes in hex. */
function hexToIpv4(hex: string): string {
	const octets: number[] = [];
	for (let index = 6; index >= 0; index -= 2) octets.push(Number.parseInt(hex.slice(index, index + 2), 16));
	return octets.join('.');
}

/** 32 hex chars as four little-endian 32-bit words, rendered as IPv6. */
function hexToIpv6(hex: string): string {
	const groups: string[] = [];
	for (let word = 0; word < 4; word++) {
		const chunk = hex.slice(word * 8, word * 8 + 8);
		// Each 32-bit word is byte-swapped, giving two IPv6 groups once undone.
		const swapped = chunk.slice(6, 8) + chunk.slice(4, 6) + chunk.slice(2, 4) + chunk.slice(0, 2);
		groups.push(swapped.slice(0, 4), swapped.slice(4, 8));
	}

	// The v4-mapped form reads as the address people actually recognise.
	if (groups.slice(0, 5).every((group) => group === '0000') && groups[5].toLowerCase() === 'ffff') {
		const high = Number.parseInt(groups[6], 16);
		const low = Number.parseInt(groups[7], 16);
		return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
	}

	return compressIpv6(groups.map((group) => group.replace(/^0+/, '') || '0'));
}

/**
 * Collapse the longest run of zero groups into `::`, as IPv6 is written.
 * Done by finding the run rather than by rewriting the string: a regex that
 * chews through colons turns the all-zero address into a single `:`.
 */
function compressIpv6(groups: string[]): string {
	let bestStart = -1;
	let bestLength = 0;
	let runStart = -1;

	for (let index = 0; index <= groups.length; index++) {
		if (index < groups.length && groups[index] === '0') {
			if (runStart === -1) runStart = index;
			continue;
		}
		if (runStart !== -1) {
			const length = index - runStart;
			// A single zero group is written out; `::` is only for a run.
			if (length > bestLength && length > 1) {
				bestStart = runStart;
				bestLength = length;
			}
			runStart = -1;
		}
	}

	if (bestStart === -1) return groups.join(':');

	const head = groups.slice(0, bestStart).join(':');
	const tail = groups.slice(bestStart + bestLength).join(':');
	return `${head}::${tail}`;
}

/** TCP states as `/proc/net/tcp` numbers them. */
const PROC_STATE_LISTEN = '0A';
const PROC_STATE_ESTABLISHED = '01';

interface ProcNetSocket {
	socket: PortSocket;
	inode: number;
}

export function parseProcNet(stdout: string): ProcNetSocket[] {
	const results: ProcNetSocket[] = [];

	for (const rawLine of stdout.split('\n')) {
		const line = rawLine.trim();
		if (!line) continue;

		const labelled = line.match(/^\/proc\/net\/(tcp6?|udp6?):(.*)$/);
		if (!labelled) continue;

		const source = labelled[1];
		const protocol: PortProtocol = source.startsWith('udp') ? 'udp' : 'tcp';
		const ipVersion: PortIpVersion = source.endsWith('6') ? 'v6' : 'v4';

		const columns = labelled[2].trim().split(/\s+/);
		// sl, local, remote, state, queues, timers, retrans, uid, timeout, inode
		if (columns.length < 10 || !columns[0].endsWith(':')) continue;

		const [localHex, localPortHex] = (columns[1] ?? '').split(':');
		const [peerHex, peerPortHex] = (columns[2] ?? '').split(':');
		if (!localHex || !localPortHex) continue;

		const port = Number.parseInt(localPortHex, 16);
		if (!Number.isFinite(port)) continue;

		const state = (columns[3] ?? '').toUpperCase();
		const peerPort = Number.parseInt(peerPortHex ?? '', 16);
		const hasPeer = Number.isFinite(peerPort) && peerPort > 0;

		const toAddress = (hex: string): string =>
			ipVersion === 'v6' ? hexToIpv6(hex) : hexToIpv4(hex);

		results.push({
			inode: Number.parseInt(columns[9], 10) || 0,
			socket: makeSocket({
				protocol,
				local: { address: toAddress(localHex), port },
				peer: hasPeer ? { address: toAddress(peerHex), port: peerPort } : null,
				state:
					state === PROC_STATE_LISTEN
						? 'LISTEN'
						: state === PROC_STATE_ESTABLISHED
							? 'ESTABLISHED'
							: state,
				pid: null,
				processName: null,
				user: null,
				ipVersion
			})
		});
	}

	return results;
}

/** `ls -l /proc/<pid>/fd/` output → which process holds which socket inode. */
export function parseProcFdInodes(stdout: string): Map<number, number> {
	const owners = new Map<number, number>();
	let pid: number | null = null;

	for (const line of stdout.split('\n')) {
		const header = line.match(/^\/proc\/(\d+)\/fd\/?:$/);
		if (header) {
			pid = Number.parseInt(header[1], 10);
			continue;
		}
		if (pid === null) continue;

		const socket = line.match(/socket:\[(\d+)\]/);
		if (!socket) continue;
		const inode = Number.parseInt(socket[1], 10);
		// First writer wins: a forked child inherits the same inode, and the
		// listing walks pids in ascending order, so that is the parent.
		if (Number.isFinite(inode) && !owners.has(inode)) owners.set(inode, pid);
	}

	return owners;
}

// ---------------------------------------------------------------------------
// Probe selection
// ---------------------------------------------------------------------------

const PIDS_NEED_ROOT: PortLimitation = {
	code: 'pids-need-root',
	message:
		'Some sockets are owned by other users. The kernel only names the owning process for your own, so those rows have no owner.'
};

function ranWithoutOwners(sockets: PortSocket[]): boolean {
	if (sockets.length === 0) return false;
	return sockets.some((socket) => socket.pid === null);
}

/**
 * Read the socket table with whichever probe this host can actually run.
 *
 * The chain matters on locked-down hosts. Shared hosting and container images
 * routinely ship without `ss`, without `netstat`, or with both present but
 * outside the PATH a non-interactive SSH session is given — and some strip
 * `lsof` too. The kernel's own `/proc/net` tables need nothing installed at
 * all, so a Linux host can always be read even when every tool is missing;
 * only the owning process needs a second lookup there.
 */
export async function scanSockets(
	runner: CommandRunner,
	platform: ProbePlatform,
	/** Remembers which probe worked, so the chain is walked once per host. */
	memo: ProbeMemo = {}
): Promise<SocketScan> {
	const limitations: PortLimitation[] = [];
	const tried: string[] = [];
	let probe = 'none';
	let lastArgv: string[] = [];
	let lastParse: (stdout: string) => PortSocket[] = parseLsof;

	const attempt = async (
		argv: string[],
		parse: (stdout: string) => PortSocket[]
	): Promise<PortSocket[] | null> => {
		const name = argv.find((part) => !part.includes('=') && part !== 'env') ?? argv[0];
		tried.push(name);
		probe = name;
		lastArgv = argv;
		lastParse = parse;
		try {
			const result = await runner.run(argv);
			// `ss` and `netstat` exit non-zero on a missing binary but also when
			// they merely could not resolve some rows, so output wins over status.
			const sockets = parse(result.stdout);
			if (sockets.length > 0) return sockets;
			if (result.code === 0) return sockets;
			return null;
		} catch (error) {
			debug.log('ports', `probe ${argv[0]} failed on ${runner.label}:`, error);
			return null;
		}
	};

	/** The kernel's own tables, plus a best-effort owner for each socket. */
	const attemptProcNet = async (): Promise<PortSocket[] | null> => {
		tried.push('/proc/net');
		probe = '/proc/net';
		try {
			const result = await runner.run(PROC_NET_ARGV);
			const rows = parseProcNet(result.stdout);
			if (rows.length === 0) return null;

			let owners = new Map<number, number>();
			try {
				const fds = await runner.run(PROC_FD_ARGV);
				owners = parseProcFdInodes(fds.stdout);
			} catch (error) {
				// Ports without an owner still answer "what is in use", which is
				// the question that brought the user here.
				debug.log('ports', `/proc fd scan failed on ${runner.label}:`, error);
			}

			return rows.map(({ socket, inode }) => ({ ...socket, pid: owners.get(inode) ?? null }));
		} catch (error) {
			debug.log('ports', `/proc/net read failed on ${runner.label}:`, error);
			return null;
		}
	};

	const noteFallback = (message: string): void => {
		limitations.push({ code: 'probe-fallback', message });
	};

	let sockets: PortSocket[] | null = null;

	// A host that has already answered is asked the same way again. Walking the
	// whole chain every tick means four failed commands a second on a host that
	// has none of the tools — which on an SSH connection is four channels spent
	// re-learning something that cannot change.
	if (memo.probe) {
		sockets = memo.probe === '/proc/net' ? await attemptProcNet() : await attempt(memo.argv ?? [], memo.parse ?? parseLsof);
		if (sockets) {
			for (const limitation of memo.limitations ?? []) limitations.push(limitation);
			if (platform !== 'win32' && ranWithoutOwners(sockets)) limitations.push(PIDS_NEED_ROOT);
			return { sockets, limitations, probe: memo.probe };
		}
		// The tool went away, or the host changed under us. Fall through and
		// re-derive rather than reporting an empty table.
		memo.probe = undefined;
	}

	if (platform === 'win32') {
		sockets = await attempt(NETSTAT_WINDOWS_ARGV, parseNetstatWindows);
	} else if (platform === 'darwin') {
		sockets = await attempt(LSOF_ARGV, parseLsof);
		if (!sockets) {
			sockets = await attempt(NETSTAT_UNIX_ARGV, parseNetstatUnix);
			if (sockets) noteFallback('`lsof` is unavailable here, so `netstat` was used instead.');
		}
	} else {
		sockets = await attempt(SS_ARGV, parseSs);

		if (!sockets) {
			sockets = await attempt(NETSTAT_UNIX_ARGV, parseNetstatUnix);
			if (sockets) noteFallback('`ss` is unavailable here, so `netstat` was used instead.');
		}
		if (!sockets) {
			sockets = await attempt(LSOF_ARGV, parseLsof);
			if (sockets) noteFallback('Neither `ss` nor `netstat` is available here, so `lsof` was used instead.');
		}
		if (!sockets) {
			sockets = await attemptProcNet();
			if (sockets) {
				noteFallback(
					'No port tool is installed here, so the kernel’s own /proc/net tables were read directly. Process names are unavailable that way.'
				);
			}
		}
	}

	if (!sockets) {
		throw new Error(
			platform === 'unknown'
				? `Could not tell what operating system ${runner.label} runs, so no port probe could be chosen.`
				: `Could not read the port table on ${runner.label}. Tried: ${tried.join(', ')}.`
		);
	}

	memo.probe = probe;
	memo.argv = lastArgv;
	memo.parse = lastParse;
	// Kept so a remembered probe still reports the same caveats it earned.
	memo.limitations = [...limitations];

	if (platform !== 'win32' && ranWithoutOwners(sockets)) limitations.push(PIDS_NEED_ROOT);

	return { sockets, limitations, probe };
}
