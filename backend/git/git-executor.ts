/**
 * Git Command Executor
 * Spawns git CLI commands and returns raw output
 */

import { debug } from '$shared/utils/logger';
import { getCleanSpawnEnv } from '../utils/env';
import { resolveBinary } from '../utils/cli';

/**
 * The environment fragment carrying a caller's git identity.
 *
 * An alias rather than a bare `Record<string, string>` so the operations that
 * accept one say so in their signature — which is how a reader tells the
 * commands that care who is running them from the ones that do not.
 */
export type GitIdentityEnv = Record<string, string>;

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
	/**
	 * Extra environment for this invocation — in practice the `GIT_CONFIG_*`
	 * block that carries the caller's git identity (see
	 * `backend/git/identity/env.ts`).
	 *
	 * Passed per command rather than resolved here because resolving an identity
	 * costs a database read, and `git status` runs many times a second. Commands
	 * that create an object or talk to a remote ask for it; the read-only ones
	 * never pay for it.
	 *
	 * Applied last, so an identity can override the fixed variables below. That
	 * ordering matters for `core.sshCommand`, which nothing else here sets but a
	 * future variable might.
	 */
	env?: Record<string, string>;
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
	const { timeout = 30000, stdin, okExitCodes = [], env: extraEnv } = options;
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
			// `rebase --continue`, `merge --continue` and friends open $EDITOR for the
			// commit message. With no TTY that call blocks until our timeout kills it,
			// so point both editors at `true`: it exits 0 immediately and git keeps
			// the message git already prepared.
			GIT_EDITOR: 'true',
			GIT_SEQUENCE_EDITOR: 'true',
			// Use English output for consistent parsing
			LANG: 'en_US.UTF-8',
			LC_ALL: 'en_US.UTF-8',
			// The caller's git identity, last so it wins.
			...extraEnv
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
