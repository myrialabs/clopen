/**
 * Project Move Dialog Store
 *
 * One dialog renames a project (and its folder), and one flow re-points a
 * project whose folder vanished. Both open from several places — the sidebar
 * on desktop and mobile, Project Info, the folder picker — so the state lives
 * here and the dialog is mounted once (ModalProvider).
 */

import type { Project } from '$shared/types/database/schema';

/** Told about the new record once a move lands, e.g. to refresh a folder listing. */
export type ProjectMovedHandler = (project: Project, previousPath: string) => void;

interface ProjectMoveState {
	/**
	 * `rename`: ask for a new name.
	 * `missing`: the folder is gone; offer to locate it or remove the project.
	 * `locate`: the user picked where the folder is now, and the move was
	 * blocked by running work — confirm stopping it.
	 */
	mode: 'rename' | 'missing' | 'locate' | null;
	project: Project | null;
	/** The folder picked for `locate`. */
	locatePath: string;
	/** The folder picker for "Locate folder…" is open. */
	pickerOpen: boolean;
	/** The user was trying to open the project, so open it once it is found. */
	openWhenFound: boolean;
	onMoved: ProjectMovedHandler | null;
}

export const projectMoveState = $state<ProjectMoveState>({
	mode: null,
	project: null,
	locatePath: '',
	pickerOpen: false,
	openWhenFound: false,
	onMoved: null
});

export function openRenameProject(project: Project, onMoved?: ProjectMovedHandler): void {
	projectMoveState.project = project;
	projectMoveState.mode = 'rename';
	projectMoveState.onMoved = onMoved ?? null;
}

/** The project's folder is gone: explain, and offer Locate or Remove. */
export function openMissingProject(project: Project): void {
	projectMoveState.project = project;
	projectMoveState.mode = 'missing';
	projectMoveState.openWhenFound = true;
	projectMoveState.onMoved = null;
}

/** Go straight to picking where the folder is now. */
export function openLocateProject(project: Project): void {
	projectMoveState.project = project;
	projectMoveState.mode = null;
	projectMoveState.openWhenFound = false;
	projectMoveState.onMoved = null;
	projectMoveState.pickerOpen = true;
}

export function closeProjectMove(): void {
	projectMoveState.mode = null;
	projectMoveState.project = null;
	projectMoveState.locatePath = '';
	projectMoveState.pickerOpen = false;
	projectMoveState.openWhenFound = false;
	projectMoveState.onMoved = null;
}
