/**
 * Project-scoped path resolution for actions that touch the filesystem
 * (screenshot → file, file upload).
 *
 * Agent-supplied paths are resolved against the project directory and must
 * stay inside it. Symlinks are followed on both sides before comparing, so a
 * link inside the project cannot be used to reach out of it.
 */

import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { projectQueries } from '$backend/database/queries/project-queries';

async function resolveRealPath(p: string): Promise<string> {
	const abs = resolve(p);
	try {
		return await realpath(abs);
	} catch {
		// Not created yet — resolve the deepest existing ancestor and rejoin the
		// tail, so a symlinked parent is still followed.
		const parent = dirname(abs);
		if (parent === abs) return abs;
		return join(await resolveRealPath(parent), basename(abs));
	}
}

async function isPathInside(rootPath: string, candidatePath: string): Promise<boolean> {
	const root = await resolveRealPath(rootPath);
	const candidate = await resolveRealPath(candidatePath);
	const rel = relative(root, candidate);
	return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function projectRoot(projectId: string): string {
	const project = projectQueries.getById(projectId);
	if (!project?.path) throw new Error(`Project ${projectId} has no directory on disk`);
	return project.path;
}

/** Resolve one agent-supplied path inside the project. */
export async function resolveProjectPath(inputPath: string, projectId: string): Promise<string> {
	const root = projectRoot(projectId);
	const absolute = isAbsolute(inputPath) ? inputPath : resolve(root, inputPath);

	if (!(await isPathInside(root, absolute))) {
		throw new Error(`Path "${inputPath}" resolves outside the project directory`);
	}

	return absolute;
}

/** Resolve paths that must already exist (uploads). */
export async function resolveProjectFiles(inputPaths: string[], projectId: string): Promise<string[]> {
	const resolved: string[] = [];

	for (const inputPath of inputPaths) {
		const absolute = await resolveProjectPath(inputPath, projectId);
		const info = await stat(absolute).catch(() => null);
		if (!info?.isFile()) throw new Error(`File not found: ${inputPath}`);
		resolved.push(absolute);
	}

	return resolved;
}

/** Resolve a write destination, creating its parent directory. */
export async function resolveWritePath(inputPath: string, projectId: string): Promise<string> {
	const absolute = await resolveProjectPath(inputPath, projectId);
	await mkdir(dirname(absolute), { recursive: true });
	return absolute;
}
