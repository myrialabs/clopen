/**
 * Canonical command store — the single source of truth on disk. Every managed
 * command is one Markdown file under `{clopenDir}/commands/<slug>.md` (a
 * `single-md` artifact). The DB (`commands` table) tracks only metadata + the
 * enable toggle; the sync layer mirrors enabled commands into each engine's
 * commands dir (native) or a synthetic preamble.
 */

import { join } from 'path';
import { mkdir, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { getClopenDir } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';

export function getCommandsRootDir(): string {
	return join(getClopenDir(), 'commands');
}

export function getCommandPath(slug: string): string {
	return join(getCommandsRootDir(), `${slug}.md`);
}

async function pathExists(path: string): Promise<boolean> {
	try { await stat(path); return true; } catch { return false; }
}

export function commandFileExists(slug: string): Promise<boolean> {
	return pathExists(getCommandPath(slug));
}

export async function readCommandMd(slug: string): Promise<string | null> {
	const path = getCommandPath(slug);
	if (!(await pathExists(path))) return null;
	return readFile(path, 'utf8');
}

export async function writeCommandMd(slug: string, content: string): Promise<void> {
	await mkdir(getCommandsRootDir(), { recursive: true });
	await writeFile(getCommandPath(slug), content, 'utf8');
	debug.log('commands', `💾 Wrote command ${slug}.md`);
}

export async function deleteCommandMd(slug: string): Promise<void> {
	await rm(getCommandPath(slug), { force: true });
	debug.log('commands', `🗑️ Removed command ${slug}.md`);
}
