/**
 * What else lives in an engine's isolated home besides its transcripts.
 *
 * Each engine runs with its home redirected under `{clopenDir}/engine/<name>/user`
 * (§10.19), and the agents it runs inherit that: Open Code points every XDG dir
 * at its scope folder, so a model download, a `uv` environment or a package
 * cache a tool creates mid-task lands there. Those are caches by the tool's own
 * definition and come back on demand. They are named explicitly here — never
 * "everything that is not a transcript" — because the same folders also hold
 * the tools' CONFIG (`gh` keeps its sign-in in `$XDG_CONFIG_HOME/gh`).
 *
 * Legacy data: before the Open Code server pool, its data and cache dirs were
 * the engine home itself. Sessions now live under `pool/<scope>/`, and nothing
 * opens the old `opencode/opencode.db` (or its snapshots and logs) again. The
 * config files beside them — agents, commands, plugins — are still read and are
 * not touched.
 */

import fs from 'node:fs/promises';
import { join } from 'node:path';
import { getEngineUserConfigDir } from '$backend/utils/paths';
import { measurePath, removePath } from './fs-size';

/** Folder names tools create under `$XDG_CACHE_HOME` (and `$XDG_DATA_HOME` for uv). */
const TOOL_CACHE_DIRS = [
	'huggingface', 'uv', 'pip', 'pypoetry', 'bun', 'swiftpm', 'prisma', 'node-gyp', 'pnpm', 'yarn',
	'go-build', 'ms-playwright', 'puppeteer', 'typescript', 'deno', 'esbuild', 'electron', 'torch',
	'matplotlib', 'fontconfig', 'mesa_shader_cache', 'turbo', 'next', 'sccache', 'ccache', 'cypress',
	'selenium', 'jedi', 'black', 'ruff', 'mypy', 'pre-commit', 'vscode-ripgrep'
];

/** Open Code's pre-pool data inside its config folder. */
const OPENCODE_LEGACY = [
	'opencode.db', 'opencode.db-shm', 'opencode.db-wal', 'snapshot', 'log', 'tool-output', 'repos',
	'storage', 'project', 'bin', 'locks', 'models.json'
];

/** Log and scratch folders, per engine, relative to its home. Only files older than LOG_AGE_MS go. */
const LOG_DIRS: Record<string, string[]> = {
	claude: ['debug', 'telemetry', 'shell-snapshots'],
	codex: ['log', '.tmp', 'tmp', 'shell_snapshots'],
	copilot: ['logs'],
	qwen: ['debug', 'tmp'],
	opencode: [],
	pi: [],
	cursor: []
};

export const LOG_AGE_MS = 7 * 24 * 60 * 60_000;

export const ENGINE_HOME_NAMES = ['claude', 'codex', 'copilot', 'qwen', 'opencode', 'pi', 'cursor'] as const;

async function existing(paths: string[]): Promise<string[]> {
	const found: string[] = [];
	for (const path of paths) {
		try {
			await fs.lstat(path);
			found.push(path);
		} catch { /* absent */ }
	}
	return found;
}

/** Folders `$XDG_CACHE_HOME` has pointed at: the Open Code home and every pool scope. */
async function openCodeCacheHomes(): Promise<string[]> {
	const home = getEngineUserConfigDir('opencode');
	const homes = [home];
	try {
		for (const scope of await fs.readdir(join(home, 'pool'))) homes.push(join(home, 'pool', scope));
	} catch { /* no pool yet */ }
	return homes;
}

/** Caches an engine keeps for itself in its home, rebuilt on demand. */
const ENGINE_CACHE_DIRS: Record<string, string[]> = {
	codex: ['cache']
};

export async function toolCachePaths(): Promise<string[]> {
	const candidates: string[] = [];
	for (const home of await openCodeCacheHomes()) {
		for (const name of TOOL_CACHE_DIRS) candidates.push(join(home, name));
	}
	for (const [engine, names] of Object.entries(ENGINE_CACHE_DIRS)) {
		for (const name of names) candidates.push(join(getEngineUserConfigDir(engine), name));
	}
	return existing(candidates);
}

export async function legacyEnginePaths(): Promise<string[]> {
	const dir = join(getEngineUserConfigDir('opencode'), 'opencode');
	return existing(OPENCODE_LEGACY.map(name => join(dir, name)));
}

/** Log files old enough to go, across every engine (including each Open Code scope's log dir). */
export async function staleLogFiles(now = Date.now()): Promise<{ path: string; bytes: number }[]> {
	const dirs: string[] = [];
	for (const [engine, names] of Object.entries(LOG_DIRS)) {
		for (const name of names) dirs.push(join(getEngineUserConfigDir(engine), name));
	}
	for (const home of (await openCodeCacheHomes()).slice(1)) dirs.push(join(home, 'opencode', 'log'));

	const files: { path: string; bytes: number }[] = [];
	for (const dir of dirs) {
		const stack = [dir];
		while (stack.length > 0) {
			const current = stack.pop()!;
			let entries: import('node:fs').Dirent[];
			try {
				entries = await fs.readdir(current, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				const full = join(current, entry.name);
				if (entry.isDirectory()) {
					stack.push(full);
					continue;
				}
				const stat = await fs.lstat(full).catch(() => null);
				if (stat && now - stat.mtimeMs >= LOG_AGE_MS) files.push({ path: full, bytes: (await measurePath(full)).bytes });
			}
		}
	}
	return files;
}

export async function measurePaths(paths: string[]): Promise<number> {
	let bytes = 0;
	for (const path of paths) bytes += (await measurePath(path)).bytes;
	return bytes;
}

export async function removePaths(paths: string[]): Promise<{ freedBytes: number; removed: number; errors: string[] }> {
	const result = { freedBytes: 0, removed: 0, errors: [] as string[] };
	for (const path of paths) {
		try {
			result.freedBytes += await removePath(path);
			result.removed++;
		} catch (error) {
			result.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return result;
}
