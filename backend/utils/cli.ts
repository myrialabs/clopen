/**
 * CLI Binary Resolution & Status
 *
 * Single source of truth for detecting tools like `opencode`, `claude`, `git`.
 *
 * Resolution strategy:
 *   1. Enrich process.env.PATH with known install directories (and, on Unix
 *      desktops, the user's interactive-shell PATH) so binaries installed
 *      via our System Tools installer, nvm/fnm/volta/asdf/bun/homebrew, or
 *      by the user become visible without a clopen restart.
 *   2. Call `Bun.which(binary, { PATH: process.env.PATH })` — the explicit
 *      PATH option is critical: without it, Bun.which uses a cached startup
 *      PATH and ignores runtime updates, so newly-installed binaries remain
 *      invisible even though process.env.PATH has been refreshed.
 */

import { refreshProcessPath } from './path-enrich';

export type CLIStatus = { installed: boolean; version: string | null };

export function resolveBinary(binary: string): string | null {
	return Bun.which(binary, { PATH: process.env.PATH }) ?? null;
}

/**
 * Refresh $PATH from the user's shell, then resolve. Use at any spawn site
 * that may run after a fresh install (e.g. models:list, setup-token).
 */
export async function resolveBinaryWithRefresh(binary: string): Promise<string | null> {
	await refreshProcessPath();
	return resolveBinary(binary);
}

export async function getStatus(command: string): Promise<CLIStatus> {
	const resolved = await resolveBinaryWithRefresh(command);
	if (!resolved) return { installed: false, version: null };

	try {
		const proc = Bun.spawn([resolved, '--version'], { stdout: 'pipe', stderr: 'pipe' });
		const exitCode = await proc.exited;
		if (exitCode !== 0) return { installed: false, version: null };

		const stdout = await new Response(proc.stdout).text();
		const raw = stdout.trim();
		const version = raw.split(/[\s(]/)[0] || raw || null;
		return { installed: true, version };
	} catch {
		return { installed: false, version: null };
	}
}
