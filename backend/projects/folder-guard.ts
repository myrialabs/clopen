/**
 * Which folders may be renamed or deleted, shared by every surface that can do
 * it — the web folder picker and a chat app's folder menu.
 *
 * A project whose folder moved or vanished is broken in Clopen: its chats,
 * terminals and file panels all point at a path that is no longer there. So a
 * project's own folder only moves through `moveProject()`, which carries the
 * project along, and a folder holding a project never moves at all.
 */

import { resolve, sep } from 'path';
import { homedir } from 'os';
import { projectQueries } from '$backend/database/queries';
import { getClopenDir } from '$backend/utils/paths';
import { isPathInside } from '$backend/worktrees/paths';
import { isHomeProject, HOME_PROJECT_NAME } from '$shared/utils/home-project';
import type { Project } from '$shared/types/database/schema';

/**
 * Why `folder` must not be renamed or deleted, or null when it may. The home
 * folder and everything above it, Clopen's own data, and any folder that is
 * (or holds) a project are off limits. `ownProjectId` exempts that project's
 * own folder, for the rename that moves the project with it — a folder inside
 * it that is another project still blocks.
 */
export function protectedFolderReason(folder: string, ownProjectId?: string): string | null {
	const target = resolve(folder);
	if (target === resolve(sep) || isPathInside(target, homedir())) return 'it is your home folder or one above it';
	const data = getClopenDir();
	if (isPathInside(data, target) || isPathInside(target, data)) return "it holds Clopen's own data";
	const project = projectQueries
		.getAll()
		.find((entry) => entry.id !== ownProjectId && isPathInside(target, resolve(entry.path)));
	if (project) return `it ${resolve(project.path) === target ? 'is' : 'holds'} the project ${projectName(project)}`;
	return null;
}

/** The project whose folder is exactly `folder`, listed or not. */
export function projectAtFolder(folder: string): Project | null {
	const target = resolve(folder);
	return projectQueries.getAll().find((entry) => resolve(entry.path) === target) ?? null;
}

/** A folder name a person typed: one path segment, nothing that climbs out. */
export function validFolderName(input: string | undefined): string {
	const name = (input ?? '').trim();
	if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name) || name.length > 255) {
		throw new Error('That is not a folder name. Use a single name, without slashes.');
	}
	return name;
}

function projectName(project: Project): string {
	return isHomeProject(project) ? HOME_PROJECT_NAME : project.name;
}
