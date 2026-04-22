/**
 * Privilege Detection
 *
 * Determines whether the clopen server process is running with elevated
 * privileges (root on Unix, Administrator on Windows). Used by the
 * install-runner to decide whether a package manager invocation that
 * requires privilege (apt, choco) can realistically succeed in the
 * current non-interactive spawn mode.
 *
 * Cached for the process lifetime — elevation status does not change
 * while the process is running.
 */

import { debug } from '$shared/utils/logger';

let cached: boolean | null = null;

async function detectElevatedWindows(): Promise<boolean> {
	try {
		const proc = Bun.spawn(['net', 'session'], {
			stdout: 'ignore',
			stderr: 'ignore'
		});
		const exitCode = await proc.exited;
		return exitCode === 0;
	} catch {
		return false;
	}
}

function detectElevatedUnix(): boolean {
	try {
		const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
		return typeof getuid === 'function' && getuid.call(process) === 0;
	} catch {
		return false;
	}
}

/**
 * Returns true when the process is running elevated (root/Administrator).
 * First call performs detection; subsequent calls return the cached value.
 */
export async function isElevated(): Promise<boolean> {
	if (cached !== null) return cached;
	cached = process.platform === 'win32'
		? await detectElevatedWindows()
		: detectElevatedUnix();
	debug.log('path', `Privilege detection: ${cached ? 'elevated' : 'non-elevated'}`);
	return cached;
}
