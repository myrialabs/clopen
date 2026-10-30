/**
 * Profile lock recovery.
 *
 * Chrome refuses to start on a profile another Chrome still holds, and
 * Puppeteer reports it as "The browser is already running for <dir>". On a
 * profile only Clopen ever uses, that other Chrome can only be one of ours that
 * outlived the server that launched it:
 *
 * - the server died without closing it (a crash, a kill, `bun --watch`
 *   restarting) — a Chrome reached over a WebSocket keeps running after its
 *   parent is gone, re-parented to init, invisible because it is headless;
 * - or the connection to it dropped (a laptop waking from sleep) and the pool
 *   forgot the browser without ending the process.
 *
 * Either way nothing would ever close it, so the preview stayed broken until
 * the machine was restarted. This module finds such a process by its
 * `--user-data-dir` and ends it, and clears the lock files a killed Chrome
 * leaves behind. A Chrome whose parent is another live Clopen server is left
 * alone: that profile is genuinely in use, and the error says so.
 */

import { existsSync, readdirSync, readlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { debug } from '$shared/utils/logger';
import { sleep } from '$shared/utils/async';

interface ProcessEntry {
	pid: number;
	ppid: number;
	command: string;
}

const LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

/** How long a killed Chrome gets to actually go away before we stop waiting. */
const EXIT_WAIT_MS = 3_000;

/** Every process on the machine with its parent and full command line. */
function listProcesses(): ProcessEntry[] {
	try {
		if (process.platform === 'win32') {
			const result = Bun.spawnSync(
				[
					'powershell',
					'-NoProfile',
					'-NonInteractive',
					'-Command',
					'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*--user-data-dir=*" } | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }'
				],
				{ stdout: 'pipe', stderr: 'ignore' }
			);
			return parseLines(result.stdout.toString(), '\t');
		}

		// `ww` lifts the column limit: a truncated command line would hide the
		// very `--user-data-dir` flag this is looking for.
		const result = Bun.spawnSync(['ps', '-axww', '-o', 'pid=,ppid=,command='], {
			stdout: 'pipe',
			stderr: 'ignore'
		});
		return parseLines(result.stdout.toString(), null);
	} catch (error) {
		debug.warn('preview', `⚠️ Could not list processes for profile recovery: ${error}`);
		return [];
	}
}

function parseLines(output: string, separator: string | null): ProcessEntry[] {
	const entries: ProcessEntry[] = [];
	for (const raw of output.split('\n')) {
		const line = raw.trim();
		if (!line) continue;

		if (separator) {
			const [pid, ppid, ...rest] = line.split(separator);
			entries.push({ pid: Number(pid), ppid: Number(ppid), command: rest.join(separator) });
			continue;
		}

		const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (match) entries.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
	}
	return entries.filter((entry) => Number.isFinite(entry.pid) && entry.pid > 0);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** The browser process for a profile — its helpers carry a `--type=` flag. */
function isBrowserProcessFor(entry: ProcessEntry, profileDir: string): boolean {
	if (entry.command.includes('--type=')) return false;
	return (
		entry.command.includes(`--user-data-dir=${profileDir}`) ||
		entry.command.includes(`--user-data-dir="${profileDir}"`)
	);
}

/** A Clopen server is a Bun process; anything else owning a Chrome is not one. */
function isLiveClopenServer(pid: number, processes: ProcessEntry[]): boolean {
	if (pid <= 1 || pid === process.pid || !isAlive(pid)) return false;
	const parent = processes.find((entry) => entry.pid === pid);
	return !!parent && /\bbun(\.exe)?\b/i.test(parent.command);
}

async function killAndWait(pid: number): Promise<void> {
	try {
		process.kill(pid, 'SIGKILL');
	} catch {
		return;
	}

	const deadline = Date.now() + EXIT_WAIT_MS;
	while (Date.now() < deadline && isAlive(pid)) {
		await sleep(50);
	}
}

/** Lock files whose recorded owner is gone. A live owner's lock is left be. */
function clearStaleLockFiles(profileDir: string): void {
	if (process.platform === 'win32') return;

	const lockPath = join(profileDir, 'SingletonLock');
	let owner: string;
	try {
		owner = readlinkSync(lockPath);
	} catch {
		return; // No lock — nothing to clear.
	}

	// "<hostname>-<pid>". The hostname is not compared: on a laptop it follows
	// the network (a DHCP-assigned name one day, `.local` the next), so a lock
	// left on another network would otherwise never count as stale.
	const pid = Number(owner.slice(owner.lastIndexOf('-') + 1));
	if (Number.isFinite(pid) && pid > 0 && isAlive(pid)) {
		const processes = listProcesses();
		const holder = processes.find((entry) => entry.pid === pid);
		// A live pid that is not a Chrome on this profile is a recycled pid.
		if (holder && isBrowserProcessFor(holder, profileDir)) return;
	}

	for (const name of LOCK_FILES) {
		rmSync(join(profileDir, name), { force: true });
	}
	debug.log('preview', `🔓 Cleared a stale profile lock (${owner}) in ${profileDir}`);
}

/**
 * Make a profile launchable: end orphaned Chromes holding it, clear stale locks.
 *
 * Throws when the profile is held by a Chrome that another live Clopen server
 * owns — killing that one would take someone else's preview down.
 */
export async function releaseProfile(profileDir: string): Promise<void> {
	if (!existsSync(profileDir)) return;

	const processes = listProcesses();
	const holders = processes.filter((entry) => isBrowserProcessFor(entry, profileDir));

	for (const holder of holders) {
		if (isLiveClopenServer(holder.ppid, processes)) {
			throw new Error(
				`This preview profile is in use by another running Clopen server (pid ${holder.ppid}). Stop that server, or open the project from it.`
			);
		}

		debug.warn('preview', `🧹 Ending orphaned Chrome ${holder.pid} that still held ${profileDir}`);
		await killAndWait(holder.pid);
	}

	clearStaleLockFiles(profileDir);
}

/**
 * End every orphaned preview Chrome under the profiles root.
 *
 * Run once per server, before the first launch. Orphans of profiles nobody
 * opens again would otherwise keep their renderers' memory until reboot.
 */
export async function sweepOrphanedProfiles(profilesRoot: string): Promise<void> {
	if (!existsSync(profilesRoot)) return;

	let dirs: string[];
	try {
		dirs = readdirSync(profilesRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(profilesRoot, entry.name));
	} catch {
		return;
	}

	for (const dir of dirs) {
		await releaseProfile(dir).catch((error) => {
			debug.warn('preview', `⚠️ ${error instanceof Error ? error.message : error}`);
		});
	}
}

/** Whether a launch failure is Chrome refusing a profile that is held. */
export function isProfileInUseError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('already running for') || message.includes('ProcessSingleton');
}
