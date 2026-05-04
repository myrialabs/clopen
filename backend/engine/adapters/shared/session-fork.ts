/**
 * Shared Session Fork Primitives
 *
 * Common building blocks for the per-engine session-fork workarounds.
 * Each engine adapter (Copilot, Codex, Qwen) has its own session-fork.ts
 * that uses these primitives to implement engine-specific fork logic while
 * avoiding code duplication for the shared copy-patch-return pattern.
 *
 * TODO: When all three SDKs gain native forkSession() APIs, this file
 * and the per-engine session-fork.ts files can be deleted entirely.
 */

import fs from 'node:fs';
import path from 'node:path';
import { debug } from '$shared/utils/logger';

/**
 * Copy a source directory to a destination, removing the destination first
 * if it already exists. Returns false if the source directory is missing.
 */
export function copyDirectory(srcDir: string, dstDir: string): boolean {
	if (!fs.existsSync(srcDir)) return false;

	if (fs.existsSync(dstDir)) {
		fs.rmSync(dstDir, { recursive: true, force: true });
	}

	fs.cpSync(srcDir, dstDir, { recursive: true });
	return true;
}

/**
 * Copy a source file to a destination, creating parent directories and
 * removing the destination first if it already exists. Returns false if
 * the source file is missing.
 */
export function copyFile(srcPath: string, dstPath: string): boolean {
	if (!fs.existsSync(srcPath)) return false;

	fs.mkdirSync(path.dirname(dstPath), { recursive: true });

	if (fs.existsSync(dstPath)) {
		fs.rmSync(dstPath, { force: true });
	}

	fs.writeFileSync(dstPath, fs.readFileSync(srcPath));
	return true;
}

/**
 * Replace all occurrences of `oldId` with `newId` in a file's content.
 * Used by Codex and Qwen where a blanket string replace on UUIDs is safe.
 */
export function patchFileContent(filePath: string, oldId: string, newId: string): void {
	if (!fs.existsSync(filePath)) return;
	const content = fs.readFileSync(filePath, 'utf-8');
	const patched = content.split(oldId).join(newId);
	fs.writeFileSync(filePath, patched);
}

/**
 * Replace the first regex match in a file. Used by Copilot for
 * targeted YAML field replacement (safer than blanket replace on YAML).
 */
export function patchFileRegex(filePath: string, pattern: RegExp, replacement: string): void {
	if (!fs.existsSync(filePath)) return;
	const original = fs.readFileSync(filePath, 'utf-8');
	const patched = original.replace(pattern, replacement);
	fs.writeFileSync(filePath, patched);
}

/**
 * Rewrite the first line of a JSONL file by parsing it as JSON, applying
 * a mutation callback, and writing it back. Used by Copilot for patching
 * the `session.start` event's `data.sessionId`.
 */
export function patchJsonlFirstLine(
	filePath: string,
	mutator: (parsed: Record<string, unknown>) => void,
	logLabel: string,
): void {
	if (!fs.existsSync(filePath)) return;

	const raw = fs.readFileSync(filePath, 'utf-8');
	const newlineIdx = raw.indexOf('\n');
	const firstLine = newlineIdx === -1 ? raw : raw.slice(0, newlineIdx);
	const rest = newlineIdx === -1 ? '' : raw.slice(newlineIdx);

	try {
		const parsed = JSON.parse(firstLine) as Record<string, unknown>;
		mutator(parsed);
		fs.writeFileSync(filePath, JSON.stringify(parsed) + rest);
	} catch (err) {
		debug.warn('engine', `${logLabel}: failed to patch JSONL first line (non-fatal):`, err);
	}
}

/**
 * Log a fork result and return the boolean. Centralises the debug.log
 * call so each adapter's fork function ends with a one-liner.
 */
export function logForkResult(engine: string, sourceId: string, forkId: string, success: boolean): boolean {
	if (success) {
		debug.log('engine', `${engine} fork: ${sourceId} → ${forkId}`);
	} else {
		debug.warn('engine', `${engine} fork: source ${sourceId} not found on disk`);
	}
	return success;
}
