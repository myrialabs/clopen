/**
 * The Clopen assistant's workspace — where the owner talks to Clopen itself.
 *
 * It IS a project row, so every path that needs a project — the engine's
 * working directory, snapshots, queueing, notifications — works unchanged.
 * What makes it the assistant is only how it is treated: one per install,
 * never deleted, always listed first, and shown as the assistant view rather
 * than a project workspace. Stored as `kind = 'home'`, the value it had before
 * v0.5 named it; the stored value is a key, not a label.
 */

import type { Project } from '$shared/types/database/schema';

/** Shown wherever the assistant is named. */
export const ASSISTANT_NAME = 'Clopen';

/** The stored `projects.kind` of the assistant's workspace. */
export const ASSISTANT_PROJECT_KIND = 'home';

/** True for the assistant's workspace. Missing `kind` is a pre-migration row: an ordinary project. */
export function isAssistantProject(project: Pick<Project, 'kind'> | null | undefined): boolean {
	return project?.kind === ASSISTANT_PROJECT_KIND;
}

/** The assistant first, everything else in the order given. */
export function assistantFirst<T extends Pick<Project, 'kind'>>(projects: T[]): T[] {
	const assistant = projects.filter(isAssistantProject);
	return assistant.length ? [...assistant, ...projects.filter((project) => !isAssistantProject(project))] : projects;
}
