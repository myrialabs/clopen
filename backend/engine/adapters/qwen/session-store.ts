/**
 * Qwen Code on-disk session store
 *
 * Forking is native since @qwen-code/sdk 0.1.17 (`resume` + `forkSession`,
 * the CLI's `--fork-session`; see `QwenEngine.streamQuery`). This module
 * only locates chats on disk so the adapter can tell whether a resume target
 * still exists before asking the CLI to fork it — `--fork-session` on a
 * missing source exits the CLI with code 1 instead of starting fresh.
 *
 * On-disk layout (`<QWEN_RUNTIME_DIR>/projects/<sanitized-cwd>/chats/<sessionId>.jsonl`):
 *
 *   - `<sanitized-cwd>` is `cwd.replace(/[^a-zA-Z0-9]/g, '-')` (with a
 *     `toLowerCase()` first on win32). Mirror of `sanitizeCwd()` in the
 *     SDK's bundled CLI (`dist/cli/chunks/`) so we resolve to the same
 *     directory the CLI writes to.
 *   - The `cwd` the CLI sanitizes is its own `process.cwd()`, which the OS
 *     reports with symlinks resolved (`/var/…` → `/private/var/…` on macOS),
 *     so the project path is realpath'd before sanitizing.
 *   - Each chat is a SINGLE JSONL file named after its session id.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getEngineUserConfigDir } from '$backend/utils/paths';

/**
 * Qwen's runtime output base, forwarded to the CLI via `QWEN_RUNTIME_DIR`
 * (see ./environment.ts). The bundled CLI writes chats under
 * `<runtimeBase>/projects/<sanitized-cwd>/chats/` (Storage.getProjectDir →
 * getRuntimeBaseDir), so lookups here must resolve to the SAME base the env
 * var sets or every chat would look missing.
 */
export function getQwenRuntimeDir(): string {
	return getEngineUserConfigDir('qwen');
}

const QWEN_PROJECTS_DIR = path.join(getQwenRuntimeDir(), 'projects');

/**
 * Mirror of `sanitizeCwd` in @qwen-code/sdk's bundled CLI. Lower-case on
 * Windows then collapse every non-alphanumeric character to `-`. Drift from
 * this would point to a different project directory than the one the CLI
 * writes to.
 */
function sanitizeCwd(cwd: string): string {
	const normalized = os.platform() === 'win32' ? cwd.toLowerCase() : cwd;
	return normalized.replace(/[^a-zA-Z0-9]/g, '-');
}

/** The cwd as the spawned CLI sees it: symlinks resolved, input kept if it doesn't exist. */
function resolveCliCwd(projectPath: string): string {
	try {
		return fs.realpathSync(projectPath);
	} catch {
		return projectPath;
	}
}

function getSessionStatePath(projectPath: string, sessionId: string): string {
	return path.join(QWEN_PROJECTS_DIR, sanitizeCwd(resolveCliCwd(projectPath)), 'chats', `${sessionId}.jsonl`);
}

export function sessionStateExists(projectPath: string, sessionId: string): boolean {
	return fs.existsSync(getSessionStatePath(projectPath, sessionId));
}
