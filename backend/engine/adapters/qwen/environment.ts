/**
 * Environment configuration for the Qwen Code engine.
 *
 * Builds an env dictionary to pass via the SDK's `env` option (the SDK
 * forwards it into the spawned `qwen` subprocess). We intentionally do NOT
 * mutate `process.env` — multiple projects can stream concurrently.
 *
 * Auth model: paste-token, per-account.
 *   `engine_accounts.credential` carries a JSON blob (see ./credential.ts):
 *   `{ apiKey, preset }`. The chosen preset (DashScope CN/INTL, OpenRouter,
 *   Fireworks) decides the base URL — there's no per-account override.
 *
 * `qwen-oauth` (the CLI's browser sign-in flow that writes `~/.qwen/`) is
 * intentionally not wired into the SDK path: the SDK README states it isn't
 * recommended because credentials need periodic refresh, and Alibaba
 * deprecated the free-tier OAuth in April 2026.
 */

import fs from 'node:fs';
import path from 'node:path';
import { engineQueries } from '$backend/database/queries/engine-queries';
import type { EngineAccount } from '$backend/database/queries/engine-queries';
import { getCleanSpawnEnv } from '$backend/utils/index.js';
import { debug } from '$shared/utils/logger';
import { parseQwenCredential, resolveQwenBaseUrl } from './credential';
import { getQwenRuntimeDir } from './session-store';

/**
 * Settings Clopen forces on every Qwen CLI run, via the CLI's system-settings
 * tier (highest precedence, so neither ~/.qwen nor a repo's .qwen/ can turn
 * them back on).
 *
 * Managed auto-memory (on by default since the 0.1.17 CLI) runs an extraction
 * agent after every turn and holds the `result` back until it finishes — a
 * minute or more of extra model calls on the user's key, with the chat stuck
 * on "working" the whole time. It also writes memories into the CLI's own
 * store, which no other engine reads; Clopen owns memory for every engine.
 */
const QWEN_SYSTEM_SETTINGS = {
	memory: {
		enableManagedAutoMemory: false,
		enableManagedAutoDream: false,
	},
};

/** Write the forced settings file (only when it changed) and return its path. */
function ensureQwenSystemSettings(): string {
	const file = path.join(getQwenRuntimeDir(), 'clopen-system-settings.json');
	const content = `${JSON.stringify(QWEN_SYSTEM_SETTINGS, null, 2)}\n`;
	try {
		if (fs.readFileSync(file, 'utf-8') === content) return file;
	} catch {
		/* missing — written below */
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

export interface QwenEnvResolution {
	env: Record<string, string>;
	accountName: string;
	preset: string;
	baseUrl: string;
}

/**
 * Build the env dictionary to forward to the Qwen Code subprocess.
 *
 * When `accountId` is provided, that specific account's credential is used;
 * otherwise the active account for the engine is read from the DB.
 *
 * Returns `null` when no account is available or the API key is empty —
 * caller should surface a friendly error rather than spawning the CLI with
 * bad/empty credentials.
 */
export function getEngineEnv(accountId?: number): QwenEnvResolution | null {
	const env = getCleanSpawnEnv();

	let account: EngineAccount | null;
	if (accountId !== undefined) {
		account = engineQueries.getAccount(accountId);
	} else {
		account = engineQueries.getActiveAccountForEngine('qwen');
	}

	if (!account) {
		debug.warn('engine', 'Qwen Code: no active account configured');
		return null;
	}

	const credential = parseQwenCredential(account.credential);
	if (!credential.apiKey) {
		debug.warn('engine', `Qwen Code: account "${account.name}" has no API key`);
		return null;
	}

	const baseUrl = resolveQwenBaseUrl(credential);
	if (!baseUrl) {
		debug.warn('engine', `Qwen Code: account "${account.name}" uses preset "${credential.preset}" but has no base URL configured`);
		return null;
	}

	env['OPENAI_API_KEY'] = credential.apiKey;
	env['OPENAI_BASE_URL'] = baseUrl;
	// Isolate Qwen's runtime output (chats/sessions, history, logs, tmp) to
	// {clopenDir}/engine/qwen/user/ instead of the shared ~/.qwen. Mirrors the path
	// the session store reads from (see ./session-store.ts). The CLI's global
	// settings.json stays in ~/.qwen — there is no env override for it — but
	// Clopen uses paste-token auth so that file is irrelevant here.
	env['QWEN_RUNTIME_DIR'] = getQwenRuntimeDir();
	// Replaces the machine-wide system settings file for these runs only
	// (`/Library/Application Support/QwenCode/settings.json` and friends).
	env['QWEN_CODE_SYSTEM_SETTINGS_PATH'] = ensureQwenSystemSettings();
	// Strip any inherited Qwen OAuth hints — if the host shell exports them
	// the bundled CLI prefers the OAuth path even when API-key env vars are
	// present, surfacing the "OAuth free tier discontinued" error.
	delete env['QWEN_OAUTH_TOKEN'];
	delete env['QWEN_AUTH_TYPE'];

	debug.log('engine', `Qwen Code: using account "${account.name}" (preset ${credential.preset})`);
	return {
		env,
		accountName: account.name,
		preset: credential.preset,
		baseUrl,
	};
}
