/**
 * User PATH Harvesting
 *
 * On Unix, clopen may be launched from an environment whose PATH differs
 * from the user's interactive shell — e.g. systemd, launchd, non-interactive
 * parent processes. Binaries installed via nvm/fnm/volta/asdf/bun/homebrew
 * live in paths added by `.zshrc`/`.bashrc`/`.profile`, which those minimal
 * environments do not source. This makes `Bun.which('claude')` return null
 * even though `claude -v` works in the user's terminal.
 *
 * Fix: spawn the user's login+interactive shell, read its PATH, and merge
 * back into `process.env.PATH`. All downstream consumers (`Bun.which`,
 * `Bun.spawn`, `getCleanSpawnEnv`, bun-pty) then see the correct PATH.
 *
 * Windows is a no-op — PATH on Windows is set via System/User Env Variables
 * and inherited correctly by child processes, and `Bun.which` already handles
 * PATHEXT resolution (.exe/.cmd/.bat).
 *
 * Concurrency: refreshProcessPath() dedups via an in-flight promise, so
 * parallel callers share a single shell spawn. No TTL — once resolved, the
 * next call performs a fresh harvest. This keeps "Recheck Installation"
 * live: install a CLI in terminal, click the button, harvest runs again.
 */

import { userInfo } from 'node:os';
import { debug } from '$shared/utils/logger';

const HARVEST_TIMEOUT_MS = 2000;

let harvestInFlight: Promise<string | null> | null = null;

function resolveUserShell(): string | null {
	if (process.env.SHELL) return process.env.SHELL;
	try {
		const info = userInfo();
		if (info.shell) return info.shell;
	} catch {
		// userInfo() can throw on some platforms — fall through
	}
	return null;
}

/**
 * Spawn the user's login+interactive shell and capture its PATH.
 * Returns null on Windows, on failure, or when no shell is available.
 */
async function harvestUserPath(): Promise<string | null> {
	if (process.platform === 'win32') return null;
	if (process.env.CLOPEN_SKIP_PATH_HARVEST === '1') {
		debug.log('path', 'PATH harvest skipped via CLOPEN_SKIP_PATH_HARVEST');
		return null;
	}

	const shell = resolveUserShell();
	if (!shell) {
		debug.warn('path', 'No $SHELL or user shell available — skipping PATH harvest');
		return null;
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HARVEST_TIMEOUT_MS);

	try {
		// -i makes the shell source rc files (.bashrc/.zshrc).
		// -l makes it source login files (.profile/.zprofile/.bash_profile).
		// printf %s (no newline) yields PATH cleanly; rc banners go to stderr
		// or are discarded if they go to stdout before our printf.
		const proc = Bun.spawn([shell, '-ilc', 'printf %s "$PATH"'], {
			stdout: 'pipe',
			stderr: 'ignore',
			signal: controller.signal
		});

		const [stdout, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			proc.exited
		]);

		if (exitCode !== 0) {
			debug.warn('path', `Shell exited ${exitCode} during PATH harvest`);
			return null;
		}

		// Some rc files echo banners before our printf runs. The last line of
		// stdout is PATH (our printf). Trim, then take the last non-empty line.
		const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
		const path = lines[lines.length - 1] ?? '';
		if (!path.includes('/')) {
			debug.warn('path', 'Harvested PATH looks invalid, skipping');
			return null;
		}
		return path;
	} catch (err) {
		debug.warn('path', 'PATH harvest failed:', err instanceof Error ? err.message : err);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Merge harvested PATH into process.env.PATH, preserving existing entries
 * as a fallback and deduplicating. Harvested entries are prepended so user
 * shell preferences win over whatever the parent process supplied.
 */
function applyHarvestedPath(harvested: string): void {
	const existing = process.env.PATH ?? '';
	const seen = new Set<string>();
	const merged: string[] = [];

	for (const entry of [...harvested.split(':'), ...existing.split(':')]) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		if (seen.has(trimmed)) continue;
		seen.add(trimmed);
		merged.push(trimmed);
	}

	const next = merged.join(':');
	if (next !== existing) {
		process.env.PATH = next;
		debug.log('path', `PATH refreshed (${merged.length} entries)`);
	}
}

/**
 * Ensure process.env.PATH reflects the user's interactive shell PATH.
 * - Windows: no-op.
 * - Unix: spawns the user's shell to harvest PATH, merges into process.env.
 * - Concurrent callers share a single in-flight harvest (promise dedup).
 * - No TTL: once the promise resolves, the next call starts a fresh harvest,
 *   so users can install a CLI in their terminal and re-check without restart.
 */
export async function refreshProcessPath(): Promise<void> {
	if (process.platform === 'win32') return;

	if (!harvestInFlight) {
		harvestInFlight = harvestUserPath();
		// Clear the slot once settled so the next call performs a fresh harvest.
		harvestInFlight.finally(() => {
			harvestInFlight = null;
		});
	}

	const harvested = await harvestInFlight;
	if (harvested) applyHarvestedPath(harvested);
}
