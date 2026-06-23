/**
 * Codex credential resolution: dual-mode credential storage + shared `~/.codex/auth.json` swap.
 *
 * Codex supports two auth modes:
 *   - **API key** — paste `sk-…` token; `Codex({ apiKey })` auto-injects it
 *     into the spawned subprocess.
 *   - **ChatGPT** — browser OAuth via `codex login`; the CLI writes
 *     `~/.codex/auth.json` and refreshes it in-place.
 *
 * Multi-account ChatGPT support uses the **auth-blob swap** pattern (see
 * backend/engine/README.md §9.13): we snapshot `~/.codex/auth.json` content
 * into `engine_accounts.credential` after login, and write the active
 * account's snapshot back to the shared file on switch / stream-start.
 *
 * Trade-off: only one Codex account is "active on disk" at a time. Concurrent
 * streams from two ChatGPT accounts would race; our UI surfaces only one
 * active account per engine, so that constraint already holds for MVP.
 */

import fs from 'node:fs';
import path from 'node:path';
import { engineQueries, type EngineAccount } from '../../../database/queries/engine-queries';
import { getEngineUserConfigDir } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';

// Isolate Codex state (auth.json, sessions) to {clopenDir}/engine/codex/user/ instead
// of the shared ~/.codex so Clopen never mixes with the user's own Codex CLI
// usage. The same path is forwarded to every spawned `codex` subprocess via the
// CODEX_HOME env var (see ./stream.ts and ws/engine/codex/accounts.ts).
const CODEX_HOME = getEngineUserConfigDir('codex');
const AUTH_JSON_PATH = path.join(CODEX_HOME, 'auth.json');
const AUTH_JSON_TMP_PATH = path.join(CODEX_HOME, 'auth.json.tmp');

// ============================================================================
// Credential JSON wrapper
// ============================================================================

export type CodexCredential =
	| { kind: 'api_key'; apiKey: string }
	| { kind: 'chatgpt'; authJson: string };

/**
 * Parse the JSON wrapper stored in `engine_accounts.credential`.
 *
 * Both auth modes are stored as JSON so we can dispatch on `kind` at
 * stream-start without spawning a CLI to detect.
 */
export function parseCodexCredential(raw: string): CodexCredential | null {
	try {
		const parsed = JSON.parse(raw) as CodexCredential | { kind?: string };
		if (parsed && (parsed as CodexCredential).kind === 'api_key' && typeof (parsed as { apiKey?: unknown }).apiKey === 'string') {
			return parsed as CodexCredential;
		}
		if (parsed && (parsed as CodexCredential).kind === 'chatgpt' && typeof (parsed as { authJson?: unknown }).authJson === 'string') {
			return parsed as CodexCredential;
		}
		return null;
	} catch {
		// Backwards-compat: if the row was created by an older path that wrote a
		// raw API key without the JSON wrapper, treat it as an API key.
		if (raw.startsWith('sk-') || raw.startsWith('sk_')) {
			return { kind: 'api_key', apiKey: raw };
		}
		return null;
	}
}

export function serializeCodexCredential(cred: CodexCredential): string {
	return JSON.stringify(cred);
}

/** True when the model requires a ChatGPT-mode account (e.g. gpt-5.5). */
export function authModeOf(account: EngineAccount): 'api_key' | 'chatgpt' | null {
	const parsed = parseCodexCredential(account.credential);
	return parsed?.kind ?? null;
}

// ============================================================================
// Shared `~/.codex/auth.json` swap
// ============================================================================

function ensureCodexHome(): void {
	if (!fs.existsSync(CODEX_HOME)) {
		fs.mkdirSync(CODEX_HOME, { recursive: true });
	}
}

/**
 * Atomically replace `~/.codex/auth.json` with the given content. Writes to a
 * sibling tmp file then renames so a concurrent reader never sees a torn write.
 */
export function writeAuthJson(content: string): void {
	ensureCodexHome();
	fs.writeFileSync(AUTH_JSON_TMP_PATH, content, { encoding: 'utf-8' });
	fs.renameSync(AUTH_JSON_TMP_PATH, AUTH_JSON_PATH);
}

/** Read the current `~/.codex/auth.json` content, or null if absent. */
export function readAuthJson(): string | null {
	try {
		return fs.readFileSync(AUTH_JSON_PATH, 'utf-8');
	} catch {
		return null;
	}
}

export function authJsonExists(): boolean {
	return fs.existsSync(AUTH_JSON_PATH);
}

export function getAuthJsonPath(): string {
	return AUTH_JSON_PATH;
}

export function getCodexHomeDir(): string {
	return CODEX_HOME;
}

// ============================================================================
// Apply / persist auth from / to DB
// ============================================================================

/**
 * Apply the given account's credential to the runtime so the next Codex
 * subprocess picks it up:
 *   - `chatgpt` → write `authJson` blob into the shared `~/.codex/auth.json`
 *     (only if it differs from the current file content).
 *   - `api_key` → no filesystem mutation; caller supplies `apiKey` to
 *     `new Codex({ apiKey })`.
 *
 * Returns the parsed credential for downstream consumption (apiKey lookup).
 */
export function applyAccountAuth(account: EngineAccount): CodexCredential | null {
	const cred = parseCodexCredential(account.credential);
	if (!cred) {
		debug.warn('engine', `Codex: account ${account.id} has unrecognised credential format`);
		return null;
	}

	if (cred.kind === 'chatgpt') {
		// Idempotent: skip write if the file already matches (the CLI's own
		// token-refresh path mutates this same file in place — we don't want
		// to clobber a fresher token with a stale snapshot).
		const current = readAuthJson();
		if (current !== cred.authJson) {
			writeAuthJson(cred.authJson);
			debug.log('engine', `Codex: wrote auth.json from account "${account.name}" (${cred.authJson.length} bytes)`);
		}
	}

	return cred;
}

/**
 * Snapshot the current `~/.codex/auth.json` back into the active ChatGPT
 * account's credential row. Called after a stream finishes so any token
 * refresh the CLI performed during the turn survives across account switches.
 *
 * No-op when:
 *   - There's no active Codex account.
 *   - The active account is API-key mode (auth.json wasn't touched).
 *   - The auth.json file doesn't exist.
 *   - The on-disk content is identical to what we already have stored.
 */
export function snapshotAuthJsonToActiveAccount(): void {
	const account = engineQueries.getActiveAccountForEngine('codex');
	if (!account) return;

	const parsed = parseCodexCredential(account.credential);
	if (!parsed || parsed.kind !== 'chatgpt') return;

	const current = readAuthJson();
	if (current === null) return;
	if (current === parsed.authJson) return;

	const updated = serializeCodexCredential({ kind: 'chatgpt', authJson: current });
	try {
		engineQueries.updateAccountCredential(account.id, updated);
		debug.log('engine', `Codex: persisted refreshed auth.json snapshot to account ${account.id}`);
	} catch (error) {
		debug.warn('engine', 'Codex: failed to persist auth.json snapshot:', error);
	}
}
