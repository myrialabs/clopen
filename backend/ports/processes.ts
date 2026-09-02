/**
 * Port manager — who the pid behind a socket actually is.
 *
 * A socket row carries a pid and, on some platforms, a truncated process name.
 * Neither answers "what is this and where did it come from" — that needs the
 * parent pid (to trace lineage back to a Clopen terminal), the full argv, and
 * the working directory (the strongest hint at which project a dev server
 * belongs to).
 *
 * The table is cached per host and refreshed incrementally: a full sweep on the
 * first tick and every `FULL_SWEEP_MS` after, and in between only pids never
 * seen before are looked up. That keeps a one-second poll to a single cheap
 * probe on Unix, and makes it affordable on Windows where the only source of
 * argv and parent pid is a PowerShell query that costs hundreds of milliseconds
 * to start.
 *
 * Cache entries are keyed by pid *and* start time, so a recycled pid is treated
 * as the new process it is rather than inheriting the dead one's identity.
 */

import type { PortLimitation, PortProcess } from '$shared/types/ports';
import type { CommandRunner, ProbePlatform } from '../host/runner';
import { debug } from '$shared/utils/logger';

/** How often the whole table is re-read, so exited pids stop being reported. */
const FULL_SWEEP_MS = 30_000;

/** Ceiling on pids named in one targeted lookup, to stay under argv limits. */
const LOOKUP_BATCH = 200;

const UNIX_PS_FORMAT = 'pid=,ppid=,user=,lstart=,args=';

/**
 * `ps` is run through `env LC_ALL=C` so lstart comes back in the English form
 * the parser below expects. `env` is on every POSIX host, and going through it
 * works identically for a local spawn and a remote exec — the alternative,
 * setting an environment variable, has no equivalent over an SSH command.
 */
export function unixPsArgv(platform: ProbePlatform, selector: string[] = []): string[] {
	const flag = platform === 'darwin' && selector.length === 0 ? '-axo' : '-eo';
	return selector.length > 0
		? ['env', 'LC_ALL=C', 'ps', '-o', UNIX_PS_FORMAT, ...selector]
		: ['env', 'LC_ALL=C', 'ps', flag, UNIX_PS_FORMAT];
}

const C_LOCALE_MONTHS: Record<string, number> = {
	Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
	Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
};

/**
 * Turn the five lstart tokens into a timestamp, strictly.
 *
 * `Date` must not be handed this text directly: given a French `mar. août 25`
 * it does not fail, it reads `mar.` as March and returns a date four months
 * off. So the shape is checked and the month looked up in a table, and
 * anything that does not match yields null — no start time is honest, a
 * confidently wrong one is not.
 */
export function parseCLocaleStart(tokens: string[]): string | null {
	if (tokens.length !== 5) return null;
	const [, month, day, time, year] = tokens;

	const monthIndex = C_LOCALE_MONTHS[month];
	if (monthIndex === undefined) return null;

	const dayNumber = Number.parseInt(day, 10);
	const yearNumber = Number.parseInt(year, 10);
	const clock = time.match(/^(\d{2}):(\d{2}):(\d{2})$/);
	if (!Number.isFinite(dayNumber) || !Number.isFinite(yearNumber) || !clock) return null;

	const started = new Date(
		yearNumber,
		monthIndex,
		dayNumber,
		Number.parseInt(clock[1], 10),
		Number.parseInt(clock[2], 10),
		Number.parseInt(clock[3], 10)
	);
	return Number.isNaN(started.getTime()) ? null : started.toISOString();
}

/**
 * `ps` prints lstart as exactly five tokens ("Tue Aug 25 08:24:48 2026"), so
 * the row is parsed positionally — that holds whatever the locale does to the
 * words themselves.
 */
function parsePsLine(line: string): PortProcess | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	const tokens = trimmed.split(/\s+/);
	if (tokens.length < 9) return null;

	const pid = Number.parseInt(tokens[0], 10);
	if (!Number.isFinite(pid)) return null;
	const parentPid = Number.parseInt(tokens[1], 10);

	return {
		pid,
		parentPid: Number.isFinite(parentPid) ? parentPid : null,
		user: tokens[2] || null,
		command: tokens.slice(8).join(' '),
		startedAt: parseCLocaleStart(tokens.slice(3, 8)),
		cwd: null
	};
}

export function parsePsOutput(stdout: string): PortProcess[] {
	const processes: PortProcess[] = [];
	for (const line of stdout.split('\n')) {
		const parsed = parsePsLine(line);
		if (parsed) processes.push(parsed);
	}
	return processes;
}

/**
 * PowerShell CIM output, one record per blank-line-separated block of
 * `Name: value` pairs. Windows has no `ps`, and `tasklist` reports neither the
 * parent pid nor the command line.
 */
export function parseWindowsProcesses(stdout: string): PortProcess[] {
	const processes: PortProcess[] = [];

	for (const block of stdout.split(/\r?\n\r?\n/)) {
		if (!block.trim()) continue;
		const fields = new Map<string, string>();
		for (const line of block.split(/\r?\n/)) {
			const separator = line.indexOf(':');
			if (separator <= 0) continue;
			fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
		}

		const pid = Number.parseInt(fields.get('ProcessId') ?? '', 10);
		if (!Number.isFinite(pid)) continue;
		const parentPid = Number.parseInt(fields.get('ParentProcessId') ?? '', 10);
		const started = new Date(fields.get('CreationDate') ?? '');

		processes.push({
			pid,
			parentPid: Number.isFinite(parentPid) ? parentPid : null,
			user: fields.get('UserName') || null,
			command: fields.get('CommandLine') || fields.get('Name') || '',
			startedAt: Number.isNaN(started.getTime()) ? null : started.toISOString(),
			cwd: null
		});
	}

	return processes;
}

/** `lsof -Fn` cwd output: a `p<pid>` line followed by that process's `n<path>`. */
export function parseLsofCwd(stdout: string): Map<number, string> {
	const cwds = new Map<number, string>();
	let pid: number | null = null;

	for (const line of stdout.split('\n')) {
		if (!line) continue;
		if (line[0] === 'p') {
			pid = Number.parseInt(line.slice(1), 10) || null;
		} else if (line[0] === 'n' && pid !== null) {
			cwds.set(pid, line.slice(1));
			pid = null;
		}
	}

	return cwds;
}

/** `ls -l /proc/<pid>/cwd` output: `… /proc/800/cwd -> /srv/app`. */
export function parseProcCwd(stdout: string): Map<number, string> {
	const cwds = new Map<number, string>();

	for (const line of stdout.split('\n')) {
		const match = line.match(/\/proc\/(\d+)\/cwd -> (.+)$/);
		if (!match) continue;
		const pid = Number.parseInt(match[1], 10);
		if (Number.isFinite(pid)) cwds.set(pid, match[2].trim());
	}

	return cwds;
}

const NO_CWD_ON_WINDOWS: PortLimitation = {
	code: 'no-cwd-support',
	message: 'Windows does not expose a process working directory, so the project a port belongs to cannot be inferred.'
};

const NO_ARGS_ON_WINDOWS: PortLimitation = {
	code: 'no-process-args',
	message: 'PowerShell was unavailable, so only process names could be read — no command line or parent process.'
};

/**
 * A host's process table. One instance per host, held for as long as that host
 * is being watched.
 */
export class ProcessTable {
	private readonly entries = new Map<number, PortProcess>();
	/** Pids whose cwd has been resolved, including those that resolved to none. */
	private readonly cwdResolved = new Set<number>();
	private lastFullSweep = 0;
	private readonly limitations: PortLimitation[] = [];

	constructor(
		private readonly runner: CommandRunner,
		private readonly platform: ProbePlatform
	) {}

	/** Limitations discovered while reading this host, deduplicated by code. */
	getLimitations(): PortLimitation[] {
		return [...this.limitations];
	}

	private noteLimitation(limitation: PortLimitation): void {
		if (this.limitations.some((existing) => existing.code === limitation.code)) return;
		this.limitations.push(limitation);
	}

	private absorb(processes: PortProcess[]): void {
		for (const process of processes) {
			const existing = this.entries.get(process.pid);
			// A pid whose start time moved is a different process wearing the same
			// number; drop everything remembered about the old one.
			if (existing && existing.startedAt !== process.startedAt) {
				this.cwdResolved.delete(process.pid);
			} else if (existing) {
				process.cwd = existing.cwd;
			}
			this.entries.set(process.pid, process);
		}
	}

	private async readAll(): Promise<PortProcess[]> {
		if (this.platform === 'win32') return this.readWindows(null);
		const result = await this.runner.run(unixPsArgv(this.platform));
		return parsePsOutput(result.stdout);
	}

	private async readSome(pids: number[]): Promise<PortProcess[]> {
		if (this.platform === 'win32') return this.readWindows(pids);
		const result = await this.runner.run(unixPsArgv(this.platform, ['-p', pids.join(',')]));
		return parsePsOutput(result.stdout);
	}

	/**
	 * Windows has no `ps`. `Get-CimInstance Win32_Process` is the one source
	 * that carries the parent pid and command line together, so it is asked for
	 * the pids in question and its cost amortised by the cache.
	 */
	private async readWindows(pids: number[] | null): Promise<PortProcess[]> {
		const filter = pids && pids.length > 0 ? `-Filter "${pids.map((pid) => `ProcessId=${pid}`).join(' or ')}"` : '';
		const script =
			`Get-CimInstance Win32_Process ${filter} | ` +
			'Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | Format-List';

		try {
			const result = await this.runner.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script]);
			if (result.code === 0) return parseWindowsProcesses(result.stdout);
		} catch (error) {
			debug.log('ports', 'PowerShell process lookup failed:', error);
		}

		// Fall back to names only, and say so — an unnamed parent means lineage
		// attribution silently stops working, which the user should know about.
		this.noteLimitation(NO_ARGS_ON_WINDOWS);
		try {
			const result = await this.runner.run(['tasklist', '/FO', 'CSV', '/NH']);
			return result.stdout
				.split(/\r?\n/)
				.map((line) => line.match(/^"([^"]*)","(\d+)"/))
				.filter((match): match is RegExpMatchArray => Boolean(match))
				.map((match) => ({
					pid: Number.parseInt(match[2], 10),
					parentPid: null,
					user: null,
					command: match[1],
					startedAt: null,
					cwd: null
				}));
		} catch (error) {
			debug.log('ports', 'tasklist fallback failed:', error);
			return [];
		}
	}

	/**
	 * Resolve working directories for pids that still lack one. Best-effort by
	 * design: on Unix the kernel only reveals it for our own processes, and on
	 * Windows there is no way to ask at all.
	 */
	private async resolveCwds(pids: number[]): Promise<void> {
		const pending = pids.filter((pid) => !this.cwdResolved.has(pid));
		if (pending.length === 0) return;

		if (this.platform === 'win32') {
			this.noteLimitation(NO_CWD_ON_WINDOWS);
			for (const pid of pending) this.cwdResolved.add(pid);
			return;
		}

		const batch = pending.slice(0, LOOKUP_BATCH);
		try {
			const cwds =
				this.platform === 'darwin'
					? parseLsofCwd((await this.runner.run(['lsof', '-a', '-d', 'cwd', '-Fn', '-p', batch.join(',')])).stdout)
					: parseProcCwd(
							(await this.runner.run(['ls', '-l', ...batch.map((pid) => `/proc/${pid}/cwd`)])).stdout
						);

			for (const pid of batch) {
				const cwd = cwds.get(pid);
				const entry = this.entries.get(pid);
				if (entry) entry.cwd = cwd ?? null;
				// Mark resolved either way: a process we may not inspect will not
				// become inspectable on the next tick, and retrying costs a probe.
				this.cwdResolved.add(pid);
			}
		} catch (error) {
			debug.log('ports', `cwd lookup failed on ${this.runner.label}:`, error);
			for (const pid of batch) this.cwdResolved.add(pid);
		}
	}

	/**
	 * Bring the table up to date for the pids a scan just produced. Returns the
	 * table itself so callers can walk parent chains beyond the pids they asked
	 * about — lineage needs ancestors that own no socket at all.
	 */
	async refresh(pids: number[], now: number): Promise<Map<number, PortProcess>> {
		const dueForSweep = now - this.lastFullSweep >= FULL_SWEEP_MS;

		if (dueForSweep || this.entries.size === 0) {
			try {
				const all = await this.readAll();
				this.absorb(all);
				this.lastFullSweep = now;
				// A full sweep is the only moment the table knows which pids are
				// gone, so prune here rather than letting dead entries accumulate.
				// A sweep that returned nothing failed; keep what we had.
				if (all.length > 0) this.prune(new Set(all.map((process) => process.pid)));
			} catch (error) {
				debug.log('ports', `process sweep failed on ${this.runner.label}:`, error);
			}
		} else {
			const unknown = pids.filter((pid) => !this.entries.has(pid)).slice(0, LOOKUP_BATCH);
			if (unknown.length > 0) {
				try {
					this.absorb(await this.readSome(unknown));
				} catch (error) {
					debug.log('ports', `process lookup failed on ${this.runner.label}:`, error);
				}
			}
		}

		await this.resolveCwds(pids.filter((pid) => this.entries.has(pid)));

		return this.entries;
	}

	private prune(live: Set<number>): void {
		for (const pid of this.entries.keys()) {
			if (!live.has(pid)) {
				this.entries.delete(pid);
				this.cwdResolved.delete(pid);
			}
		}
	}

	get(pid: number): PortProcess | null {
		return this.entries.get(pid) ?? null;
	}
}
