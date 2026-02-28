/**
 * Git Command Executor
 * Spawns git CLI commands and returns raw output
 */

import { debug } from '$shared/utils/logger';
import { getCleanSpawnEnv } from '../shared/env';

export interface GitExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Execute a git command in the given working directory
 */
export async function execGit(
	args: string[],
	cwd: string,
	timeout = 30000
): Promise<GitExecResult> {
	debug.log('git', `Executing: git ${args.join(' ')} in ${cwd}`);

	const proc = Bun.spawn(['git', ...args], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			...getCleanSpawnEnv(),
			// Prevent git from prompting for credentials
			GIT_TERMINAL_PROMPT: '0',
			// Use English output for consistent parsing
			LANG: 'en_US.UTF-8',
			LC_ALL: 'en_US.UTF-8'
		}
	});

	// Timeout handling
	const timeoutId = setTimeout(() => {
		proc.kill();
	}, timeout);

	try {
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text()
		]);

		const exitCode = await proc.exited;
		clearTimeout(timeoutId);

		if (exitCode !== 0) {
			debug.warn('git', `Command failed (exit ${exitCode}): git ${args.join(' ')}\n${stderr}`);
		}

		return { stdout, stderr, exitCode };
	} catch (err) {
		clearTimeout(timeoutId);
		throw err;
	}
}

/**
 * Check if a directory is a git repository
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		const result = await execGit(['rev-parse', '--is-inside-work-tree'], cwd, 5000);
		return result.exitCode === 0 && result.stdout.trim() === 'true';
	} catch {
		return false;
	}
}

/**
 * Get the root of the git repository
 */
export async function getGitRoot(cwd: string): Promise<string | null> {
	try {
		const result = await execGit(['rev-parse', '--show-toplevel'], cwd, 5000);
		if (result.exitCode === 0) {
			return result.stdout.trim();
		}
		return null;
	} catch {
		return null;
	}
}
