/**
 * Server Environment Configuration & Spawn Environment Helper
 *
 * Provides:
 * - SERVER_ENV: saved server configuration values
 * - getCleanSpawnEnv(): clean environment for child processes
 *
 * Strategy: parse .env to get key-value pairs, then compare each against
 * process.env. If process.env[key] still equals the .env value, Bun set it
 * (or system happened to match) — either way safe to remove. If values
 * differ, something else changed it after .env load — keep it.
 * Runtime vars (npm_*, VITE_*, etc.) are always removed.
 *
 * No platform-specific code — works on Linux, macOS, Windows, WSL.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// ── Server configuration (read once at import time) ─────────────────
export const SERVER_ENV = {
	NODE_ENV: (process.env.NODE_ENV || 'development') as string,
	PORT: process.env.PORT ? parseInt(process.env.PORT) : 9141,
	HOST: (process.env.HOST || 'localhost') as string,
	isDevelopment: process.env.NODE_ENV !== 'production',
} as const;

// ── .env parsing ────────────────────────────────────────────────────

/**
 * Parse .env file into key-value map.
 * Knowing both key AND value lets us compare against process.env
 * to determine if Bun's auto-load is still in effect or if the
 * system/runtime changed the value after loading.
 */
function parseDotEnv(): Map<string, string> {
	const entries = new Map<string, string>();
	try {
		const content = readFileSync(join(process.cwd(), '.env'), 'utf-8');
		for (const line of content.split('\n')) {
			let trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			if (trimmed.startsWith('export ')) trimmed = trimmed.substring(7).trim();
			const eqIdx = trimmed.indexOf('=');
			if (eqIdx <= 0) continue;
			const key = trimmed.substring(0, eqIdx).trim();
			// Strip surrounding quotes from value
			let value = trimmed.substring(eqIdx + 1).trim();
			if ((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			entries.set(key, value);
		}
	} catch {
		// .env doesn't exist or can't be read
	}
	return entries;
}

// Capture once at import time
const dotEnv = parseDotEnv();

// ── Filter definitions ──────────────────────────────────────────────

/** Prefixes always injected by Bun/npm/Vite runtime. */
const FILTERED_PREFIXES = ['npm_', 'VITE_'];

/** Specific var names injected by runtime. */
const FILTERED_NAMES = new Set(['_BUN_WATCHER_CHILD', 'NODE_ENV', 'NODE']);

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
 * For each var in process.env:
 * - Runtime pollution (npm_*, VITE_*, NODE_ENV, NODE, _BUN_WATCHER_CHILD)
 *   → always removed
 * - Key exists in .env AND value still matches .env value
 *   → Bun set it, remove (system value was either same or overwritten)
 * - Key exists in .env BUT value differs from .env value
 *   → something changed it after .env load, keep current value
 * - Key not in .env, not runtime
 *   → system var, keep
 */
export function getCleanSpawnEnv(): Record<string, string> {
	const env: Record<string, string> = {};

	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (FILTERED_NAMES.has(key)) continue;
		if (FILTERED_PREFIXES.some((p: string) => key.startsWith(p))) continue;

		// .env comparison: remove only if value still matches what .env defined
		const dotEnvValue = dotEnv.get(key);
		if (dotEnvValue !== undefined && value === dotEnvValue) continue;

		env[key] = value;
	}

	cleanPath(env);
	return env;
}
