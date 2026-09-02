/**
 * Port manager — stopping what is holding a port.
 *
 * Three paths, because "kill it" means three different things:
 *
 * - A port a Clopen feature owns is released through that feature, never by
 *   signalling a pid. Killing the process behind an SSH forward would leave the
 *   forward's own record claiming it is still running.
 * - Anything else is stopped by signalling the process tree, children first so
 *   a supervisor cannot restart them on the way down, SIGTERM before SIGKILL so
 *   a dev server gets its chance to shut down cleanly.
 * - Clopen's own socket is never a target.
 *
 * A refusal by the OS is reported as what it is. Nothing here escalates to
 * `sudo`: a port owned by another user is the administrator's business, and
 * quietly acquiring privilege to end someone else's process is not a thing this
 * panel should do behind the user's back.
 */

import type { PortKillResult, PortOwnerFeature } from '$shared/types/ports';
import { parsePsOutput, unixPsArgv } from './processes';
import type { CommandRunner, ProbePlatform } from '../host/runner';
import { sshForwardManager } from '../ssh/forwards';
import { connectionManager } from '../db-client/connection-manager';
import { debug } from '$shared/utils/logger';

/** Grace between the polite signal and the final one. */
const SIGKILL_DELAY_MS = 2_000;

/** Ceiling on tree depth, so a malformed parent chain cannot loop. */
const MAX_TREE_DEPTH = 20;

export interface KillTarget {
	pid: number;
	/** Set when a Clopen feature owns the port. */
	ownerFeature?: PortOwnerFeature;
	ownerId?: string;
}

/** Release a port through the feature that opened it. */
async function stopFeature(feature: PortOwnerFeature, ownerId: string | undefined): Promise<PortKillResult> {
	if (!ownerId) {
		return { ok: false, killedPids: [], stoppedFeature: null, error: 'That port has no owning record to stop.' };
	}

	try {
		switch (feature) {
			case 'ssh-forward':
				await sshForwardManager.stop(ownerId);
				return { ok: true, killedPids: [], stoppedFeature: feature, error: null };
			case 'db-client-tunnel':
				await connectionManager.release(ownerId);
				return { ok: true, killedPids: [], stoppedFeature: feature, error: null };
			default:
				return {
					ok: false,
					killedPids: [],
					stoppedFeature: null,
					error: 'That port belongs to Clopen and cannot be released from here.'
				};
		}
	} catch (error) {
		return {
			ok: false,
			killedPids: [],
			stoppedFeature: null,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}

/**
 * Every descendant of `pid`, deepest first. Read fresh rather than from the
 * scan cache: a tick-old tree could name a pid the OS has already recycled.
 */
async function descendantsOf(pid: number, runner: CommandRunner, platform: ProbePlatform): Promise<number[]> {
	if (platform === 'win32') return [];

	const result = await runner.run(unixPsArgv(platform));

	const children = new Map<number, number[]>();
	for (const process of parsePsOutput(result.stdout)) {
		if (process.parentPid === null) continue;
		const siblings = children.get(process.parentPid);
		if (siblings) siblings.push(process.pid);
		else children.set(process.parentPid, [process.pid]);
	}

	const ordered: number[] = [];
	const visit = (current: number, depth: number): void => {
		if (depth >= MAX_TREE_DEPTH) return;
		for (const child of children.get(current) ?? []) {
			visit(child, depth + 1);
			ordered.push(child);
		}
	};
	visit(pid, 0);

	return ordered;
}

/** Is the process still there? `kill -0` asks without sending anything. */
async function isAlive(pid: number, runner: CommandRunner, platform: ProbePlatform): Promise<boolean> {
	try {
		if (platform === 'win32') {
			const result = await runner.run(['tasklist', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
			return result.stdout.includes(`"${pid}"`);
		}
		const result = await runner.run(['kill', '-0', String(pid)]);
		return result.code === 0;
	} catch {
		return false;
	}
}

/**
 * Turn a failed signal into something worth reading. `kill` says "Operation not
 * permitted" and nothing about why, which is the most common outcome here.
 */
function explain(stderr: string, pid: number): string {
	const text = stderr.trim();
	if (/not permitted|access is denied/i.test(text)) {
		return `Not allowed to stop process ${pid}. It belongs to another user — stop it from an account that owns it.`;
	}
	if (/no such process/i.test(text)) return `Process ${pid} had already exited.`;
	return text || `Could not stop process ${pid}.`;
}

/** Signal a process tree, children first, escalating only if it survives. */
export async function killProcessTree(
	pid: number,
	runner: CommandRunner,
	platform: ProbePlatform
): Promise<PortKillResult> {
	const killed: number[] = [];

	if (platform === 'win32') {
		// taskkill walks the tree itself, which is the only reliable way to do it
		// on Windows — there is no signal to escalate through.
		try {
			const result = await runner.run(['taskkill', '/T', '/F', '/PID', String(pid)]);
			if (result.code === 0) return { ok: true, killedPids: [pid], stoppedFeature: null, error: null };
			return { ok: false, killedPids: [], stoppedFeature: null, error: explain(result.stderr || result.stdout, pid) };
		} catch (error) {
			return {
				ok: false,
				killedPids: [],
				stoppedFeature: null,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	const targets = [...(await descendantsOf(pid, runner, platform)), pid];
	let lastError: string | null = null;

	for (const target of targets) {
		try {
			const result = await runner.run(['kill', '-TERM', String(target)]);
			if (result.code === 0) killed.push(target);
			else if (target === pid) lastError = explain(result.stderr, target);
		} catch (error) {
			if (target === pid) lastError = error instanceof Error ? error.message : String(error);
		}
	}

	if (killed.length === 0) {
		return { ok: false, killedPids: [], stoppedFeature: null, error: lastError ?? `Could not stop process ${pid}.` };
	}

	await new Promise((resolve) => setTimeout(resolve, SIGKILL_DELAY_MS));

	for (const target of killed) {
		if (!(await isAlive(target, runner, platform))) continue;
		try {
			await runner.run(['kill', '-KILL', String(target)]);
		} catch (error) {
			debug.log('ports', `SIGKILL failed for ${target}:`, error);
		}
	}

	// The port is only actually free if the process that held it is gone.
	if (await isAlive(pid, runner, platform)) {
		return {
			ok: false,
			killedPids: killed,
			stoppedFeature: null,
			error: `Process ${pid} ignored both signals and is still running.`
		};
	}

	return { ok: true, killedPids: killed, stoppedFeature: null, error: null };
}

/** Stop whatever holds a port, by the route that suits its owner. */
export async function stopPortHolder(
	target: KillTarget,
	runner: CommandRunner,
	platform: ProbePlatform
): Promise<PortKillResult> {
	if (target.ownerFeature) return stopFeature(target.ownerFeature, target.ownerId);
	return killProcessTree(target.pid, runner, platform);
}
