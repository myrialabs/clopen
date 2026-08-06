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
 * backend/engine/README.md §10.13): we snapshot `~/.codex/auth.json` content
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

/**
 * Identity + freshness extracted from a ChatGPT `auth.json` blob.
 *
 * `accountId` (`tokens.account_id`) tells us *which* ChatGPT account a blob
 * belongs to; `lastRefresh` (epoch ms parsed from `last_refresh`) tells us how
 * *fresh* its tokens are. Both drive the no-clobber decision below: the Codex
 * CLI rotates the refresh token in place on every refresh (old token revoked),
 * so we must never write an older blob over a newer one for the same account —
 * doing so replays an already-revoked refresh token and bricks the account.
 */
interface AuthJsonMeta {
	accountId: string | null;
	lastRefresh: number | null;
}

function parseAuthJsonMeta(authJsonRaw: string): AuthJsonMeta {
	try {
		const parsed = JSON.parse(authJsonRaw) as {
			last_refresh?: unknown;
			tokens?: { account_id?: unknown } | null;
		};
		const accountId = typeof parsed.tokens?.account_id === 'string' ? parsed.tokens.account_id : null;
		let lastRefresh: number | null = null;
		if (typeof parsed.last_refresh === 'string') {
			const ts = Date.parse(parsed.last_refresh);
			lastRefresh = Number.isNaN(ts) ? null : ts;
		}
		return { accountId, lastRefresh };
	} catch {
		return { accountId: null, lastRefresh: null };
	}
}

/**
 * Decide whether the desired (DB) blob should overwrite the current on-disk
 * `auth.json`. The on-disk copy is authoritative for *freshness* because the
 * CLI refreshes it in place; the DB is authoritative only for *account switch*.
 *
 *   - disk empty / identical content → trivial (handled by caller).
 *   - different `account_id` → account switch → write.
 *   - same `account_id` → keep the live disk token unless the DB blob is
 *     strictly newer (e.g. just after a re-login produced a fresher token).
 *   - identity unknown on either side → fall back to freshness if both
 *     timestamps are present (keep disk when same-or-newer), else write.
 */
function shouldWriteAuthJson(current: string, desired: string): boolean {
	const cur = parseAuthJsonMeta(current);
	const des = parseAuthJsonMeta(desired);

	if (cur.accountId && des.accountId) {
		if (cur.accountId !== des.accountId) return true; // account switch
		// Same ChatGPT account already on disk — never clobber a fresher live
		// token; only adopt the DB blob when it is strictly newer.
		return des.lastRefresh !== null && cur.lastRefresh !== null && des.lastRefresh > cur.lastRefresh;
	}

	// Identity unknown on at least one side — defer to freshness when we can.
	if (cur.lastRefresh !== null && des.lastRefresh !== null) {
		return des.lastRefresh > cur.lastRefresh;
	}
	return true;
}

/**
 * Locate the account whose stored ChatGPT blob matches the given on-disk
 * `account_id`, so a token refresh persists back to the *right* account even
 * when the active account differs from the one currently on disk (per-stream
 * account override). Falls back to the active account only for legacy blobs
 * with no `account_id`; returns null when an id is present but matches no
 * account (avoid cross-contaminating an unrelated row).
 */
function findAccountForAuthJson(accountId: string | null): EngineAccount | null {
	if (!accountId) {
		return engineQueries.getActiveAccountForEngine('codex');
	}
	const provider = engineQueries.getProviderBySlug('codex', 'openai');
	if (!provider) return null;
	for (const account of engineQueries.getAccountsByProvider(provider.id)) {
		const parsed = parseCodexCredential(account.credential);
		if (parsed?.kind === 'chatgpt' && parseAuthJsonMeta(parsed.authJson).accountId === accountId) {
			return account;
		}
	}
	return null;
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
	// The codex CLI refuses to start when CODEX_HOME doesn't exist
	// ("Error loading configuration: CODEX_HOME points to … but that path does
	// not exist") — it doesn't create the dir itself. Every spawn site
	// (login PTY + SDK stream) resolves the path through here, so ensure it
	// exists on access to cover them all.
	ensureCodexHome();
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
		// The CLI rotates its refresh token in place on every refresh, so the
		// on-disk auth.json is the live, authoritative copy for the active
		// account. Only write the DB blob when the file is absent, belongs to a
		// different account (switch), or the DB copy is strictly newer — never
		// clobber a fresher on-disk token with a stale snapshot (that replays an
		// already-revoked refresh token and bricks the account).
		const current = readAuthJson();
		if (current === null || (current !== cred.authJson && shouldWriteAuthJson(current, cred.authJson))) {
			writeAuthJson(cred.authJson);
			debug.log('engine', `Codex: wrote auth.json from account "${account.name}" (${cred.authJson.length} bytes)`);
		}
	}

	return cred;
}

/**
 * Snapshot the current on-disk `auth.json` back into the credential row of the
 * account it belongs to (matched by `tokens.account_id`), so any token refresh
 * the CLI performed during the turn survives across account switches and restarts.
 *
 * Matching by `account_id` — rather than blindly targeting the active account —
 * keeps a per-stream account override (a turn run under a non-active account)
 * from writing its refreshed token onto the wrong row.
 *
 * No-op when:
 *   - The auth.json file doesn't exist.
 *   - No account matches the on-disk `account_id` (and no legacy fallback).
 *   - The matched account is API-key mode (auth.json wasn't touched).
 *   - The on-disk content is identical to what we already have stored.
 *   - The on-disk copy is older than the stored one (never persist a stale read).
 */
export function snapshotAuthJsonToActiveAccount(): void {
	const current = readAuthJson();
	if (current === null) return;

	const curMeta = parseAuthJsonMeta(current);
	const account = findAccountForAuthJson(curMeta.accountId);
	if (!account) return;

	const parsed = parseCodexCredential(account.credential);
	if (!parsed || parsed.kind !== 'chatgpt') return;
	if (current === parsed.authJson) return;

	// Guard against persisting an older read over a newer stored blob.
	const storedMeta = parseAuthJsonMeta(parsed.authJson);
	if (curMeta.lastRefresh !== null && storedMeta.lastRefresh !== null && curMeta.lastRefresh < storedMeta.lastRefresh) {
		return;
	}

	const updated = serializeCodexCredential({ kind: 'chatgpt', authJson: current });
	try {
		engineQueries.updateAccountCredential(account.id, updated);
		debug.log('engine', `Codex: persisted refreshed auth.json snapshot to account ${account.id}`);
	} catch (error) {
		debug.warn('engine', 'Codex: failed to persist auth.json snapshot:', error);
	}
}
