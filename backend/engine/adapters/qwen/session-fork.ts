/**
 * Qwen Code Session Fork (workaround)
 *
 * The Qwen Code SDK / CLI does not yet expose a native fork primitive. To
 * support Clopen's multi-branch checkpoints feature — which lets the user
 * replay an earlier point in the conversation as a sibling branch — we
 * copy the on-disk chat file to a fresh session id and patch the embedded
 * id references.
 *
 * On-disk layout (`~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl`):
 *
 *   - `<sanitized-cwd>` is `cwd.replace(/[^a-zA-Z0-9]/g, '-')` (with a
 *     `toLowerCase()` first on win32). Mirror of the SDK's `sanitizeCwd()`
 *     in `node_modules/@qwen-code/sdk/dist/cli/cli.js` so we resolve to the
 *     same directory the bundled CLI writes to.
 *   - Each chat is a SINGLE JSONL file. Every record carries a
 *     `sessionId` field equal to the file's basename (without `.jsonl`).
 *     Per-record `uuid` / `parentUuid` reference the previous record's
 *     `uuid` and are unrelated to the session id, so a blanket replace
 *     of the source session id is safe.
 *
 * After copy + patch, `query({ ..., resume: <forkId> })` makes the bundled
 * CLI pick the new file up as a resumed session whose id is `forkId`. The
 * source file is left untouched so the original branch's history stays
 * replayable.
 *
 * TODO: when @qwen-code/sdk gains a native `forkSession()` (or an
 * equivalent flag the CLI honours, e.g. `--resume <id> --fork`), delete
 * this helper and switch `QwenEngine.streamQuery` to use the SDK API
 * directly. The migration is one line — same shape as Claude
 * (`forkSession: true`) and OpenCode (`client.session.fork()`).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { debug } from '$shared/utils/logger';

const QWEN_PROJECTS_DIR = path.join(os.homedir(), '.qwen', 'projects');

/**
 * Mirror of `sanitizeCwd` in @qwen-code/sdk's bundled CLI
 * (cli.js::sanitizeCwd). Lower-case on Windows then collapse every
 * non-alphanumeric character to `-`. Drift from this would point to a
 * different project directory and the fork would land in a directory the
 * CLI never reads.
 */
function sanitizeCwd(cwd: string): string {
	const normalized = os.platform() === 'win32' ? cwd.toLowerCase() : cwd;
	return normalized.replace(/[^a-zA-Z0-9]/g, '-');
}

function getChatsDir(projectPath: string): string {
	return path.join(QWEN_PROJECTS_DIR, sanitizeCwd(projectPath), 'chats');
}

export function getSessionStatePath(projectPath: string, sessionId: string): string {
	return path.join(getChatsDir(projectPath), `${sessionId}.jsonl`);
}

export function sessionStateExists(projectPath: string, sessionId: string): boolean {
	return fs.existsSync(getSessionStatePath(projectPath, sessionId));
}

/**
 * Copy `sourceSessionId`'s chat file to a new file keyed by
 * `forkSessionId` (in the same project's `chats/` directory) and patch
 * the embedded session ids. Returns true on success, false if the source
 * file is missing (caller falls back to a fresh chat).
 *
 * The destination is removed first if it already exists so a re-fork
 * from the same source produces a clean copy.
 */
export function forkQwenSessionState(
	projectPath: string,
	sourceSessionId: string,
	forkSessionId: string,
): boolean {
	const srcPath = getSessionStatePath(projectPath, sourceSessionId);
	if (!fs.existsSync(srcPath)) {
		debug.warn('engine', `Qwen fork: source chat ${sourceSessionId} not found at ${srcPath}`);
		return false;
	}

	const dstPath = getSessionStatePath(projectPath, forkSessionId);
	fs.mkdirSync(path.dirname(dstPath), { recursive: true });
	if (fs.existsSync(dstPath)) {
		fs.rmSync(dstPath, { force: true });
	}

	const content = fs.readFileSync(srcPath, 'utf-8');
	const patched = content.split(sourceSessionId).join(forkSessionId);
	fs.writeFileSync(dstPath, patched);

	debug.log('engine', `Qwen fork: ${sourceSessionId} → ${forkSessionId}`);
	return true;
}
