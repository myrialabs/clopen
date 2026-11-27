/**
 * Files, folders and lines of a file.
 *
 * A file is mentioned by reference — the engine reads the file itself, so it
 * sees the current version. A folder is a listing of what is in it. Typing a
 * path with lines (`@src/app.ts:10-24`) mentions those lines as they are now.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, relative, resolve, sep, basename, dirname } from 'path';
import type { MentionCandidate } from '$shared/types/mentions';
import { buildContextDocument, countLines, fileReferenceDocument } from '$shared/utils/context-document';
import { SKIP_DIRS } from '$backend/ws/files/search';
import { gitText, rank, wants } from '../shared';
import { refOptional, refString, type MentionContext, type MentionSource } from '../types';

const CATEGORY = 'files';

/** How long a workspace's file list is reused between keystrokes. */
const LIST_TTL_MS = 5000;
/** A walk stops here; the picker only ever shows a handful. */
const MAX_FILES = 50_000;
/** A folder listing stops here. */
const MAX_LISTING = 2000;
/** Lines asked for beyond this are cut. */
const MAX_RANGE_LINES = 5000;

const cache = new Map<string, { at: number; files: Promise<string[]> }>();

/** Every file of a workspace, relative and `/`-separated: git's view when there is one. */
function workspaceFiles(root: string): Promise<string[]> {
	const hit = cache.get(root);
	if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.files;
	const files = (async () => {
		const listed = await gitText(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root, 10_000);
		if (listed !== null) return listed.split('\0').filter(Boolean).slice(0, MAX_FILES);
		const found: string[] = [];
		await walk(root, root, found, 0);
		return found;
	})();
	cache.set(root, { at: Date.now(), files });
	return files;
}

async function walk(root: string, dir: string, out: string[], depth: number): Promise<void> {
	if (depth > 12 || out.length >= MAX_FILES) return;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (out.length >= MAX_FILES) return;
		if (SKIP_DIRS.has(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
		else if (entry.isDirectory()) await walk(root, full, out, depth + 1);
	}
}

/** The folders the files live in. */
function foldersOf(files: string[]): string[] {
	const folders = new Set<string>();
	for (const file of files) {
		let dir = dirname(file);
		while (dir && dir !== '.' && !folders.has(dir)) {
			folders.add(dir);
			dir = dirname(dir);
		}
	}
	return [...folders];
}

/** A path inside the workspace, or an error. */
function insideRoot(root: string, path: string): string {
	const absolute = resolve(root, path);
	const base = resolve(root);
	if (absolute !== base && !absolute.startsWith(base + sep)) throw new Error('That path is outside the project');
	return absolute;
}

/** `src/app.ts:10-24` → the path and its lines. */
function parseRange(query: string): { path: string; start: number; end: number } | null {
	const match = /^(.+?):(\d+)(?:-(\d+))?$/.exec(query.trim());
	if (!match) return null;
	const start = Number(match[2]);
	const end = match[3] ? Number(match[3]) : start;
	if (start < 1 || end < start) return null;
	return { path: match[1], start, end };
}

function fileRow(path: string): MentionCandidate {
	return {
		key: `file:${path}`,
		kind: 'file',
		group: 'Files',
		label: basename(path),
		detail: dirname(path) === '.' ? 'Project root' : dirname(path),
		icon: 'lucide:file-code',
		ref: { path }
	};
}

function folderRow(path: string): MentionCandidate {
	return {
		key: `folder:${path}`,
		kind: 'folder',
		group: 'Folders',
		label: `${basename(path)}/`,
		detail: dirname(path) === '.' ? 'Project root' : dirname(path),
		icon: 'lucide:folder',
		ref: { path }
	};
}

export const filesSource: MentionSource = {
	kinds: ['file', 'folder', 'code'],

	categories: () => [{ id: CATEGORY, label: 'Files & folders', detail: 'By name or path; add :10-20 for lines', icon: 'lucide:file-code', group: 'Workspace' }],

	async list(ctx: MentionContext, request) {
		const mode = wants(request.category, CATEGORY);
		if (!mode) return [];
		// At the root a file only shows up once something is typed: listing the
		// whole tree under an empty `@` would bury everything else.
		if (mode === 'root' && !request.query.trim()) return [];

		const files = await workspaceFiles(ctx.root);
		const rows: MentionCandidate[] = [];

		const range = parseRange(request.query);
		if (range) {
			const exact = files.find((file) => file === range.path) ?? rank(files, range.path, (file) => [file], 1)[0];
			if (exact) {
				rows.push({
					key: `code:${exact}:${range.start}-${range.end}`,
					kind: 'code',
					group: 'Files',
					label: `${basename(exact)}:${range.start}${range.end !== range.start ? `-${range.end}` : ''}`,
					detail: `Lines ${range.start}–${range.end} of ${exact}`,
					icon: 'lucide:text-select',
					ref: { path: exact, start: range.start, end: range.end }
				});
			}
		}

		const query = range ? range.path : request.query;
		if (mode === 'root') {
			rows.push(
				...rank(files, query, (file) => [basename(file), file], 6).map(fileRow),
				...rank(foldersOf(files), query, (folder) => [basename(folder), folder], 2).map(folderRow)
			);
			return rows;
		}
		// Ranked together, so a folder that matches best is not pushed past the
		// end of the list by every file inside it.
		const entries = [
			...foldersOf(files).map((path) => ({ path, folder: true })),
			...files.map((path) => ({ path, folder: false }))
		];
		// Browsing with nothing typed reads like a file tree: the top level
		// first, folders before files, alphabetical within each.
		if (!query.trim()) {
			const depth = (path: string) => path.split('/').length;
			entries.sort((a, b) => depth(a.path) - depth(b.path) || Number(b.folder) - Number(a.folder) || a.path.localeCompare(b.path));
		}
		const matched = rank(entries, query, (entry) => [basename(entry.path), entry.path], request.limit - rows.length);
		rows.push(...matched.map((entry) => (entry.folder ? folderRow(entry.path) : fileRow(entry.path))));
		return rows;
	},

	async capture(ctx, kind, ref) {
		const path = refString(ref, 'path');
		const absolute = insideRoot(ctx.root, path);
		const display = relative(ctx.root, absolute).split(sep).join('/');

		if (kind === 'file') {
			const info = await stat(absolute);
			if (!info.isFile()) throw new Error(`${display} is not a file`);
			return { documents: [fileReferenceDocument(display)] };
		}

		if (kind === 'folder') {
			const files = (await workspaceFiles(ctx.root)).filter((file) => file.startsWith(`${display}/`));
			const shown = files.slice(0, MAX_LISTING).map((file) => file.slice(display.length + 1));
			let listing = shown.join('\n');
			if (files.length === 0) {
				// Not tracked by git (or empty): list what is on disk, one level.
				const entries = await readdir(absolute, { withFileTypes: true });
				listing = entries.map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`).join('\n');
			}
			return {
				documents: [
					buildContextDocument({
						kind: 'folder',
						label: `${display}/`,
						detail: `${files.length.toLocaleString('en-US')} files`,
						facts: [
							['Path', `${display}/`],
							...(files.length > MAX_LISTING ? [['Shown', `first ${MAX_LISTING} of ${files.length}`] as [string, string]] : [])
						],
						sections: [{ title: 'Contents', body: listing, fence: '' }]
					})
				]
			};
		}

		// Lines of a file, as they are on disk now.
		const start = Math.max(1, Number(ref.start) || 1);
		const end = Math.max(start, Math.min(Number(ref.end) || start, start + MAX_RANGE_LINES - 1));
		const text = await readFile(absolute, 'utf8');
		const lines = text.split(/\r?\n/).slice(start - 1, end);
		const language = refOptional(ref, 'language') ?? languageOf(display);
		return {
			documents: [
				buildContextDocument({
					kind: 'code',
					label: `${display}:${start}${end !== start ? `-${end}` : ''}`,
					detail: countLines(lines.join('\n')),
					facts: [['File', display], ['Lines', `${start}–${start + lines.length - 1}`]],
					sections: [{ body: lines.join('\n'), fence: language }]
				})
			]
		};
	}
};

/** A fence language from a file name; empty when unsure. */
export function languageOf(path: string): string {
	const extension = path.split('.').pop()?.toLowerCase() ?? '';
	const known: Record<string, string> = {
		ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', svelte: 'svelte', vue: 'vue',
		py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
		c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', zsh: 'bash',
		json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', md: 'markdown', html: 'html',
		css: 'css', scss: 'scss', sql: 'sql', xml: 'xml', dart: 'dart', lua: 'lua'
	};
	return known[extension] ?? '';
}
