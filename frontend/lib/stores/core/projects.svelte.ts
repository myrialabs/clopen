/**
 * Projects Store
 * All project-related state and functions
 *
 * State persistence: Server-side via user:save-state / user:restore-state
 * No localStorage usage - server is single source of truth
 */

import ws from '$frontend/lib/utils/ws';
import type { Project } from '$shared/types/database/schema';

import { debug } from '$shared/utils/logger';
interface ProjectState {
	projects: Project[];
	currentProject: Project | null;
	recentProjects: Project[];
	isLoading: boolean;
	error: string | null;
}

// Project state using Svelte 5 runes
export const projectState = $state<ProjectState>({
	projects: [],
	currentProject: null,
	recentProjects: [],
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

export async function setCurrentProject(project: Project | null) {
	// Only clear session if we're actually switching to a different project
	const { sessionState, setCurrentSession } = await import('./sessions.svelte');
	const { appState } = await import('./app.svelte');

	// Sync project context with WebSocket (for room-based broadcasting)
	// IMPORTANT: Must await to ensure server has context before other operations
	await ws.setProject(project?.id ?? null);

	// Check if we're switching to a different project
	const currentProjectId = projectState.currentProject?.id;
	const newProjectId = project?.id;

	// Handle project status tracking and terminal context switching
	if (typeof window !== 'undefined') {
		try {
			// Import services dynamically to avoid circular dependency
			const { projectStatusService } = await import('$frontend/lib/services/project');
			const { terminalProjectManager } = await import('$frontend/lib/services/terminal');

			// Stop tracking previous project if switching
			if (currentProjectId && currentProjectId !== newProjectId) {
				await projectStatusService.stopTracking();

				// Reset loading state when switching projects
				appState.isLoading = false;
			}

			// Start tracking new project
			if (project?.id) {
				await projectStatusService.startTracking(project.id);
				// Switch terminal context to the new project
				await terminalProjectManager.switchToProject(project.id, project.path);
			}
		} catch (error) {
			debug.error('project', 'Error updating project tracking:', error);
		}
	}

	// If switching to a different project, handle session transition
	if (currentProjectId !== newProjectId) {
		// Set restoring flag FIRST - prevents reactive effects from syncing stale state
		// to the new project during transition
		if (project) {
			appState.isRestoring = true;
		}

		// Clear edit mode state from previous project (server retains per-project state)
		const { onProjectLeave, onProjectEnter } = await import('$frontend/lib/stores/ui/edit-mode.svelte');
		onProjectLeave();

		// Clear current session when switching projects
		await setCurrentSession(null);

		// If we have a new project, try to restore or create a session for it
		if (project) {
			try {
				// Import session management functions
				const { createSession, getSessionsForProject, reloadSessionsForProject } = await import('./sessions.svelte');

				// Reload all sessions for this project from server
				// (local state may only have sessions from the previous project)
				await reloadSessionsForProject();

				// Check if there's an existing session for this project
				const existingSessions = getSessionsForProject(project.id);
				const activeSessions = existingSessions
					.filter(s => !s.ended_at)
					.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
				const activeSession = activeSessions[0] || null;

				if (activeSession) {
					// Restore the most recent active session for this project
					debug.log('project', 'Restoring existing session for project:', activeSession.id);
					await setCurrentSession(activeSession);
				} else {
					// Create a new session for this project
					debug.log('project', 'Creating new session for project:', project.id);
					const newSession = await createSession(project.id, 'Chat Session', false);
					if (newSession) {
						await setCurrentSession(newSession);
					}
				}

				// Restore edit mode from server for the new project
				// (ws.setProject already completed, so server returns correct project's state)
				await onProjectEnter();

				// Set projectState BEFORE clearing isRestoring
				// This ensures reactive effects that fire on projectState change
				// still see isRestoring=true and don't sync stale state to server
				projectState.currentProject = project;
			} finally {
				// Clear restoring flag after project state is fully set
				appState.isRestoring = false;
			}
		}
	} else {
		projectState.currentProject = project;
	}

	if (project) {
		// Save current project ID to server
		ws.http('user:save-state', { key: 'currentProjectId', value: project.id }).catch(err => {
			debug.error('project', 'Error saving project state to server:', err);
		});

		try {
			// Update last opened time via WebSocket
			const updatedProject = await ws.http('projects:get', { id: project.id });

			if (updatedProject) {
				// Update in local state
				const index = projectState.projects.findIndex(p => p.id === project.id);
				if (index !== -1) {
					projectState.projects[index] = updatedProject;
				}
				projectState.currentProject = updatedProject;
			}
		} catch (error) {
			debug.error('project', 'Error updating project last opened:', error);
		}
	} else {
		// Save null to server
		ws.http('user:save-state', { key: 'currentProjectId', value: null }).catch(err => {
			debug.error('project', 'Error clearing project state on server:', err);
		});
		debug.log('project', 'Project cleared');
	}
}

export function addProject(project: Project) {
	projectState.projects.push(project);
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
	projectState.projects = projectState.projects.filter(p => p.id !== projectId);

	// Clear current project if it's being removed
	if (projectState.currentProject?.id === projectId) {
		projectState.currentProject = null;
	}
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
			projectState.projects = projects;
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

					projectState.currentProject = existingProject;

					// Start tracking the restored project
					if (typeof window !== 'undefined') {
						try {
							const { projectStatusService } = await import('$frontend/lib/services/project');
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
