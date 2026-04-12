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
