/**
 * Git Command Executor
 * Spawns git CLI commands and returns raw output
 */

import { debug } from '$shared/utils/logger';
import { getCleanSpawnEnv } from '../utils/env';
import { resolveBinary } from '../utils/cli';

export interface GitExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface GitExecOptions {
	/** Milliseconds before the process is killed. */
	timeout?: number;
	/** Piped to the command's stdin (e.g. `check-ignore --stdin` path lists). */
	stdin?: string;
	/**
	 * Exit codes that are a normal answer rather than a failure, so they are
	 * not logged as one — `check-ignore` exits 1 to say "nothing matched".
	 */
	okExitCodes?: number[];
}

/**
 * Execute a git command in the given working directory.
 * The third argument accepts a timeout in ms (legacy form) or an options object.
 */
export async function execGit(
	args: string[],
	cwd: string,
	timeoutOrOptions: number | GitExecOptions = 30000
): Promise<GitExecResult> {
	const options: GitExecOptions =
		typeof timeoutOrOptions === 'number' ? { timeout: timeoutOrOptions } : timeoutOrOptions;
	const { timeout = 30000, stdin, okExitCodes = [] } = options;
	debug.log('git', `Executing: git ${args.join(' ')} in ${cwd}`);

	const gitPath = resolveBinary('git');
	if (!gitPath) throw new Error('git binary not found on PATH');

	const safeCwd = cwd.replace(/\\/g, '/');
	const proc = Bun.spawn([gitPath, '-c', `safe.directory=${safeCwd}`, ...args], {
		cwd,
		// Commands that read a path list (`check-ignore --stdin`) get it here —
		// far safer than argv, which has a length limit and quoting pitfalls.
		stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			...getCleanSpawnEnv(),
			// Prevent git from prompting for credentials
			GIT_TERMINAL_PROMPT: '0',
			// Read-only commands must stay read-only. Without this, `git status`
			// opportunistically rewrites `.git/index` to refresh cached stat data —
			// which trips our own `.git` watcher, which emits `git:changed`, which
			// makes the client re-run `git status`. That feedback loop refreshed the
			// Git panel (and reloaded the open diff) every few seconds with nothing
			// actually changing. Commands that genuinely need the index lock (commit,
			// add, checkout) still take it; only the optional refresh is suppressed.
			GIT_OPTIONAL_LOCKS: '0',
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

		if (exitCode !== 0 && !okExitCodes.includes(exitCode)) {
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
