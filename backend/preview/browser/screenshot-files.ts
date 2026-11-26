/**
 * Saving preview screenshots into the workspace.
 *
 * Saving into the tree a repository tracks has one real hazard: the image
 * gets committed by accident along with the work it was meant to illustrate.
 * So every save reports whether git would pick the file up, and the folder can
 * be added to `.gitignore` in one step — the choice stays the user's, but it
 * is never made without them knowing.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { execGit } from '$backend/git/git-executor';

export const DEFAULT_SCREENSHOT_FOLDER = 'screenshots';

/** Whether git would pick a path up: ignored, not ignored, or no repository at all. */
export type GitIgnoreState = 'ignored' | 'not-ignored' | 'no-repo';

/**
 * A folder the user typed, as a clean path relative to the workspace.
 *
 * Lexical on purpose: the folder is meant to live in the workspace, so
 * anything climbing out of it, or pointing elsewhere outright, is a typo to
 * report rather than a destination to honour.
 */
export function normalizeScreenshotFolder(folder: string | undefined): string {
	const trimmed = (folder ?? '').trim().replace(/\\/g, '/');
	if (!trimmed) return DEFAULT_SCREENSHOT_FOLDER;
	if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) {
		throw new Error('The folder must be inside the project');
	}

	const segments = trimmed.split('/').filter((segment) => segment && segment !== '.');
	if (segments.some((segment) => segment === '..')) throw new Error('The folder must be inside the project');
	if (segments.length === 0) return DEFAULT_SCREENSHOT_FOLDER;
	if (segments[0] === '.git') throw new Error('Screenshots cannot be saved inside .git');

	return segments.join('/');
}

/** A file name with nothing in it that a filesystem would refuse or read as a path. */
export function sanitizeScreenshotFileName(fileName: string, extension: 'png' | 'jpg'): string {
	const stem = fileName
		.replace(/\.(png|jpe?g)$/i, '')
		.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-')
		.replace(/^[.\s-]+|[.\s]+$/g, '')
		.slice(0, 120);
	return `${stem || 'screenshot'}.${extension}`;
}

/** `name.png`, or `name-2.png` and so on when that is taken — a save never overwrites. */
export function uniqueFileName(directory: string, fileName: string): string {
	if (!existsSync(join(directory, fileName))) return fileName;

	const dot = fileName.lastIndexOf('.');
	const stem = fileName.slice(0, dot);
	const extension = fileName.slice(dot);
	for (let index = 2; index < 1000; index++) {
		const candidate = `${stem}-${index}${extension}`;
		if (!existsSync(join(directory, candidate))) return candidate;
	}
	throw new Error('Too many screenshots with that name in the folder');
}

/** Whether git would track `path`, asked of git itself so every ignore source counts. */
export async function gitIgnoreState(root: string, path: string): Promise<GitIgnoreState> {
	const result = await execGit(['check-ignore', '-q', '--', relative(root, path).split(sep).join('/')], root, {
		timeout: 10_000,
		okExitCodes: [1, 128]
	});
	if (result.exitCode === 0) return 'ignored';
	if (result.exitCode === 1) return 'not-ignored';
	return 'no-repo';
}

export interface SavedScreenshot {
	/** Relative to the workspace root, with forward slashes. */
	path: string;
	folder: string;
	git: GitIgnoreState;
}

export async function saveScreenshotFile(
	root: string,
	folder: string | undefined,
	fileName: string,
	data: Uint8Array,
	extension: 'png' | 'jpg'
): Promise<SavedScreenshot> {
	const cleanFolder = normalizeScreenshotFolder(folder);
	const directory = join(root, ...cleanFolder.split('/'));
	await mkdir(directory, { recursive: true });

	const name = uniqueFileName(directory, sanitizeScreenshotFileName(fileName, extension));
	const absolute = join(directory, name);
	await writeFile(absolute, data);

	return {
		path: `${cleanFolder}/${name}`,
		folder: cleanFolder,
		git: await gitIgnoreState(root, absolute)
	};
}

/**
 * The `.gitignore` after adding a folder to it, or null when a line already
 * covers it. Anchored to the root so a same-named folder deeper in the tree
 * is left alone.
 */
export function withIgnoredFolder(current: string, folder: string): string | null {
	const entry = `/${folder}/`;
	const lines = current.split(/\r?\n/).map((line) => line.trim());
	if (lines.some((line) => line === entry || line === `/${folder}` || line === `${folder}/` || line === folder)) {
		return null;
	}

	const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
	return `${current}${separator}${entry}\n`;
}

/** Add a screenshot folder to the workspace's `.gitignore`, creating it when there is none. */
export async function ignoreScreenshotFolder(root: string, folder: string | undefined): Promise<GitIgnoreState> {
	const cleanFolder = normalizeScreenshotFolder(folder);
	const gitignorePath = join(root, '.gitignore');
	const current = existsSync(gitignorePath) ? await readFile(gitignorePath, 'utf8') : '';
	const next = withIgnoredFolder(current, cleanFolder);
	if (next !== null) await writeFile(gitignorePath, next);

	// Re-asked rather than assumed: a negation further down, or a global rule,
	// can still decide otherwise, and the UI has to show what git will do.
	return gitIgnoreState(root, join(root, ...cleanFolder.split('/'), '.probe'));
}
