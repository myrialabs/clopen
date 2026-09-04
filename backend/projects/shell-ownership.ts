/**
 * Which processes belong to a project.
 *
 * A PtyKit namespace is a project id, so an active PTY session's shell pid is
 * the root of everything that project spawned. Two features ask this and walk
 * it in opposite directions — Ports climbs from a listening socket's pid to
 * find the owning session, Project Info descends from the project to total its
 * usage — so the roots themselves are defined once, here.
 */

import { projectQueries } from '$backend/database/queries';
import { ptyKitManager } from '../terminal/ptykit';
import { debug } from '$shared/utils/logger';

/** An active terminal shell, and the project it belongs to. */
export interface ProjectShell {
	pid: number;
	sessionId: string;
	projectId: string;
	projectName: string | null;
	cwd: string;
}

function shellsOf(projectId: string, projectName: string | null): ProjectShell[] {
	const shells: ProjectShell[] = [];
	for (const session of ptyKitManager.list(projectId)) {
		const info = session.info();
		if (info.status !== 'active' || !Number.isFinite(info.pid) || info.pid <= 0) continue;
		shells.push({
			pid: info.pid,
			sessionId: info.sessionId,
			projectId,
			projectName,
			cwd: info.cwd
		});
	}
	return shells;
}

/** Every active shell on this host, keyed by pid. */
export function collectSessionPids(): Map<number, ProjectShell> {
	const sessions = new Map<number, ProjectShell>();

	try {
		for (const project of projectQueries.getAll()) {
			for (const shell of shellsOf(project.id, project.name ?? null)) {
				sessions.set(shell.pid, shell);
			}
		}
	} catch (error) {
		debug.log('project', 'could not read terminal sessions:', error);
	}

	return sessions;
}

/** Root pids to descend from when totalling one project's usage. */
export function projectShellPids(projectId: string): number[] {
	try {
		return shellsOf(projectId, null).map((shell) => shell.pid);
	} catch (error) {
		debug.log('project', 'could not read terminal sessions:', error);
		return [];
	}
}
