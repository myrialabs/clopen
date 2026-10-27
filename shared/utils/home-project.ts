/**
 * Home — a user's own workspace for chatting with no project selected.
 *
 * It IS a project row (`kind = 'home'`), so every path that needs a project —
 * the engine's working directory, snapshots, queueing, notifications — works
 * unchanged. What makes it Home is only how it is treated: one per user,
 * never shared, never deleted, always listed first, and greeted differently.
 * It is the seat a future orchestrator chat starts from.
 */

import type { Project } from '$shared/types/database/schema';

/** Shown wherever Home is named. */
export const HOME_PROJECT_NAME = 'Home';

/** True for a user's Home workspace. Missing `kind` is a pre-migration row: an ordinary project. */
export function isHomeProject(project: Pick<Project, 'kind'> | null | undefined): boolean {
	return project?.kind === 'home';
}

/** Home first, everything else in the order given. */
export function homeFirst<T extends Pick<Project, 'kind'>>(projects: T[]): T[] {
	const home = projects.filter(isHomeProject);
	return home.length ? [...home, ...projects.filter((project) => !isHomeProject(project))] : projects;
}
