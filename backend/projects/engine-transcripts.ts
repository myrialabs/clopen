/**
 * Carry a project's engine chat history to its new folder.
 *
 * Several engines file their transcripts under a directory named after the
 * working directory, so resuming a chat after the project folder moved looks
 * in a directory that does not exist and the chat starts over with no memory.
 * Moving that directory along with the folder is what keeps every existing
 * chat resumable.
 *
 * Only the engines that key by cwd are here. Codex finds a thread by id under
 * its date-sharded `sessions/` tree and takes the cwd from the turn; Copilot,
 * OpenCode and Cline look sessions up by id as well — none of them need moving.
 */

import { existsSync, readdirSync, realpathSync, renameSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { getClaudeUserConfigDir } from '$backend/engine/adapters/claude/environment';
import { getQwenProjectDir } from '$backend/engine/adapters/qwen/session-store';
import { getPiSessionDir } from '$backend/engine/adapters/pi/session-fork';
import { getCursorStoreDir } from '$backend/engine/adapters/cursor/environment';
import { resolveOsPath } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';

/** Claude Code shortens a sanitised cwd past this length and appends a hash we cannot reproduce. */
const CLAUDE_MAX_DIR_NAME = 200;

/**
 * Claude Code's `projects/<sanitised cwd>` directory, or null when the name
 * would be the shortened-and-hashed form.
 */
function claudeProjectDir(cwd: string): string | null {
	const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
	if (name.length > CLAUDE_MAX_DIR_NAME) return null;
	return join(getClaudeUserConfigDir(), 'projects', name);
}

interface TranscriptStore {
	engine: string;
	dirFor: (cwd: string) => string | null;
}

const STORES: TranscriptStore[] = [
	{ engine: 'Claude Code', dirFor: claudeProjectDir },
	{ engine: 'Qwen Code', dirFor: getQwenProjectDir },
	{ engine: 'Pi', dirFor: getPiSessionDir },
	{ engine: 'Cursor', dirFor: getCursorStoreDir }
];

/**
 * The spellings of one folder an engine may have been handed: the stored
 * path, the OS-normalised one adapters pass as cwd, and the one with symlinks
 * in its parent resolved (what a CLI's own `process.cwd()` reports). Each
 * comes as an old/new pair built the same way, so a directory found under one
 * spelling moves to the new folder under that same spelling.
 */
function spellings(oldPath: string, newPath: string): Array<[string, string]> {
	const realParent = (path: string): string => {
		try {
			return join(realpathSync(dirname(path)), basename(path));
		} catch {
			return path;
		}
	};
	const pairs: Array<[string, string]> = [
		[oldPath, newPath],
		[resolveOsPath(oldPath), resolveOsPath(newPath)],
		[realParent(oldPath), realParent(newPath)]
	];
	const unique = new Map<string, string>();
	for (const [from, to] of pairs) if (!unique.has(from)) unique.set(from, to);
	return [...unique];
}

/**
 * Move `from` to `to`. When `to` already exists (the engine already ran in
 * the new folder), entries are moved one by one and a name present on both
 * sides is left where it is — the newer side wins, nothing is overwritten.
 */
function moveDirectory(from: string, to: string): number {
	if (!existsSync(to)) {
		renameSync(from, to);
		return 0;
	}
	let skipped = 0;
	for (const entry of readdirSync(from)) {
		const target = join(to, entry);
		if (existsSync(target)) {
			skipped++;
			continue;
		}
		renameSync(join(from, entry), target);
	}
	return skipped;
}

/**
 * Move every engine's transcripts for `oldPath` to where that engine will
 * look for `newPath`. Returns what could not be carried over, one line each,
 * worded for the person who renamed the project — empty when all moved.
 */
export function moveEngineTranscripts(oldPath: string, newPath: string): string[] {
	const problems: string[] = [];
	for (const store of STORES) {
		for (const [from, to] of spellings(oldPath, newPath)) {
			let source: string | null;
			let target: string | null;
			try {
				source = store.dirFor(from);
				target = store.dirFor(to);
			} catch (error) {
				debug.warn('project', `Could not resolve ${store.engine} transcript directory:`, error);
				continue;
			}
			if (!source) {
				// Only worth saying when there was history under the long form.
				const prefix = claudeProjectDir(from.slice(0, CLAUDE_MAX_DIR_NAME));
				if (prefix && hasSiblingWithPrefix(prefix)) {
					problems.push(`${store.engine} chat history could not be moved: the folder path is too long.`);
				}
				continue;
			}
			if (!target || source === target || !isDirectory(source)) continue;
			try {
				const skipped = moveDirectory(source, target);
				if (skipped > 0) {
					problems.push(`${skipped} ${store.engine} chat file${skipped === 1 ? '' : 's'} already existed for the new folder and were left in place.`);
				}
				debug.log('project', `Moved ${store.engine} transcripts: ${source} -> ${target}`);
			} catch (error) {
				debug.warn('project', `Could not move ${store.engine} transcripts from ${source}:`, error);
				problems.push(`${store.engine} chat history could not be moved, so its earlier chats will start fresh.`);
			}
		}
	}
	return problems;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function hasSiblingWithPrefix(prefixDir: string): boolean {
	try {
		const name = basename(prefixDir);
		return readdirSync(dirname(prefixDir)).some((entry) => entry.startsWith(`${name}-`));
	} catch {
		return false;
	}
}
