/**
 * Move a project to another folder — renaming its folder on disk, or pointing
 * it at a folder that was moved outside Clopen ("Locate folder").
 *
 * A project's name IS its folder's name, so both are one operation here and
 * there is no separate "display name" to keep in step.
 *
 * The folder path is load-bearing in more places than the `projects` row:
 * engines file chat history under it, the memory queue remembers it, and
 * saved panel state refers to files by absolute path. Each is carried along,
 * so chats resume, panels reopen and memory keeps extracting after the move.
 *
 * Work running in the folder blocks the move unless the caller asks to stop
 * it (`force`): a running chat would keep writing into the old path, and a
 * shell would sit in a directory that is no longer named what it says.
 */

import { existsSync, statSync } from 'fs';
import { rename } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { getDatabase } from '$backend/database';
import { memoryQueueQueries, projectQueries, sessionQueries } from '$backend/database/queries';
import { streamManager, type StreamState } from '$backend/chat/stream-manager';
import { countLiveMainTreeSessions, cleanupMainTreeSessions } from '$backend/terminal/ptykit';
import { disposeProjectEngines } from '$backend/engine';
import { fileWatcher } from '$backend/files/file-watcher';
import { execGit } from '$backend/git/git-executor';
import { ws } from '$backend/utils/ws';
import { broadcastPresence } from '$backend/ws/projects/status';
import { isHomeProject } from '$shared/utils/home-project';
import type { Project } from '$shared/types/database/schema';
import { debug } from '$shared/utils/logger';
import { projectAtFolder, protectedFolderReason, validFolderName } from './folder-guard';
import { moveEngineTranscripts } from './engine-transcripts';

/** What is running in a project's main tree right now. */
export interface ProjectUsage {
	chats: number;
	terminals: number;
}

export type MoveRequest = { kind: 'rename'; name: string } | { kind: 'relocate'; path: string };

export type MoveOutcome =
	| { status: 'busy'; usage: ProjectUsage }
	| { status: 'moved'; project: Project; previousPath: string; warnings: string[] };

/** A project as the client sees it: with whether its folder is still there. */
export function withFolderState(project: Project): Project {
	return { ...project, missing: !existsSync(project.path) };
}

/**
 * Chat streams generating in the main tree. A worktree's chat runs in the
 * worktree's own folder, which moving the project folder does not touch.
 */
function mainTreeStreams(projectId: string): StreamState[] {
	return streamManager
		.getProjectStreams(projectId)
		.filter((stream) => stream.status === 'active' && !sessionQueries.getById(stream.chatSessionId)?.worktree_id);
}

export function getProjectUsage(projectId: string): ProjectUsage {
	return { chats: mainTreeStreams(projectId).length, terminals: countLiveMainTreeSessions(projectId) };
}

function isBusy(usage: ProjectUsage): boolean {
	return usage.chats > 0 || usage.terminals > 0;
}

/** Stop everything `getProjectUsage` counts, the same way the Stop button and closing a tab do. */
async function stopProjectUsage(projectId: string): Promise<void> {
	for (const stream of mainTreeStreams(projectId)) {
		await streamManager.cancelStream(stream.streamId, 'project-moved');
		ws.emit.chatSession(stream.chatSessionId, 'chat:cancelled', {
			chatSessionId: stream.chatSessionId,
			status: 'cancelled',
			processId: stream.processId
		});
	}
	const killed = cleanupMainTreeSessions(projectId);
	debug.log('project', `Stopped work in ${projectId} before moving it (${killed} terminal sessions)`);
}

/**
 * `value` with every path at or under `from` re-rooted at `to`. Strings that
 * are themselves JSON (panel state is stored as JSON inside JSON) are opened,
 * rewritten and closed again, so nested paths move too.
 */
export function rewritePathPrefix(value: unknown, from: string, to: string): unknown {
	if (typeof value === 'string') {
		if (value === from) return to;
		if (value.startsWith(`${from}/`) || value.startsWith(`${from}\\`)) return to + value.slice(from.length);
		const head = value.trimStart()[0];
		if (head === '{' || head === '[') {
			try {
				const parsed: unknown = JSON.parse(value);
				const rewritten = rewritePathPrefix(parsed, from, to);
				return rewritten === parsed ? value : JSON.stringify(rewritten);
			} catch {
				return value;
			}
		}
		return value;
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((item) => {
			const rewritten = rewritePathPrefix(item, from, to);
			if (rewritten !== item) changed = true;
			return rewritten;
		});
		return changed ? next : value;
	}
	if (value && typeof value === 'object') {
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			const rewritten = rewritePathPrefix(item, from, to);
			if (rewritten !== item) changed = true;
			next[key] = rewritten;
		}
		return changed ? next : value;
	}
	return value;
}

function rewriteStoredJson(raw: string | null, from: string, to: string): string | null {
	if (!raw) return raw;
	const rewritten = rewritePathPrefix(raw, from, to);
	return typeof rewritten === 'string' ? rewritten : raw;
}

/** Same filesystem entry — a case-only rename on a case-insensitive disk resolves to the source. */
function isSameEntry(a: string, b: string): boolean {
	try {
		const left = statSync(a);
		const right = statSync(b);
		return left.ino === right.ino && left.dev === right.dev;
	} catch {
		return false;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Where the request sends the project, after every check that needs no side effect. */
function resolveTarget(project: Project, request: MoveRequest): string {
	const current = resolve(project.path);

	if (request.kind === 'rename') {
		const name = validFolderName(request.name);
		if (!isDirectory(current)) {
			throw new Error('The project folder is no longer there. Use Locate folder to point the project at where it is now.');
		}
		const reason = protectedFolderReason(current, project.id);
		if (reason) throw new Error(`This folder cannot be renamed: ${reason}.`);
		const target = join(dirname(current), name);
		if (target !== current && existsSync(target) && !isSameEntry(current, target)) {
			throw new Error(`A folder named "${name}" already exists next to it.`);
		}
		return target;
	}

	const target = resolve(request.path);
	if (!isDirectory(target)) throw new Error('There is no folder at that path.');
	const reason = protectedFolderReason(target, project.id);
	if (reason) throw new Error(`That folder cannot be used: ${reason}.`);
	return target;
}

/** Repair `git worktree` links in both directions; a repository without any is left alone. */
async function repairGitWorktrees(folder: string): Promise<string | null> {
	if (!existsSync(join(folder, '.git'))) return null;
	try {
		const result = await execGit(['worktree', 'repair'], folder, 15000);
		if (result.exitCode === 0) return null;
		return `Git worktrees linked to this repository could not be repaired: ${result.stderr.trim() || 'git worktree repair failed'}.`;
	} catch (error) {
		return `Git worktrees linked to this repository could not be repaired: ${error instanceof Error ? error.message : String(error)}.`;
	}
}

function friendlyRenameError(error: unknown): Error {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
		return new Error('The folder could not be renamed because another program is using it. Close any editor, terminal or process open in it and try again.');
	}
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * Rename a project's folder or point the project at another one. Returns
 * `busy` without touching anything when work is running and `force` is off.
 */
export async function moveProject(projectId: string, request: MoveRequest, force = false): Promise<MoveOutcome> {
	const project = projectQueries.getById(projectId);
	if (!project) throw new Error('That project no longer exists.');
	if (isHomeProject(project)) throw new Error('Home cannot be renamed or moved.');

	const previousPath = project.path;
	const target = resolveTarget(project, request);

	const owner = projectAtFolder(target);
	if (owner && owner.id !== project.id) throw new Error(`That folder is already the project ${owner.name}.`);

	// Nothing to move: same folder, same spelling.
	if (target === resolve(previousPath)) {
		return { status: 'moved', project: withFolderState(project), previousPath, warnings: [] };
	}

	const usage = getProjectUsage(projectId);
	const stopping = isBusy(usage);
	if (stopping) {
		if (!force) return { status: 'busy', usage };
		await stopProjectUsage(projectId);
	}

	// Idle state bound to the old path: engines cached with it as cwd (an
	// OpenCode server, a Pi runtime) and the main tree's file watcher. Both are
	// rebuilt on demand at the new path.
	await disposeProjectEngines(projectId);
	fileWatcher.releaseProject(projectId);

	const renaming = request.kind === 'rename';
	if (renaming) {
		try {
			await rename(previousPath, target);
		} catch (error) {
			throw friendlyRenameError(error);
		}
	}

	try {
		const commit = () => {
			projectQueries.relocate(projectId, target, basename(target));
			memoryQueueQueries.repointProject(projectId, previousPath, target);
			projectQueries.setWorkspaceState(projectId, rewriteStoredJson(projectQueries.getWorkspaceState(projectId), previousPath, target));
			projectQueries.setFilesPanelState(projectId, rewriteStoredJson(projectQueries.getFilesPanelState(projectId), previousPath, target));
		};
		const db = getDatabase();
		if (db.transaction) db.transaction(commit)();
		else commit();
	} catch (error) {
		// The record still names the old folder, so the folder goes back there.
		if (renaming) {
			await rename(target, previousPath).catch((rollbackError) => {
				debug.error('project', `Could not move ${target} back to ${previousPath}:`, rollbackError);
			});
		}
		throw error;
	}

	const warnings = moveEngineTranscripts(previousPath, target);
	const gitProblem = await repairGitWorktrees(target);
	if (gitProblem) warnings.push(gitProblem);

	const moved = withFolderState(projectQueries.getById(projectId)!);
	debug.log('project', `Moved project ${projectId}: ${previousPath} -> ${target}`);

	// Every device follows: the sidebar shows the new name, and a device with
	// the project open reloads its workspace at the new path.
	ws.emit.global('projects:updated', { project: moved, previousPath });
	if (stopping) {
		broadcastPresence().catch((err) => {
			debug.warn('project', 'Presence broadcast error after project move:', err);
		});
	}

	return { status: 'moved', project: moved, previousPath, warnings };
}
