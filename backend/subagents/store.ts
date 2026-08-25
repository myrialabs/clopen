/**
 * Canonical subagent store — one Markdown file per subagent under
 * `{clopenDir}/subagents/<slug>.md` (a `single-md` artifact). The DB tracks
 * metadata + the enable toggle; the sync layer mirrors enabled subagents into
 * each engine's agents dir (native) or a synthetic preamble.
 */

import { join } from 'path';
import { mkdir, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { getClopenDir } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';

export function getSubagentsRootDir(): string {
	return join(getClopenDir(), 'subagents');
}

export function getSubagentPath(slug: string): string {
	return join(getSubagentsRootDir(), `${slug}.md`);
}

async function pathExists(path: string): Promise<boolean> {
	try { await stat(path); return true; } catch { return false; }
}

export function subagentFileExists(slug: string): Promise<boolean> {
	return pathExists(getSubagentPath(slug));
}

export async function readSubagentMd(slug: string): Promise<string | null> {
	const path = getSubagentPath(slug);
	if (!(await pathExists(path))) return null;
	return readFile(path, 'utf8');
}

export async function writeSubagentMd(slug: string, content: string): Promise<void> {
	await mkdir(getSubagentsRootDir(), { recursive: true });
	await writeFile(getSubagentPath(slug), content, 'utf8');
	debug.log('subagents', `💾 Wrote subagent ${slug}.md`);
}

export async function deleteSubagentMd(slug: string): Promise<void> {
	await rm(getSubagentPath(slug), { force: true });
	debug.log('subagents', `🗑️ Removed subagent ${slug}.md`);
}
