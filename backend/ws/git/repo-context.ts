/**
 * Shared resolution of "which repository does this request address", plus the
 * operation lock every mutating git handler runs under.
 */

import path from 'node:path';
import type { WSConnection } from '$shared/utils/ws-server';
import { makeScopeKey } from '$shared/utils/workspace-scope';
import { debug } from '$shared/utils/logger';
import { requireProjectWorkspace } from '../access';
import { withGitOpLock, type GitOpSpec } from '../../git/op-lock';

/**
 * Resolve the working directory for a git operation. Defaults to the project
 * root; when `repoPath` is provided it must already be inside the project
 * (these paths come from the backend's own `getBranches` response, but we
 * re-validate to defend against a tampered/mismatched client).
 */
export function resolveRepoCwd(projectPath: string, repoPath: string | undefined): string {
	if (!repoPath) return projectPath;
	const resolved = path.resolve(repoPath);
	const projectRoot = path.resolve(projectPath);
	if (resolved !== projectRoot && !resolved.startsWith(projectRoot + path.sep)) {
		debug.warn('git', `Rejected nested repoPath outside project: ${resolved}`);
		return projectPath;
	}
	return resolved;
}

export interface GitRepoContext {
	projectId: string;
	/** The project's own directory — differs from `root` inside a worktree. */
	projectRoot: string;
	/** Root of the workspace the connection is viewing (project or worktree). */
	root: string;
	/** Working directory of the addressed repository. */
	cwd: string;
	/** Workspace scope key — the same key `git:changed` uses. */
	scope: string;
	/** Nested repo path as clients address it; absent for the workspace's own repo. */
	repoPath?: string;
}

/** Resolve the repository a request addresses. `cwd` overrides `repoPath` when known. */
export function gitRepoContext(
	conn: WSConnection,
	projectId: string,
	repoPath?: string,
	cwdOverride?: string
): GitRepoContext {
	const { project, root, worktreeId } = requireProjectWorkspace(conn, projectId);
	const cwd = cwdOverride ?? resolveRepoCwd(root, repoPath);
	const isRoot = path.resolve(cwd) === path.resolve(root);
	return {
		projectId: project.id,
		projectRoot: project.path,
		root,
		cwd,
		scope: makeScopeKey(project.id, worktreeId),
		...(!isRoot && { repoPath: cwd })
	};
}

/** Run `fn` holding the repository's operation lock (see `op-lock.ts`). */
export function withRepoLock<T>(ctx: GitRepoContext, spec: GitOpSpec, fn: () => Promise<T>): Promise<T> {
	return withGitOpLock({ cwd: path.resolve(ctx.cwd), scope: ctx.scope, repoPath: ctx.repoPath }, spec, fn);
}
