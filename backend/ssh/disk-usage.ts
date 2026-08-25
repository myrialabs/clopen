/**
 * ssh-client — how much space the account actually has.
 *
 * `df` answers a different question from the one the user is asking. On shared
 * hosting it reports the whole underlying filesystem: a cPanel account capped
 * at 5 GB sits on a 762 GB volume, so `df` cheerfully reports ~195 GB free
 * while the account is at 74% and about to stop accepting writes.
 *
 * So the account's own limit is asked for first, and `df` is only the fallback
 * — and whichever answered is reported alongside the numbers, because "3.7 of
 * 5 GB used (account quota)" and "195 GB free (filesystem)" are both true and
 * only one of them is useful.
 */

import type { Client as SshClient } from 'ssh2';
import { runCommandDetailed, shellQuote } from './connect';
import type { SftpDiskUsage, SftpUsageSource } from '$shared/types/ssh';
import { debug } from '$shared/utils/logger';

const MEGABYTE = 1024 * 1024;
const KILOBYTE = 1024;

function emptyUsage(path: string): SftpDiskUsage {
	return {
		path,
		totalBytes: null,
		usedBytes: null,
		availableBytes: null,
		source: 'unknown',
		sourceLabel: 'Unknown',
		inodesUsed: null,
		inodeLimit: null
	};
}

function labelFor(source: SftpUsageSource): string {
	switch (source) {
		case 'account-quota':
			return 'Account quota';
		case 'user-quota':
			return 'User quota';
		case 'filesystem':
			return 'Filesystem';
		default:
			return 'Unknown';
	}
}

function finite(value: unknown): number | null {
	const asNumber = typeof value === 'string' ? Number(value) : value;
	return typeof asNumber === 'number' && Number.isFinite(asNumber) ? asNumber : null;
}

/**
 * cPanel's UAPI, which every cPanel account can call as itself. This is the
 * number cPanel's own disk-usage widget shows, so matching it means Clopen and
 * the control panel never disagree.
 */
export function parseCpanelQuota(output: string, path: string): SftpDiskUsage | null {
	if (!output) return null;
	try {
		const parsed = JSON.parse(output) as {
			result?: {
				status?: number;
				data?: {
					megabytes_used?: number | string;
					megabyte_limit?: number | string;
					megabytes_remain?: number | string;
					inodes_used?: number | string;
					inode_limit?: number | string;
				};
			};
		};
		const data = parsed.result?.data;
		if (!data || parsed.result?.status !== 1) return null;

		const usedMegabytes = finite(data.megabytes_used);
		const limitMegabytes = finite(data.megabyte_limit);
		if (usedMegabytes === null) return null;

		// A limit of 0 means unlimited in cPanel, which is not a total we can
		// render as a percentage — report the usage without one.
		const hasLimit = limitMegabytes !== null && limitMegabytes > 0;
		const remainMegabytes = finite(data.megabytes_remain);
		const inodeLimit = finite(data.inode_limit);

		return {
			path,
			usedBytes: Math.round(usedMegabytes * MEGABYTE),
			totalBytes: hasLimit ? Math.round(limitMegabytes * MEGABYTE) : null,
			availableBytes:
				remainMegabytes !== null && hasLimit ? Math.round(remainMegabytes * MEGABYTE) : null,
			source: 'account-quota',
			sourceLabel: labelFor('account-quota'),
			inodesUsed: finite(data.inodes_used),
			inodeLimit: inodeLimit !== null && inodeLimit > 0 ? inodeLimit : null
		};
	} catch {
		return null;
	}
}

/**
 * POSIX filesystem quota, for a plain Linux box that has the `quota` tool.
 * `-w` forces one line per filesystem, which is what makes this parseable.
 */
export function parsePosixQuota(output: string, path: string): SftpDiskUsage | null {
	if (!output) return null;
	for (const line of output.split('\n')) {
		// A data line starts with a device path; headers and the "Disk quotas for
		// user…" preamble do not.
		const trimmed = line.trim();
		if (!trimmed.startsWith('/')) continue;

		// filesystem blocks quota limit [grace] files quota limit [grace]
		//
		// The grace columns are printed only while over quota, so the position of
		// everything after `limit` shifts depending on state. The block figures are
		// before that ambiguity and are safe to read; the file count is not, and is
		// left unreported rather than guessed at.
		const columns = trimmed.replace(/\*/g, '').split(/\s+/);
		if (columns.length < 4) continue;

		const usedBlocks = finite(columns[1]);
		const hardLimitBlocks = finite(columns[3]);
		const softLimitBlocks = finite(columns[2]);
		if (usedBlocks === null) continue;

		// The hard limit is the real ceiling; fall back to the soft one, and treat
		// 0 as "no limit set" exactly as the quota tools do.
		const limitBlocks =
			hardLimitBlocks && hardLimitBlocks > 0
				? hardLimitBlocks
				: softLimitBlocks && softLimitBlocks > 0
					? softLimitBlocks
					: null;
		if (limitBlocks === null) return null;

		const usedBytes = usedBlocks * KILOBYTE;
		const totalBytes = limitBlocks * KILOBYTE;
		return {
			path,
			usedBytes,
			totalBytes,
			availableBytes: Math.max(0, totalBytes - usedBytes),
			source: 'user-quota',
			sourceLabel: labelFor('user-quota'),
			inodesUsed: null,
			inodeLimit: null
		};
	}
	return null;
}

/** The underlying filesystem. Right for a VPS, misleading on shared hosting. */
export function parseFilesystemUsage(output: string, path: string): SftpDiskUsage | null {
	const dataLine = output.split('\n')[1];
	if (!dataLine) return null;

	const columns = dataLine.trim().split(/\s+/);
	if (columns.length < 4) return null;

	const totalBlocks = finite(columns[1]);
	const usedBlocks = finite(columns[2]);
	const availableBlocks = finite(columns[3]);
	if (totalBlocks === null) return null;

	return {
		path,
		totalBytes: totalBlocks * KILOBYTE,
		usedBytes: usedBlocks === null ? null : usedBlocks * KILOBYTE,
		availableBytes: availableBlocks === null ? null : availableBlocks * KILOBYTE,
		source: 'filesystem',
		sourceLabel: labelFor('filesystem'),
		inodesUsed: null,
		inodeLimit: null
	};
}

/** A command to run and the parser that reads its output. */
interface UsageProbe {
	command: string;
	parse: (output: string, path: string) => SftpDiskUsage | null;
}

/**
 * Ask each source in order of how well it answers the user's question, and
 * return the first that does. A host where none of them work reports nulls
 * rather than a number that is wrong.
 */
export async function readDiskUsage(client: SshClient, path: string): Promise<SftpDiskUsage> {
	const probes: UsageProbe[] = [
		{ command: 'uapi --output=json Quota get_quota_info', parse: parseCpanelQuota },
		{ command: 'quota -w 2>/dev/null', parse: parsePosixQuota },
		{ command: `df -Pk ${shellQuote(path)}`, parse: parseFilesystemUsage }
	];

	for (const probe of probes) {
		try {
			const result = await runCommandDetailed(client, probe.command, 15_000);
			// A non-zero exit is normal here: `uapi` and `quota` simply do not exist
			// on most hosts, and that is the signal to try the next source.
			if (result.code !== 0) continue;
			const usage = probe.parse(result.stdout, path);
			if (usage) return usage;
		} catch (error) {
			debug.warn(
				'ssh',
				`disk usage probe failed: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	return emptyUsage(path);
}
