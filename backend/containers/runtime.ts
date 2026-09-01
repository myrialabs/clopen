/**
 * Containers — which runtime this host has, decided by asking it.
 *
 * There is no setting for this and no toggle in the UI. A host either answers
 * `docker`, or answers `podman`, or has neither, and any of those three is a
 * fact Clopen can establish in one command. Docker is asked first because a
 * machine with both almost always means Podman installed alongside a Docker
 * that is actually in use; if Docker cannot answer, Podman is asked and used.
 *
 * The failure modes matter as much as the success. "No runtime installed",
 * "installed but the daemon is not running" and "installed but this account may
 * not talk to the socket" need three different things from the user, and
 * reporting all three as "no containers" would be a lie the user cannot debug.
 * Clopen never runs any of this through `sudo`.
 */

import type { ContainerRuntime, ContainerRuntimeInfo } from '$shared/types/containers';
import { posixArgv, type CommandRunner, type ProbePlatform, type RunResult } from '../host/runner';
import { debug } from '$shared/utils/logger';

/** How long a working runtime is trusted before it is asked again. */
const OK_TTL_MS = 10 * 60_000;
/**
 * How long a broken or missing one is. Short on purpose: someone who has just
 * started Docker Desktop should see the panel come alive without reopening it.
 */
const PROBLEM_TTL_MS = 20_000;

interface CachedRuntime {
	info: ContainerRuntimeInfo;
	expiresAt: number;
}

const cache = new Map<string, CachedRuntime>();

/**
 * Build the argv for a runtime command on this platform.
 *
 * POSIX hosts go through `env` for a predictable PATH and a C locale — a
 * non-interactive SSH session routinely lacks `/usr/local/bin`, which is
 * exactly where Docker Desktop and Homebrew put these binaries, and a localised
 * date is one nothing can parse. Windows has neither problem and no `env`, so
 * the argv is passed through untouched.
 */
export function containerArgv(
	runtime: ContainerRuntime,
	platform: ProbePlatform,
	args: string[],
	options: { locale?: string | null } = {}
): string[] {
	const argv = [runtime, ...args];
	return platform === 'win32' ? argv : posixArgv(argv, options);
}

/**
 * Run a runtime command, reporting a missing binary as a failed command rather
 * than an exception. `Bun.spawn` throws when the executable does not exist,
 * which is a normal answer here — most hosts have no container runtime at all.
 */
export async function tryRun(
	runner: CommandRunner,
	argv: string[],
	timeoutMs?: number
): Promise<RunResult> {
	try {
		return await runner.run(argv, timeoutMs);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { stdout: '', stderr: message, code: 127 };
	}
}

const NOT_INSTALLED = /not found|no such file|not recognized|executablenotfound|enoent/i;
const PERMISSION_DENIED = /permission denied|dial unix.*permission|got permission denied/i;
const DAEMON_DOWN =
	/cannot connect to the docker daemon|is the docker daemon running|cannot connect to podman|connection refused|no such host|error during connect|the system cannot find the file specified/i;

/** Turn a failed probe into the reason a user can act on. */
function classify(result: RunResult): ContainerRuntimeInfo['problem'] {
	const text = `${result.stderr}\n${result.stdout}`;
	if (PERMISSION_DENIED.test(text)) return 'permission-denied';
	if (DAEMON_DOWN.test(text)) return 'daemon-unreachable';
	if (result.code === 127 || NOT_INSTALLED.test(text)) return 'not-installed';
	// An exit code with nothing recognisable in it is still not a usable runtime;
	// treat it as unreachable, which is the reading that invites a retry.
	return 'daemon-unreachable';
}

/** The first line of a runtime's error, which is the part worth showing. */
function firstLine(text: string): string | null {
	const line = text
		.split('\n')
		.map((value) => value.trim())
		.find((value) => value.length > 0);
	return line ?? null;
}

/**
 * Ask one runtime whether it is usable.
 *
 * `version` is the probe because it is the only command that talks to the
 * daemon while doing nothing to it, and because its failure text is what names
 * the three problems apart.
 */
async function probe(
	runtime: ContainerRuntime,
	runner: CommandRunner,
	platform: ProbePlatform
): Promise<ContainerRuntimeInfo> {
	const result = await tryRun(runner, containerArgv(runtime, platform, ['version', '--format', '{{json .}}']), 10_000);

	if (result.code !== 0) {
		return {
			runtime: null,
			version: null,
			problem: classify(result),
			detail: firstLine(result.stderr) ?? firstLine(result.stdout)
		};
	}

	let version: string | null = null;
	try {
		const parsed = JSON.parse(result.stdout.trim()) as {
			Server?: { Version?: string };
			Client?: { Version?: string };
		};
		version = parsed.Server?.Version ?? parsed.Client?.Version ?? null;
	} catch {
		// A version string Clopen cannot read does not make the runtime unusable.
	}

	return { runtime, version, problem: 'none', detail: null };
}

/**
 * The runtime this host has, cached.
 *
 * Cached because the answer costs a round trip on an SSH connection the
 * terminal and file browser are also using, and it cannot change between two
 * ticks of a one-second poll.
 */
export async function detectRuntime(
	hostId: string,
	runner: CommandRunner,
	platform: ProbePlatform,
	now = Date.now()
): Promise<ContainerRuntimeInfo> {
	const cached = cache.get(hostId);
	if (cached && cached.expiresAt > now) return cached.info;

	const docker = await probe('docker', runner, platform);
	let info = docker;

	if (docker.problem !== 'none') {
		const podman = await probe('podman', runner, platform);
		// A runtime that is installed but unhappy is more useful to report than
		// one that is simply absent — it is the one the user can fix.
		info = podman.problem === 'none' || docker.problem === 'not-installed' ? podman : docker;
	}

	if (info.problem !== 'none') {
		debug.log('containers', `no usable runtime on ${runner.label}: ${info.problem}`);
	}

	cache.set(hostId, {
		info,
		expiresAt: now + (info.problem === 'none' ? OK_TTL_MS : PROBLEM_TTL_MS)
	});
	return info;
}

/**
 * Drop a host's cached answer, so the next scan asks again.
 *
 * Called when a command fails in a way that says the daemon went away: the
 * cached "docker works" would otherwise keep a panel showing an empty table for
 * ten minutes after Docker Desktop was quit.
 */
export function forgetRuntime(hostId: string): void {
	cache.delete(hostId);
}

/** True when a command failed because the runtime itself became unusable. */
export function looksLikeRuntimeFailure(result: RunResult): boolean {
	if (result.code === 0) return false;
	const text = `${result.stderr}\n${result.stdout}`;
	return NOT_INSTALLED.test(text) || PERMISSION_DENIED.test(text) || DAEMON_DOWN.test(text);
}

/** The sentence shown when a host has no usable runtime. */
export function limitationFor(info: ContainerRuntimeInfo, hostLabel: string): string {
	switch (info.problem) {
		case 'not-installed':
			return `No container runtime found on ${hostLabel}. Install Docker or Podman and it will appear here — nothing needs configuring.`;
		case 'daemon-unreachable':
			return `A container runtime is installed on ${hostLabel} but is not running${
				info.detail ? `: ${info.detail}` : '.'
			}`;
		case 'permission-denied':
			return `This account may not talk to the container runtime on ${hostLabel}. Add it to the runtime's group, or use a rootless runtime — Clopen never runs commands through sudo.`;
		default:
			return '';
	}
}

/**
 * The line of a failure worth showing.
 *
 * The runtimes write several lines when they refuse something, and the first is
 * the reason — "volume is in use", "image has dependent child images". The rest
 * is usually the id repeated back.
 */
export function firstProblem(stderr: string, stdout: string, code: number): string {
	const line =
		stderr.trim().split('\n')[0] || stdout.trim().split('\n')[0] || `exit status ${code}`;
	// Both runtimes prefix errors with a level that means nothing to a reader.
	return line.replace(/^(Error(:| response from daemon:)|ERRO\[\d+\])\s*/i, '').trim() || line;
}
