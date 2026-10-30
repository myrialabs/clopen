/**
 * What the preview's Chromes cost the machine.
 *
 * A preview Chrome is not one process but a tree — the browser, a GPU process,
 * a network service, one renderer per site — and the whole tree is what a slow
 * machine is paying for. Measured from the OS rather than from Chrome, because
 * CDP reports CPU time but no memory, and memory is the cost that grows with
 * every tab left open.
 *
 * Read only while someone is looking at the diagnostics panel, so `ps` running
 * once every couple of seconds is fine.
 */

import { debug } from '$shared/utils/logger';

export interface ProcessTreeUsage {
	pid: number;
	/** Processes in the tree, the browser itself included. */
	processes: number;
	/** Resident memory of the whole tree. */
	rssBytes: number;
	/** CPU of the whole tree, % of one core. Null where the OS does not report it cheaply. */
	cpuPercent: number | null;
}

interface Row {
	pid: number;
	ppid: number;
	rssBytes: number;
	cpu: number | null;
}

function readProcessTable(): Row[] {
	try {
		if (process.platform === 'win32') {
			const result = Bun.spawnSync(
				[
					'powershell',
					'-NoProfile',
					'-NonInteractive',
					'-Command',
					'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.WorkingSetSize)" }'
				],
				{ stdout: 'pipe', stderr: 'ignore' }
			);
			return result.stdout
				.toString()
				.split('\n')
				.map((line) => line.trim().split('\t'))
				.filter((parts) => parts.length === 3)
				.map(([pid, ppid, ws]) => ({ pid: Number(pid), ppid: Number(ppid), rssBytes: Number(ws) || 0, cpu: null }));
		}

		const result = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,rss=,%cpu='], { stdout: 'pipe', stderr: 'ignore' });
		return result.stdout
			.toString()
			.split('\n')
			.map((line) => line.trim().split(/\s+/))
			.filter((parts) => parts.length >= 4)
			.map(([pid, ppid, rss, cpu]) => ({
				pid: Number(pid),
				ppid: Number(ppid),
				// ps reports kilobytes.
				rssBytes: (Number(rss) || 0) * 1024,
				cpu: Number(cpu.replace(',', '.')) || 0
			}));
	} catch (error) {
		debug.warn('preview', `⚠️ Could not read the process table: ${error}`);
		return [];
	}
}

/** Usage of each process tree rooted at the given pids, in one `ps` call. */
export function measureProcessTrees(rootPids: number[]): Map<number, ProcessTreeUsage> {
	const usage = new Map<number, ProcessTreeUsage>();
	if (rootPids.length === 0) return usage;

	const rows = readProcessTable();
	const children = new Map<number, Row[]>();
	for (const row of rows) {
		const siblings = children.get(row.ppid) ?? [];
		siblings.push(row);
		children.set(row.ppid, siblings);
	}
	const byPid = new Map(rows.map((row) => [row.pid, row]));

	for (const rootPid of rootPids) {
		const root = byPid.get(rootPid);
		if (!root) continue;

		let processes = 0;
		let rssBytes = 0;
		let cpu: number | null = 0;
		const stack = [root];
		const seen = new Set<number>();

		while (stack.length > 0) {
			const row = stack.pop()!;
			if (seen.has(row.pid)) continue;
			seen.add(row.pid);

			processes += 1;
			rssBytes += row.rssBytes;
			cpu = row.cpu === null || cpu === null ? null : cpu + row.cpu;
			for (const child of children.get(row.pid) ?? []) stack.push(child);
		}

		usage.set(rootPid, {
			pid: rootPid,
			processes,
			rssBytes,
			cpuPercent: cpu === null ? null : Math.round(cpu * 10) / 10
		});
	}

	return usage;
}

/**
 * Memory the OS could hand out right now.
 *
 * `os.freemem()` on macOS counts only pages nobody has touched, which on a
 * machine that has been up for an hour is a few hundred MB no matter how much
 * is reclaimable — read as-is it would say every Mac is out of memory. The
 * kernel's own notion of "available" adds the inactive, purgeable and
 * speculative pages it can reclaim without swapping. Elsewhere `freemem()`
 * already means available (libuv reads MemAvailable on Linux).
 */
export function availableMemoryBytes(fallback: number): number {
	if (process.platform !== 'darwin') return fallback;

	try {
		const output = Bun.spawnSync(['vm_stat'], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString();
		const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]) || 4096;
		const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(output)?.[1]) || 0;
		const available =
			pages('Pages free') + pages('Pages inactive') + pages('Pages purgeable') + pages('Pages speculative');
		return available > 0 ? available * pageSize : fallback;
	} catch {
		return fallback;
	}
}
