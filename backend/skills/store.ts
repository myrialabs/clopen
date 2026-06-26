/**
 * Canonical skill store — the single source of truth on disk.
 *
 * Every managed skill lives in its own folder under `{clopenDir}/skills/<slug>/`
 * with a `SKILL.md` (and optionally bundled `scripts/`, `references/`,
 * `assets/`). This is engine-agnostic: the `syncSkills` layer mirrors enabled
 * skills from here into each engine's native location (or injects a synthetic
 * preamble) at stream start. The DB (`skills` table) only tracks metadata and
 * the enable/disable toggle.
 */

import { join } from 'path';
import { mkdir, readdir, rm, stat, writeFile, readFile, cp } from 'node:fs/promises';
import { getClopenDir } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';

/** Root of the canonical store: `{clopenDir}/skills`. */
export function getSkillsRootDir(): string {
	return join(getClopenDir(), 'skills');
}

/** Absolute path to a single skill's folder. */
export function getSkillDir(slug: string): string {
	return join(getSkillsRootDir(), slug);
}

/** Absolute path to a skill's SKILL.md. */
export function getSkillMdPath(slug: string): string {
	return join(getSkillDir(slug), 'SKILL.md');
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Whether a skill folder exists on disk. */
export function skillDirExists(slug: string): Promise<boolean> {
	return pathExists(getSkillDir(slug));
}

/** Read a skill's SKILL.md content, or null when the file is absent. */
export async function readSkillMd(slug: string): Promise<string | null> {
	const path = getSkillMdPath(slug);
	if (!(await pathExists(path))) return null;
	return readFile(path, 'utf8');
}

/** Create or overwrite a skill's SKILL.md (creating the folder as needed). */
export async function writeSkillMd(slug: string, content: string): Promise<void> {
	const dir = getSkillDir(slug);
	await mkdir(dir, { recursive: true });
	await writeFile(getSkillMdPath(slug), content, 'utf8');
	debug.log('skills', `💾 Wrote SKILL.md for ${slug}`);
}

/**
 * Write an additional bundled file (e.g. `scripts/run.py`) relative to the
 * skill folder. The relative path is sanitised to stay inside the folder.
 */
export async function writeSkillResource(slug: string, relativePath: string, content: string | Uint8Array): Promise<void> {
	const safeRel = relativePath.replace(/\\/g, '/').replace(/(^|\/)\.\.(\/|$)/g, '/').replace(/^\/+/, '');
	if (!safeRel || safeRel === 'SKILL.md') return;
	const dest = join(getSkillDir(slug), safeRel);
	await mkdir(join(dest, '..'), { recursive: true });
	await writeFile(dest, content);
}

/** Permanently delete a skill folder and everything in it. */
export async function deleteSkillDir(slug: string): Promise<void> {
	await rm(getSkillDir(slug), { recursive: true, force: true });
	debug.log('skills', `🗑️ Removed skill folder ${slug}`);
}

/** List skill folder names that physically exist in the canonical store. */
export async function listSkillSlugsOnDisk(): Promise<string[]> {
	const root = getSkillsRootDir();
	if (!(await pathExists(root))) return [];
	const entries = await readdir(root, { withFileTypes: true });
	return entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
}

/**
 * Copy a skill folder from the canonical store into a destination skills
 * directory (used by the native-engine sync). Removes any stale copy first so
 * renames/edits never leave orphaned files behind.
 */
export async function copySkillInto(slug: string, destSkillsDir: string): Promise<void> {
	const src = getSkillDir(slug);
	if (!(await pathExists(src))) return;
	const dest = join(destSkillsDir, slug);
	await rm(dest, { recursive: true, force: true });
	await mkdir(destSkillsDir, { recursive: true });
	await cp(src, dest, { recursive: true });
}
