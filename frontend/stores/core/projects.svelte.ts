/**
 * Projects Store
 * All project-related state and functions
 *
 * State persistence: Server-side via user:save-state / user:restore-state
 * No localStorage usage - server is single source of truth
 */

import ws from '$frontend/utils/ws';
import type { Project } from '$shared/types/database/schema';

import { debug } from '$shared/utils/logger';
import { cleanupProjectState } from '$frontend/utils/project-state-cleanup';
import {
	activateProjectWorkspace,
	raiseSwitchBarrier,
	lowerSwitchBarrier,
	beginProjectSwitch,
	isCurrentSwitch,
	beginPanelLoad
} from '$frontend/stores/ui/project-workspace.svelte';

// Subscribe to admin-driven project assignment changes for the current user.
// Event is broadcast globally; only react when this client is the target.
ws.on('auth:user-projects-changed', async (payload) => {
	const { authStore } = await import('$frontend/stores/features/auth.svelte');
	if (payload.userId !== authStore.currentUser?.id) return;

	debug.log('project', `User-projects changed: ${payload.type} ${payload.projectId}`);
	loadProjects().catch((err) => {
		debug.error('project', 'Failed to reload after assignment change:', err);
	});

	if (payload.type === 'unassigned' && projectState.currentProject?.id === payload.projectId) {
		setCurrentProject(null).catch(() => {});
	}
});
interface ProjectState {
	projects: Project[];
	currentProject: Project | null;
	recentProjects: Project[];
	projectOrder: string[];
	isLoading: boolean;
	error: string | null;
}

// Project state using Svelte 5 runes
export const projectState = $state<ProjectState>({
	projects: [],
	currentProject: null,
	recentProjects: [],
	projectOrder: [],
	isLoading: false,
	error: null
});

// ========================================
// DERIVED VALUES
// ========================================

export function hasProjects() {
	return projectState.projects.length > 0;
}

export function currentProjectName() {
	return projectState.currentProject?.name || '';
}

export function currentProjectPath() {
	return projectState.currentProject?.path || '';
}

// ========================================
// PROJECT MANAGEMENT
// ========================================

/**
 * Make `project` the active project.
 *
 * A switch is generation-guarded: every run takes a token and re-checks it after
 * each `await` before writing shared state. Clicking through projects quickly
 * used to leave several of these chains racing — a superseded one would finish
 * last and publish ITS project as current, so the workspace ended up on a
 * project the user had already moved past (or stuck behind a barrier whose
 * raise/release no longer paired up).
 *
 * The structural swap (WS room, workspace layout, dock view-state) runs behind
 * the switch barrier because showing anything mid-swap means showing the wrong
 * project. Everything else — sessions, messages, edit mode, dock data — loads
 * after reveal behind each panel's own skeleton, so switch latency is one round
 * trip plus a blob fetch instead of the sum of every subsystem's load.
 */
export async function setCurrentProject(project: Project | null) {
	const { setCurrentSession } = await import('./sessions.svelte');
	const { appState } = await import('./app.svelte');

	const currentProjectId = projectState.currentProject?.id;
	const newProjectId = project?.id;
	const isProjectSwitch = currentProjectId !== newProjectId;

	if (!isProjectSwitch) {
		// Same project — no transition, just refresh the record.
		await ws.setProject(newProjectId ?? null);
		projectState.currentProject = project;
		if (project) {
			persistCurrentProjectId(project.id);
			void refreshProjectRecord(project.id);
		} else {
			persistCurrentProjectId(null);
		}
		return;
	}

	const token = beginProjectSwitch();

	// Raise the barrier as early as possible so no frame of the outgoing project
	// survives into the new one. Released as soon as the workspace is
	// structurally correct — not once all data has arrived.
	raiseSwitchBarrier();

	// Held for the whole transition so panels keep their skeletons (and reactive
	// effects keep their "don't persist stale state" guard) until the chat
	// session has actually landed.
	const releaseChat = project ? beginPanelLoad('chat', token) : null;
	if (project) appState.isRestoring = true;

	try {
		// Sync project context with WebSocket (for room-based broadcasting).
		// IMPORTANT: must complete before anything project-scoped is requested,
		// so this one stays sequential.
		await ws.setProject(newProjectId ?? null);
		if (!isCurrentSwitch(token)) return;

		// Presence tracking is independent of the workspace swap — startTracking()
		// already leaves the previous project — so let it run alongside instead of
		// adding two round trips in front of the visible transition.
		const tracking = swapPresenceTracking(newProjectId);
		if (currentProjectId) appState.isLoading = false;

		// Swap the per-project workspace: clears all docks, restores this
		// project's layout + dock view-state, then starts each dock's data load
		// behind its own panel skeleton.
		//
		// Publish the new current project via the coordinator's post-restore
		// hook so it lands in the SAME synchronous flush as the layout swap.
		// Otherwise the layout swap remounts already-live panels while
		// currentProject still points at the OLD project — they load the wrong
		// project, then race a reload, and can end up blank until a full refresh.
		// isRestoring is already true (set above), so effects that fire on this
		// change still see the transition flag and won't persist stale state.
		await activateProjectWorkspace(
			newProjectId ?? null,
			() => {
				if (project) projectState.currentProject = project;
			},
			token
		);
		if (!isCurrentSwitch(token)) return;

		const { onProjectLeave, onProjectEnter } = await import('$frontend/stores/ui/edit-mode.svelte');
		onProjectLeave();
		await setCurrentSession(null);
		if (!isCurrentSwitch(token)) return;

		await tracking;
	} finally {
		// Reveal: the workspace is now structurally the new project's.
		lowerSwitchBarrier();
	}

	if (!isCurrentSwitch(token)) {
		releaseChat?.();
		return;
	}

	if (!project) {
		appState.isRestoring = false;
		persistCurrentProjectId(null);
		debug.log('project', 'Project cleared');
		return;
	}

	persistCurrentProjectId(project.id);

	// Everything below runs AFTER the reveal, behind the chat panel's skeleton.
	try {
		await restoreSessionForProject(project, token);
	} finally {
		if (isCurrentSwitch(token)) appState.isRestoring = false;
		releaseChat?.();
	}

	if (isCurrentSwitch(token)) await refreshProjectRecord(project.id);
}

/** Move presence tracking to `projectId` (or drop it when null). */
async function swapPresenceTracking(projectId: string | undefined): Promise<void> {
	if (typeof window === 'undefined') return;
	try {
		const { projectStatusService } = await import('$frontend/services/project');
		if (projectId) {
			// startTracking() stops the previous project itself.
			await projectStatusService.startTracking(projectId);
		} else {
			await projectStatusService.stopTracking();
		}
	} catch (error) {
		debug.error('project', 'Error updating project tracking:', error);
	}
}

/**
 * Restore (or create) the chat session for a freshly-activated project and
 * restore its edit mode. Runs after reveal; every write is guarded by `token`
 * so a superseded switch can never install its session into the live project.
 */
async function restoreSessionForProject(project: Project, token: number): Promise<void> {
	const { setCurrentSession, createSession, getSessionsForProject, reloadSessionsForProject } =
		await import('./sessions.svelte');
	const { onProjectEnter } = await import('$frontend/stores/ui/edit-mode.svelte');

	try {
		// Reload all sessions for this project from server
		// (local state may only have sessions from the previous project)
		const savedSessionId = await reloadSessionsForProject();
		if (!isCurrentSwitch(token)) return;

		const activeSessions = getSessionsForProject(project.id)
			.filter((s) => !s.ended_at)
			.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());

		// Try server-saved session first (preserves user's last selected session),
		// then fall back to the most recent active one.
		const activeSession =
			(savedSessionId ? activeSessions.find((s) => s.id === savedSessionId) : null) ||
			activeSessions[0] ||
			null;

		if (activeSession) {
			debug.log('project', 'Restoring existing session for project:', activeSession.id);
			await setCurrentSession(activeSession);
		} else {
			debug.log('project', 'Creating new session for project:', project.id);
			const newSession = await createSession(project.id, 'Chat Session', false);
			if (newSession && isCurrentSwitch(token)) {
				await setCurrentSession(newSession);
			}
		}
		if (!isCurrentSwitch(token)) return;

		// Restore edit mode from server for the new project
		// (ws.setProject already completed, so server returns correct project's state)
		await onProjectEnter();
	} catch (error) {
		debug.error('project', 'Error restoring session for project:', error);
	}
}

/** Persist the active project id server-side (fire and forget). */
function persistCurrentProjectId(projectId: string | null): void {
	ws.http('user:save-state', { key: 'currentProjectId', value: projectId }).catch((err) => {
		debug.error('project', 'Error saving project state to server:', err);
	});
}

/** Re-read a project so `last_opened_at` and any server-side edits are current. */
async function refreshProjectRecord(projectId: string): Promise<void> {
	try {
		const updatedProject = await ws.http('projects:get', { id: projectId });
		if (!updatedProject) return;

		const index = projectState.projects.findIndex((p) => p.id === projectId);
		if (index !== -1) {
			projectState.projects[index] = updatedProject;
		}
		// Only adopt it as current if the user hasn't moved on in the meantime.
		if (projectState.currentProject?.id === projectId) {
			projectState.currentProject = updatedProject;
		}
	} catch (error) {
		debug.error('project', 'Error updating project last opened:', error);
	}
}

export function addProject(project: Project) {
	projectState.projects.push(project);
	projectState.projectOrder = projectState.projects.map((p) => p.id);
	persistProjectOrder();
	updateRecentProjects();
}

export function updateProject(updatedProject: Project) {
	const index = projectState.projects.findIndex(p => p.id === updatedProject.id);
	if (index !== -1) {
		projectState.projects[index] = updatedProject;

		// Update current project if it's the same
		if (projectState.currentProject?.id === updatedProject.id) {
			projectState.currentProject = updatedProject;
		}
	}
	updateRecentProjects();
}

export function removeProject(projectId: string) {
	// Get project path before removal for cleanup
	const projectToRemove = projectState.projects.find(p => p.id === projectId);
	const projectPath = projectToRemove?.path || '';

	projectState.projects = projectState.projects.filter(p => p.id !== projectId);
	projectState.projectOrder = projectState.projects.map((p) => p.id);
	persistProjectOrder();

	// Clear current project if it's being removed
	if (projectState.currentProject?.id === projectId) {
		projectState.currentProject = null;
	}

	// Clean up in-memory state to prevent memory leaks
	cleanupProjectState(projectId, projectPath);

	updateRecentProjects();
}

function persistProjectOrder() {
	ws.http('user:save-state', { key: 'projectOrder', value: [...projectState.projectOrder] }).catch((err) => {
		debug.error('project', 'Error saving project order to server:', err);
	});
}

function applyProjectOrder(projects: Project[], order: string[]): Project[] {
	if (order.length === 0) return projects;

	const projectMap = new Map(projects.map((project) => [project.id, project]));
	const orderedProjects: Project[] = [];

	for (const id of order) {
		const project = projectMap.get(id);
		if (!project) continue;
		orderedProjects.push(project);
		projectMap.delete(id);
	}

	for (const project of projects) {
		if (projectMap.has(project.id)) {
			orderedProjects.push(project);
		}
	}

	return orderedProjects;
}

export function restoreProjectOrder(order: string[] | null | undefined) {
	projectState.projectOrder = Array.isArray(order) ? [...order] : [];
	if (projectState.projects.length > 0) {
		projectState.projects = applyProjectOrder(projectState.projects, projectState.projectOrder);
		projectState.projectOrder = projectState.projects.map((project) => project.id);
	}
}

export function reorderProjects(sourceProjectId: string, targetProjectId: string) {
	if (sourceProjectId === targetProjectId) return;

	const projects = [...projectState.projects];
	const sourceIndex = projects.findIndex((project) => project.id === sourceProjectId);
	const targetIndex = projects.findIndex((project) => project.id === targetProjectId);
	if (sourceIndex === -1 || targetIndex === -1) return;

	const [movedProject] = projects.splice(sourceIndex, 1);
	projects.splice(targetIndex, 0, movedProject);

	projectState.projects = projects;
	projectState.projectOrder = projects.map((project) => project.id);
	persistProjectOrder();
	updateRecentProjects();
}

// ========================================
// DATA LOADING
// ========================================

/**
 * Load projects from server.
 * Optionally restores current project from server-provided projectId.
 */
export async function loadProjects(restoreProjectId?: string | null) {
	projectState.isLoading = true;
	projectState.error = null;

	try {
		// Load projects via WebSocket
		const projects = await ws.http('projects:list');

		if (projects) {
			projectState.projects = applyProjectOrder(projects, projectState.projectOrder);
			projectState.projectOrder = projectState.projects.map((project) => project.id);
			updateRecentProjects();

			// Restore current project from server-provided ID if not already set
			if (!projectState.currentProject && restoreProjectId) {
				const existingProject = projects.find(p => p.id === restoreProjectId);
				if (existingProject) {
					debug.log('project', 'Restoring project from server state:', existingProject.id);

					// Sync project context with WebSocket FIRST (before setting reactive state)
					// This ensures server knows the project before any reactive effects fire
					await ws.setProject(existingProject.id);
					debug.log('project', 'WebSocket context synced for restored project:', existingProject.id);

					// Activate this project's per-project workspace (layout + dock
					// view-state). During app init this runs behind the loading
					// screen, so the restored layout is ready on first paint.
					// Publish currentProject via the post-restore hook (batched with
					// the layout swap) for parity with the project-switch path.
					await activateProjectWorkspace(existingProject.id, () => {
						projectState.currentProject = existingProject;
					});

					// Start tracking the restored project
					if (typeof window !== 'undefined') {
						try {
							const { projectStatusService } = await import('$frontend/services/project');
							await projectStatusService.startTracking(existingProject.id);
						} catch (error) {
							debug.error('project', 'Error starting tracking for restored project:', error);
						}
					}
				} else {
					debug.log('project', 'Saved project no longer exists on server');
				}
			} else if (!projectState.currentProject) {
				debug.log('project', 'No saved project to restore');
			} else {
				debug.log('project', 'Project already set, skipping restoration');
			}
		} else {
			projectState.error = 'Failed to load projects';
		}
	} catch (error) {
		debug.error('project', 'Error loading projects:', error);
		projectState.error = `Error loading projects: ${error}`;
	} finally {
		projectState.isLoading = false;
	}
}

export async function createProject(projectData: Omit<Project, 'id' | 'created_at'>) {
	try {
		// Create project via WebSocket
		const project = await ws.http('projects:create', {
			name: projectData.name,
			path: projectData.path
		});

		if (project) {
			addProject(project);
			return project;
		} else {
			projectState.error = 'Failed to create project';
			return null;
		}
	} catch (error) {
		debug.error('project', 'Error creating project:', error);
		projectState.error = `Error creating project: ${error}`;
		return null;
	}
}

// ========================================
// UTILITY FUNCTIONS
// ========================================

function updateRecentProjects() {
	projectState.recentProjects = projectState.projects
		.filter(p => p.last_opened_at)
		.sort((a, b) => new Date(b.last_opened_at!).getTime() - new Date(a.last_opened_at!).getTime())
		.slice(0, 5);
}

export function searchProjects(query: string): Project[] {
	const lowercaseQuery = query.toLowerCase();
	return projectState.projects.filter(project =>
		project.name.toLowerCase().includes(lowercaseQuery) ||
		project.path.toLowerCase().includes(lowercaseQuery)
	);
}

// ========================================
// INITIALIZATION
// ========================================

export async function initializeProjects(restoreProjectId?: string | null) {
	await loadProjects(restoreProjectId);
}
