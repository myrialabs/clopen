import { join, resolve } from 'path';
import { homedir } from 'os';

/**
 * Returns the Clopen data directory.
 * - development: ~/.clopen-dev
 * - everything else (production, undefined): ~/.clopen
 */
export function getClopenDir(): string {
	return join(homedir(), process.env.NODE_ENV === 'development' ? '.clopen-dev' : '.clopen');
}

/**
 * Returns the isolated per-engine config/home directory under
 * `{clopenDir}/engine/{engine}/user/`.
 *
 * Every engine's runtime state (credentials, sessions, logs) is redirected
 * here via that engine's home/config env var (CLAUDE_CONFIG_DIR, CODEX_HOME,
 * COPILOT_HOME, QWEN_RUNTIME_DIR, XDG_* for OpenCode) so Clopen never mixes
 * its data with the user's own global CLI usage (~/.codex, ~/.copilot, …).
 *
 * Grouped under an `engine/` parent so all AI-engine state sits in one place,
 * separate from Clopen's other data dirs (snapshots, etc.).
 */
export function getEngineUserConfigDir(engine: string): string {
	return join(getClopenDir(), 'engine', engine, 'user');
}

/**
 * Resolve a path to an OS-native absolute path.
 * On Windows: resolves relative paths, prepends drive letter, converts to backslashes.
 * On POSIX: returns path as-is (already absolute from OS perspective).
 */
export function resolveOsPath(projectPath: string): string {
	let resolved = projectPath;
	if (process.platform === 'win32') {
		if (!projectPath.match(/^[A-Za-z]:\\/)) {
			if (projectPath.startsWith('\\')) {
				const currentDrive = process.cwd().substring(0, 2);
				resolved = currentDrive + projectPath;
			} else {
				resolved = resolve(projectPath);
			}
		}
		resolved = resolved.replace(/\//g, '\\');
	}
	return resolved;
}
