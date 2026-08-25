/**
 * Marker-region file editing — the shared primitive for `preamble-region` and
 * `marker-region` ownership. Clopen owns only the delimited block; everything
 * outside it is the user's (or another engine's) hand-written content and is
 * preserved verbatim on every rewrite.
 *
 * Extracted from the original Skills sync so Instructions, synthetic Skills,
 * Commands and Subagents all share one idempotent implementation.
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'path';
import type { ArtifactMarkers } from './types';

/** Build a START/END marker pair for a given managed block id (e.g. `SKILLS`). */
export function markersFor(id: string): ArtifactMarkers {
	return {
		start: `<!-- CLOPEN:${id}:START — managed block, do not edit -->`,
		end: `<!-- CLOPEN:${id}:END -->`
	};
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Strip any existing managed block, returning the surrounding user content trimmed. */
export function stripManagedBlock(existing: string, markers: ArtifactMarkers): string {
	const blockRe = new RegExp(`\\n*${escapeRe(markers.start)}[\\s\\S]*?${escapeRe(markers.end)}\\n*`, 'g');
	return existing.replace(blockRe, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Extract the inner body of the managed block (between the markers), or null. */
export function readManagedBlock(content: string, markers: ArtifactMarkers): string | null {
	const re = new RegExp(`${escapeRe(markers.start)}\\r?\\n?([\\s\\S]*?)\\r?\\n?${escapeRe(markers.end)}`);
	const m = re.exec(content);
	return m ? m[1] : null;
}

/**
 * Rewrite the managed block inside `filePath` idempotently. `block` is the inner
 * content WITHOUT the markers (they are added here); pass an empty string to
 * remove the managed block entirely while keeping the user's content.
 *
 * Returns true when the file changed on disk.
 */
export async function writeManagedBlock(
	filePath: string,
	block: string,
	markers: ArtifactMarkers
): Promise<boolean> {
	const existing = (await pathExists(filePath)) ? await readFile(filePath, 'utf8') : '';
	const base = stripManagedBlock(existing, markers);
	const wrapped = block.trim() ? `${markers.start}\n${block.trim()}\n${markers.end}` : '';
	const next = wrapped
		? base
			? `${base}\n\n${wrapped}\n`
			: `${wrapped}\n`
		: base
			? `${base}\n`
			: '';

	if (next === existing) return false;
	await mkdir(join(filePath, '..'), { recursive: true });
	await writeFile(filePath, next, 'utf8');
	return true;
}
