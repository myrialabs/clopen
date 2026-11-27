/**
 * Server Environment Configuration & Spawn Environment Helper
 *
 * Provides:
 * - SERVER_ENV: saved server configuration values
 * - getCleanSpawnEnv(): clean environment for child processes
 *
 * Configuration comes from the shell environment and the CLI flags only —
 * there is no .env file. Child processes get the user's environment minus
 * what Clopen itself injected (its own server variables) and what the
 * runtime injected (npm_*, VITE_*, etc.).
 *
 * No platform-specific code — works on Linux, macOS, Windows, WSL.
 */

import { join } from 'path';
import { homedir } from 'os';

// ── Server configuration (read once at import time) ─────────────────
const isDev = process.env.NODE_ENV !== 'production';

/**
 * Resolve the Clopen data directory — the single decision point for where ALL
 * persisted state lives (app.db, engine homes, stack, snapshots, tunnel…).
 *
 * Resolved once, at import time, for two reasons:
 *
 * 1. `NODE_ENV` is not stable at runtime. Any dependency that assigns to
 *    `process.env.NODE_ENV` mid-process would otherwise silently move the data
 *    directory out from under a running server.
 * 2. The test runner sets `NODE_ENV=test`, which used to fall through to the
 *    production directory — so `bun test` opened the developer's real
 *    `~/.clopen/app.db` and rewrote live rows (that is what kept resetting the
 *    onboarding flag and system settings). Tests get their own directory here,
 *    once, so no individual test has to remember to isolate itself.
 *
 * `CLOPEN_DATA_DIR` overrides everything, for deployments that keep state
 * outside the home directory.
 */
function resolveDataDir(): string {
	const override = process.env.CLOPEN_DATA_DIR?.trim();
	if (override) return override;
	if (process.env.NODE_ENV === 'test') return join(homedir(), '.clopen-test');
	if (process.env.NODE_ENV === 'development') return join(homedir(), '.clopen-dev');
	return join(homedir(), '.clopen');
}

export const SERVER_ENV = {
	NODE_ENV: (process.env.NODE_ENV || 'development') as string,
	/** Absolute path to the Clopen data directory — see `resolveDataDir()`. */
	DATA_DIR: resolveDataDir(),
	/** Backend port — dev: CLOPEN_PORT_BACKEND (default 9161), prod: CLOPEN_PORT (default 9141) */
	PORT: isDev
		? (process.env.CLOPEN_PORT_BACKEND ? parseInt(process.env.CLOPEN_PORT_BACKEND) : 9161)
		: (process.env.CLOPEN_PORT ? parseInt(process.env.CLOPEN_PORT) : 9141),
	/** Frontend port — only used in dev for Vite proxy coordination */
	PORT_FRONTEND: process.env.CLOPEN_PORT_FRONTEND ? parseInt(process.env.CLOPEN_PORT_FRONTEND) : 9151,
	HOST: (process.env.CLOPEN_HOST || 'localhost') as string,
	isDevelopment: isDev,
} as const;

// ── Filter definitions ──────────────────────────────────────────────

/** Prefixes always injected by Bun/npm/Vite runtime. */
const FILTERED_PREFIXES = ['npm_', 'VITE_'];

/**
 * Specific var names never passed on: injected by the runtime, or Clopen's own
 * server variables. The latter describe *this* server — a `clopen` or
 * `bun run dev` started in a Clopen terminal must pick its own port and host,
 * not inherit the ones the parent server is bound to.
 */
const FILTERED_NAMES = new Set([
	'_BUN_WATCHER_CHILD',
	'NODE_ENV',
	'NODE',
	'CLOPEN_HOST',
	'CLOPEN_PORT',
	'CLOPEN_PORT_FRONTEND',
	'CLOPEN_PORT_BACKEND',
	'CLOPEN_DEBUG'
]);

/** Remove node_modules/.bin entries from PATH. */
function cleanPath(env: Record<string, string>): void {
	const pathKey = process.platform === 'win32'
		? (env['Path'] !== undefined ? 'Path' : 'PATH')
		: 'PATH';
	const pathValue = env[pathKey];
	if (pathValue) {
		const sep = process.platform === 'win32' ? ';' : ':';
		env[pathKey] = pathValue
			.split(sep)
			.filter((p: string) => !p.includes('node_modules'))
			.join(sep);
	}
}

/**
 * Build a clean environment for spawning child processes.
 *
 * Every var in process.env is kept except runtime pollution and Clopen's own
 * server variables (FILTERED_PREFIXES / FILTERED_NAMES).
 */
export function getCleanSpawnEnv(): Record<string, string> {
	const env: Record<string, string> = {};

	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (FILTERED_NAMES.has(key)) continue;
		if (FILTERED_PREFIXES.some((p: string) => key.startsWith(p))) continue;

		env[key] = value;
	}

	cleanPath(env);
	return env;
}
