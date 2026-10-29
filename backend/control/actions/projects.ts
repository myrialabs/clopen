/**
 * Projects: list, open, Home, and adding one by walking the machine's
 * folders (making, renaming or deleting folders on the way).
 */

import { t } from 'elysia';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path';
import { homedir } from 'os';
import { projectQueries } from '$backend/database/queries';
import { ensureHomeProject } from '$backend/projects/home';
import { homeFirst, isHomeProject, HOME_PROJECT_NAME } from '$shared/utils/home-project';
import type { Project } from '$shared/types/database/schema';
import { defineAction } from '../define';
import type { ControlChoice, ControlResult } from '../types';
import { isPathInside } from '$backend/worktrees';
import { getClopenDir } from '$backend/utils/paths';
import { latestSession, projectLabel } from '../workspace';
import { paged } from '../paging';


export const listProjects = defineAction({
	id: 'projects.list',
	group: 'projects',
	title: 'Projects',
	description: 'Switch project',
	args: t.Object({ page: t.Optional(t.Number({ minimum: 0 })) }),
	command: { name: 'projects' },
	async run(ctx, args) {
		ensureHomeProject();
		const projects = homeFirst(
			projectQueries.getListed().sort((a, b) => (b.last_opened_at ?? '').localeCompare(a.last_opened_at ?? ''))
		);
		const { choices, range } = paged(
			projects,
			args.page,
			(project) => ({
				label: projectLabel(project),
				detail: isHomeProject(project) ? 'no project, just chat' : project.path,
				current: project.id === ctx.target.projectId,
				action: 'projects.open',
				args: { projectId: project.id }
			}),
			{ action: 'projects.list' }
		);
		return { text: `**📁 Pick a project**${range}`, choices };
	}
});

export const openProject = defineAction({
	id: 'projects.open',
	group: 'projects',
	title: 'Open project',
	description: 'Switch to a project; the next message continues its latest session.',
	args: t.Object({ projectId: t.String({ minLength: 1 }) }),
	async run(_ctx, args) {
		const project = projectQueries.getById(args.projectId);
		if (!project || !projectQueries.isListed(project.id)) throw new Error('That project is not in Clopen any more.');
		projectQueries.updateLastOpened(project.id);
		return {
			text: `📁 Now in **${escapeMd(projectLabel(project))}**. Your next message continues its latest session, or /new starts a fresh one.`,
			target: { projectId: project.id, sessionId: latestSession(project.id)?.id ?? null }
		};
	}
});

export const goHome = defineAction({
	id: 'projects.home',
	group: 'projects',
	title: 'Home',
	description: 'Chat without a project',
	args: t.Object({}),
	command: { name: 'home' },
	async run() {
		const home = ensureHomeProject();
		return {
			text: `🏠 Now in **${HOME_PROJECT_NAME}**, with no project.`,
			target: { projectId: home.id, sessionId: latestSession(home.id)?.id ?? null }
		};
	}
});

/** `~/code/app` and relative paths resolve against the server user's home. */
function normalisePath(input: string): string {
	const trimmed = input.trim().replace(/^["']|["']$/g, '');
	const expanded = trimmed === '~' ? homedir() : trimmed.startsWith('~/') ? resolve(homedir(), trimmed.slice(2)) : trimmed;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(homedir(), expanded);
}

/** How a folder reads in a chat: `~/code/app` rather than the full home path. */
function shortPath(path: string): string {
	const home = homedir();
	return path === home ? '~' : path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

/** Folders not worth walking into when looking for a project. */
const SKIPPED_FOLDERS = new Set(['node_modules', 'Library', 'Applications', 'AppData']);

/**
 * Why a folder must not be renamed or deleted from a chat, or null when it
 * may. The home folder and everything above it, Clopen's own data, and any
 * folder that is (or holds) a project are off limits: a project whose folder
 * moved or vanished is broken in Clopen for everyone who has it.
 */
function protectedReason(folder: string): string | null {
	if (folder === resolve(sep) || isPathInside(folder, homedir())) return 'it is your home folder or one above it';
	const data = getClopenDir();
	if (isPathInside(data, folder) || isPathInside(folder, data)) return "it holds Clopen's own data";
	const project = projectQueries.getAll().find((entry) => isPathInside(folder, resolve(entry.path)));
	if (project) return `it ${resolve(project.path) === folder ? 'is' : 'holds'} the project ${isHomeProject(project) ? HOME_PROJECT_NAME : project.name}`;
	return null;
}

/** A folder name typed in a chat: one path segment, nothing that climbs out. */
function folderName(input: string | undefined): string {
	const name = (input ?? '').trim();
	if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name) || name.length > 255) {
		throw new Error('That is not a folder name. Use a single name, without slashes.');
	}
	return name;
}

function existingFolder(path: string): string {
	const folder = normalisePath(path);
	if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`There is no folder at ${shortPath(folder)}.`);
	return folder;
}

/** One folder as a menu: add or open it, move around, and manage its folders. */
function browse(folder: string, page: number | undefined, note?: string): ControlResult {
	let entries: string[] = [];
	try {
		entries = readdirSync(folder, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_FOLDERS.has(entry.name))
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		throw new Error(`Clopen cannot read ${shortPath(folder)}.`);
	}
	const existing = projectQueries.getAll().find((project) => resolve(project.path) === folder);
	const { choices, range } = paged(
		entries,
		page,
		(name) => ({ label: `📁 ${name}`, action: 'projects.browse', args: { path: join(folder, name) } }),
		{ action: 'projects.browse', args: { path: folder } }
	);
	const parent = dirname(folder);
	const locked = protectedReason(folder) !== null;
	const top: ControlChoice[] = [
		existing
			? { label: `📂 Open ${existing.name}`, action: 'projects.open', args: { projectId: existing.id } }
			: { label: `✅ Add ${basename(folder) || folder} as a project`, action: 'projects.create', args: { path: folder } },
		...(parent !== folder ? [{ label: '⬆️ Up', action: 'projects.browse', args: { path: parent } }] : []),
		{ label: '➕ New folder here', action: 'projects.mkdir', args: { path: folder } },
		...(locked
			? []
			: [
					{ label: '✏️ Rename this folder', action: 'projects.rename-folder', args: { path: folder } },
					{ label: '🗑️ Delete this folder', action: 'projects.delete-folder', args: { path: folder } }
				])
	];
	const lines = [
		...(note ? [note] : []),
		`**📂 \`${shortPath(folder)}\`**${range}`,
		existing ? '_Already a project._' : entries.length ? '_Tap a folder to go into it._' : '_No folders inside._'
	];
	return { text: lines.join('\n'), choices: [...top, ...choices] };
}

/**
 * Adding a project from a phone means finding a folder without typing its
 * path: walk the machine's folders with buttons, starting at the home folder
 * (or at the one named), make, rename or delete folders on the way, and add
 * the one you are in.
 */
export const browseFolders = defineAction({
	id: 'projects.browse',
	group: 'projects',
	title: 'Add project',
	description: 'Add a folder as a project',
	args: t.Object({ path: t.Optional(t.String()), page: t.Optional(t.Number({ minimum: 0 })) }),
	command: { name: 'newproject', argument: { keys: ['path'], hint: '[start folder]' } },
	async run(_ctx, args) {
		return browse(existingFolder(args.path?.trim() || '~'), args.page);
	}
});

export const makeFolder = defineAction({
	id: 'projects.mkdir',
	group: 'projects',
	title: 'New folder',
	description: 'Create a folder inside another.',
	args: t.Object({ path: t.String({ minLength: 1 }), name: t.Optional(t.String()) }),
	async run(_ctx, args) {
		const parent = existingFolder(args.path);
		if (args.name === undefined) {
			return { text: `📂 \`${shortPath(parent)}\``, ask: { question: 'Name of the new folder?', action: 'projects.mkdir', args: { path: parent }, key: 'name' } };
		}
		const folder = join(parent, folderName(args.name));
		if (existsSync(folder)) throw new Error(`${shortPath(folder)} already exists.`);
		mkdirSync(folder);
		return browse(folder, 0, `✅ Created \`${shortPath(folder)}\`.`);
	}
});

export const renameFolder = defineAction({
	id: 'projects.rename-folder',
	group: 'projects',
	title: 'Rename folder',
	description: 'Rename a folder that is not a project.',
	args: t.Object({ path: t.String({ minLength: 1 }), name: t.Optional(t.String()) }),
	async run(_ctx, args) {
		const folder = existingFolder(args.path);
		const reason = protectedReason(folder);
		if (reason) throw new Error(`${shortPath(folder)} cannot be renamed here: ${reason}.`);
		if (args.name === undefined) {
			return { text: `📂 \`${shortPath(folder)}\``, ask: { question: `New name for ${basename(folder)}?`, action: 'projects.rename-folder', args: { path: folder }, key: 'name' } };
		}
		const renamed = join(dirname(folder), folderName(args.name));
		if (renamed === folder) return browse(folder, 0);
		if (existsSync(renamed)) throw new Error(`${shortPath(renamed)} already exists.`);
		renameSync(folder, renamed);
		return browse(renamed, 0, `✏️ Renamed to \`${shortPath(renamed)}\`.`);
	}
});

export const deleteFolder = defineAction({
	id: 'projects.delete-folder',
	group: 'projects',
	title: 'Delete folder',
	description: 'Delete a folder that is not a project, with everything in it.',
	args: t.Object({ path: t.String({ minLength: 1 }) }),
	confirm(args) {
		const folder = normalisePath(args.path);
		let count = 0;
		try {
			count = readdirSync(folder).length;
		} catch {
			// Unreadable: the run says why.
		}
		return `Delete ${shortPath(folder)}${count ? ` and the ${count} item${count === 1 ? '' : 's'} in it` : ''}? This cannot be undone.`;
	},
	async run(_ctx, args) {
		const folder = existingFolder(args.path);
		const reason = protectedReason(folder);
		if (reason) throw new Error(`${shortPath(folder)} cannot be deleted here: ${reason}.`);
		rmSync(folder, { recursive: true, force: true });
		return browse(dirname(folder), 0, `🗑️ Deleted \`${shortPath(folder)}\`.`);
	}
});

export const createProject = defineAction({
	id: 'projects.create',
	group: 'projects',
	title: 'Add project',
	description: 'Add a folder on this machine as a project, and switch to it.',
	args: t.Object({ path: t.String({ minLength: 1 }), name: t.Optional(t.String()) }),
	async run(ctx, args) {
		const path = normalisePath(args.path);
		if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`There is no folder at ${shortPath(path)}.`);
		const project = await ctx.call<Project>('projects:create', { name: args.name?.trim() || basename(path), path });
		return {
			text: `📁 Added and opened **${escapeMd(project.name)}** (\`${shortPath(path)}\`).`,
			target: { projectId: project.id, sessionId: latestSession(project.id)?.id ?? null }
		};
	}
});

/** Names are user data: keep `*`, `_` and friends literal inside Markdown. */
export function escapeMd(value: string): string {
	return value.replace(/([\\`*_~[\]])/g, '\\$1');
}
