/**
 * PATH Enrichment
 *
 * Ensures process.env.PATH contains the directories where CLI tools we care
 * about are typically installed, regardless of how clopen was launched
 * (GUI app, systemd service, docker/Railway container, cron, login shell,
 * …). Downstream consumers — Bun.which, Bun.spawn, getCleanSpawnEnv,
 * bun-pty — then see a PATH that matches reality on every platform.
 *
 * Strategy (in order, dedup'd, prepended so new entries win):
 *   1. Known install directories: deterministic list of locations used by
 *      common installers and package managers (our System Tools installer,
 *      `curl | bash` scripts, Homebrew, Scoop, winget links, cargo, bun,
 *      deno, volta, yarn, nvm/fnm node versions, …). Existing entries only.
 *   2. Harvested shell PATH: on Unix desktops where the user has custom
 *      rc-file PATH additions that aren't in our known list. Cached once
 *      per process — shell config rarely changes mid-session, and spawning
 *      a shell on every status call is both slow and spammy in logs when
 *      the environment has no usable shell (containers, minimal images).
 *      Skipped silently on Windows, when no valid shell is found, or when
 *      CLOPEN_SKIP_PATH_HARVEST=1.
 *   3. Existing process.env.PATH: preserved as fallback.
 *
 * Concurrency: refreshProcessPath() dedups via an in-flight promise so
 * parallel callers share one pass. Known-dir enumeration happens every
 * call so tools installed at runtime (via System Tools) become visible
 * without a restart.
 */

import { existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { debug } from '$shared/utils/logger';
import { getClopenDir } from './paths';

const SEP = process.platform === 'win32' ? ';' : ':';
const HARVEST_TIMEOUT_MS = 2000;

// Cached once per process — see file header for rationale.
let harvestAttempted = false;
let harvestedPath: string | null = null;

let inFlight: Promise<void> | null = null;

function posixKnownDirs(): string[] {
	const home = homedir();
	return [
		// clopen-managed binaries (cloudflared, future CLI installs)
		join(getClopenDir(), 'bin'),
		// install-script targets
		join(home, '.local', 'bin'),
		join(home, '.opencode', 'bin'),
		// user-scoped runtimes / package managers
		join(home, '.bun', 'bin'),
		join(home, '.deno', 'bin'),
		join(home, '.cargo', 'bin'),
		join(home, '.volta', 'bin'),
		join(home, '.yarn', 'bin'),
		join(home, 'go', 'bin'),
		// system package managers
		'/opt/homebrew/bin',
		'/opt/homebrew/sbin',
		'/usr/local/bin',
		'/usr/local/sbin',
		'/home/linuxbrew/.linuxbrew/bin',
		'/home/linuxbrew/.linuxbrew/sbin',
		'/usr/local/go/bin',
		// standard system dirs (usually inherited, but belt-and-suspenders)
		'/usr/bin',
		'/usr/sbin',
		'/bin',
		'/sbin'
	];
}

function windowsKnownDirs(): string[] {
	const home = homedir();
	const localAppData = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
	const appData = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming');
	const programFiles = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
	return [
		join(getClopenDir(), 'bin'),
		join(home, '.bun', 'bin'),
		join(home, '.deno', 'bin'),
		join(home, '.cargo', 'bin'),
		join(home, 'scoop', 'shims'),
		join(localAppData, 'Microsoft', 'WinGet', 'Links'),
		join(localAppData, 'Programs', 'Git', 'cmd'),
		join(programFiles, 'Git', 'cmd'),
		join(appData, 'npm')
	];
}

// Version managers keep per-version bin dirs; enumerate children.
async function versionManagerDirs(): Promise<string[]> {
	if (process.platform === 'win32') return [];
	const home = homedir();
	const out: string[] = [];

	const bases: Array<{ base: string; tail: string[] }> = [
		{ base: join(home, '.nvm', 'versions', 'node'), tail: ['bin'] },
		{ base: join(home, '.fnm', 'node-versions'), tail: ['installation', 'bin'] },
		{ base: join(home, '.asdf', 'installs'), tail: [] }
	];

	for (const { base, tail } of bases) {
		if (!existsSync(base)) continue;
		try {
			const entries = await readdir(base, { withFileTypes: true });
			for (const e of entries) {
				if (!e.isDirectory()) continue;
				const candidate = join(base, e.name, ...tail);
				if (tail.length > 0) {
					if (existsSync(candidate)) out.push(candidate);
				} else {
					// asdf: ~/.asdf/installs/<tool>/<version>/bin — glob one more level
					try {
						const versions = await readdir(candidate, { withFileTypes: true });
						for (const v of versions) {
							if (!v.isDirectory()) continue;
							const bin = join(candidate, v.name, 'bin');
							if (existsSync(bin)) out.push(bin);
						}
					} catch { /* ignore */ }
				}
			}
		} catch { /* ignore */ }
	}

	return out;
}

function isValidShellPath(shell: string | null | undefined): shell is string {
	if (!shell) return false;
	if (shell === 'unknown') return false;
	if (!shell.startsWith('/')) return false;
	try {
		return statSync(shell).isFile();
	} catch {
		return false;
	}
}

function resolveUserShell(): string | null {
	const envShell = process.env.SHELL;
	if (isValidShellPath(envShell)) return envShell;
	try {
		const info = userInfo();
		if (isValidShellPath(info.shell)) return info.shell;
	} catch { /* userInfo() can throw on some platforms */ }
	return null;
}

async function harvestShellPath(): Promise<string | null> {
	if (process.platform === 'win32') return null;
	if (process.env.CLOPEN_SKIP_PATH_HARVEST === '1') return null;

	const shell = resolveUserShell();
	if (!shell) return null;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HARVEST_TIMEOUT_MS);

	try {
		// -i sources rc files (.bashrc/.zshrc); -l sources login files
		// (.profile/.zprofile/.bash_profile). printf %s yields PATH cleanly;
		// rc banners go to stderr (ignored) or appear before our printf.
		const proc = Bun.spawn([shell, '-ilc', 'printf %s "$PATH"'], {
			stdout: 'pipe',
			stderr: 'ignore',
			signal: controller.signal
		});

		const [stdout, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			proc.exited
		]);

		if (exitCode !== 0) return null;

		const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
		const path = lines[lines.length - 1] ?? '';
		if (!path.includes('/')) return null;
		return path;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function splitPath(path: string | undefined | null): string[] {
	if (!path) return [];
	return path.split(SEP).map(s => s.trim()).filter(Boolean);
}

function filterExisting(dirs: string[]): string[] {
	const out: string[] = [];
	for (const d of dirs) {
		try {
			if (existsSync(d)) out.push(d);
		} catch { /* ignore */ }
	}
	return out;
}

function applyToProcess(prepend: string[]): void {
	const existing = splitPath(process.env.PATH);
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const entry of [...prepend, ...existing]) {
		if (seen.has(entry)) continue;
		seen.add(entry);
		merged.push(entry);
	}
	const next = merged.join(SEP);
	if (next !== (process.env.PATH ?? '')) {
		process.env.PATH = next;
		debug.log('path', `PATH enriched (${merged.length} entries)`);
	}
}

async function doEnrich(): Promise<void> {
	const known = process.platform === 'win32' ? windowsKnownDirs() : posixKnownDirs();
	const vmDirs = await versionManagerDirs();
	const existingKnown = filterExisting([...known, ...vmDirs]);

	if (!harvestAttempted) {
		harvestAttempted = true;
		harvestedPath = await harvestShellPath();
	}
	const harvested = splitPath(harvestedPath);

	applyToProcess([...existingKnown, ...harvested]);
}

/**
 * Enrich process.env.PATH so downstream Bun.which / Bun.spawn calls see
 * the same binaries a terminal user would. Safe to call repeatedly —
 * concurrent callers share one in-flight promise.
 */
export async function refreshProcessPath(): Promise<void> {
	if (!inFlight) {
		inFlight = doEnrich().finally(() => { inFlight = null; });
	}
	return inFlight;
}
