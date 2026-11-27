/**
 * Projects: list, open, Home, rename, and adding one by walking the
 * machine's folders (making, renaming or deleting folders on the way).
 */

import { t } from 'elysia';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path';
import { homedir } from 'os';
import { projectQueries } from '$backend/database/queries';
import { ensureHomeProject } from '$backend/projects/home';
import { projectAtFolder, protectedFolderReason, validFolderName } from '$backend/projects/folder-guard';
import type { MoveOutcome } from '$backend/projects/move';
import { getProjectUsage } from '$backend/projects/move';
import { homeFirst, isHomeProject, HOME_PROJECT_NAME } from '$shared/utils/home-project';
import type { Project } from '$shared/types/database/schema';
import { defineAction } from '../define';
import type { ControlChoice, ControlResult } from '../types';
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
	const existing = projectAtFolder(folder);
	const { choices, range } = paged(
		entries,
		page,
		(name) => ({ label: `📁 ${name}`, action: 'projects.browse', args: { path: join(folder, name) } }),
		{ action: 'projects.browse', args: { path: folder } }
	);
	const parent = dirname(folder);
	const locked = protectedFolderReason(folder) !== null;
	// A project's own folder is renamed with the project, so it stays a project.
	const renamable = existing && !isHomeProject(existing) && protectedFolderReason(folder, existing.id) === null;
	const top: ControlChoice[] = [
		existing
			? { label: `📂 Open ${existing.name}`, action: 'projects.open', args: { projectId: existing.id } }
			: { label: `✅ Add ${basename(folder) || folder} as a project`, action: 'projects.create', args: { path: folder } },
		...(parent !== folder ? [{ label: '⬆️ Up', action: 'projects.browse', args: { path: parent } }] : []),
		{ label: '➕ New folder here', action: 'projects.mkdir', args: { path: folder } },
		...(renamable ? [{ label: '✏️ Rename this project', action: 'projects.rename', args: { projectId: existing.id } }] : []),
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
		const folder = join(parent, validFolderName(args.name));
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
		const project = projectAtFolder(folder);
		if (project && !isHomeProject(project) && projectQueries.isListed(project.id)) {
			return {
				text: `📂 \`${shortPath(folder)}\` is the project **${escapeMd(project.name)}**: renaming it renames the project too.`,
				choices: [{ label: '✏️ Rename this project', action: 'projects.rename', args: { projectId: project.id } }]
			};
		}
		const reason = protectedFolderReason(folder);
		if (reason) throw new Error(`${shortPath(folder)} cannot be renamed here: ${reason}.`);
		if (args.name === undefined) {
			return { text: `📂 \`${shortPath(folder)}\``, ask: { question: `New name for ${basename(folder)}?`, action: 'projects.rename-folder', args: { path: folder }, key: 'name' } };
		}
		const renamed = join(dirname(folder), validFolderName(args.name));
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
		const reason = protectedFolderReason(folder);
		if (reason) throw new Error(`${shortPath(folder)} cannot be deleted here: ${reason}.`);
		rmSync(folder, { recursive: true, force: true });
		return browse(dirname(folder), 0, `🗑️ Deleted \`${shortPath(folder)}\`.`);
	}
});

export const createProject = defineAction({
	id: 'projects.create',
	group: 'projects',
	title: 'Add project',
	description: 'Add a folder on this machine as a project, and switch to it. The project is named after the folder.',
	args: t.Object({ path: t.String({ minLength: 1 }) }),
	async run(ctx, args) {
		const path = normalisePath(args.path);
		if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`There is no folder at ${shortPath(path)}.`);
		const project = await ctx.call<Project>('projects:create', { path });
		return {
			text: `📁 Added and opened **${escapeMd(project.name)}** (\`${shortPath(path)}\`).`,
			target: { projectId: project.id, sessionId: latestSession(project.id)?.id ?? null }
		};
	}
});

/** The project an action names, or the one the conversation is in. */
function projectToRename(projectId: string | undefined, fallback: string): Project {
	const project = projectQueries.getById(projectId ?? fallback);
	if (!project || !projectQueries.isListed(project.id)) throw new Error('That project is not in Clopen any more.');
	if (isHomeProject(project)) throw new Error(`${HOME_PROJECT_NAME} cannot be renamed. Open a project first with /projects.`);
	return project;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** "2 chats and 1 terminal", or with what each is doing — the words the web dialog uses. */
function describeUsage(usage: { chats: number; terminals: number }, withState = true): string {
	const parts = [
		...(usage.chats ? [`${plural(usage.chats, 'chat')}${withState ? ' still running' : ''}`] : []),
		...(usage.terminals ? [`${plural(usage.terminals, 'terminal')}${withState ? ' open' : ''}`] : [])
	];
	return parts.join(' and ');
}

/**
 * Renaming a project renames its folder: the project is always named after
 * it. Work running there blocks it until the user asks to stop that work.
 */
export const renameProject = defineAction({
	id: 'projects.rename',
	group: 'projects',
	title: 'Rename project',
	description: 'Rename the project and its folder on disk. Chats, terminals and history follow it.',
	args: t.Object({
		projectId: t.Optional(t.String({ minLength: 1 })),
		name: t.Optional(t.String()),
		force: t.Optional(t.Boolean())
	}),
	command: { name: 'renameproject', argument: { keys: ['name'], hint: '<new name>' } },
	confirm(args, ctx) {
		if (!args.force || args.name === undefined) return null;
		const project = projectToRename(args.projectId, ctx.target.projectId);
		const usage = getProjectUsage(project.id);
		if (!usage.chats && !usage.terminals) return null;
		return `This stops ${describeUsage(usage, false)} in ${project.name}, then renames it to “${args.name.trim()}”.`;
	},
	async run(ctx, args) {
		const project = projectToRename(args.projectId, ctx.target.projectId);
		if (args.name === undefined) {
			return {
				text: `📁 **${escapeMd(project.name)}** (\`${shortPath(project.path)}\`)`,
				ask: { question: `New name for ${project.name}? Its folder is renamed too.`, action: 'projects.rename', args: { projectId: project.id }, key: 'name' }
			};
		}
		const name = validFolderName(args.name);
		const outcome = await ctx.call<MoveOutcome>('projects:rename', { id: project.id, name, force: args.force ?? false }, { projectId: project.id });
		if (outcome.status === 'busy') {
			return {
				text: `⏳ **${escapeMd(project.name)}** has ${describeUsage(outcome.usage)}. Renaming would leave them working in a folder that is gone.`,
				choices: [{ label: '⏹️ Stop all & rename', action: 'projects.rename', args: { projectId: project.id, name, force: true } }]
			};
		}
		const lines = [
			outcome.previousPath === outcome.project.path
				? `📁 **${escapeMd(project.name)}** already has that name.`
				: `✏️ Renamed to **${escapeMd(outcome.project.name)}** (\`${shortPath(outcome.project.path)}\`).`,
			...outcome.warnings.map((warning) => `⚠️ ${warning}`)
		];
		return { text: lines.join('\n') };
	}
});

/** Names are user data: keep `*`, `_` and friends literal inside Markdown. */
export function escapeMd(value: string): string {
	return value.replace(/([\\`*_~[\]])/g, '\\$1');
}
