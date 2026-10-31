/**
 * Git Operation State Handler
 *
 * Publishes the per-repository operation lock (`backend/git/op-lock.ts`) so
 * every client renders the same busy state, and handles the one recovery the
 * lock cannot prevent: a lockfile left behind by a git process that died.
 */

import { t } from 'elysia';
import path from 'node:path';
import { stat, unlink } from 'node:fs/promises';
import { createRouter } from '$shared/utils/ws-server';
import { scopeProjectId } from '$shared/utils/workspace-scope';
import { debug } from '$shared/utils/logger';
import { ws } from '$backend/utils/ws';
import { getScopeOpStates, hasProjectOps, onGitOpChange } from '../../git/op-lock';
import { gitRepoContext } from './repo-context';
import type { GitLockStatus } from '$shared/types/git';

/**
 * A lockfile younger than this probably belongs to a live git process — a
 * terminal, an agent, an IDE — that will release it on its own.
 */
const STALE_LOCK_AGE_MS = 10_000;

const ActiveOpSchema = t.Object({
	id: t.String(),
	category: t.Union([
		t.Literal('commit'),
		t.Literal('staging'),
		t.Literal('push'),
		t.Literal('pull'),
		t.Literal('fetch'),
		t.Literal('more'),
		t.Literal('stash'),
		t.Literal('tag'),
		t.Literal('branch'),
		t.Literal('resolve'),
		t.Literal('configure')
	]),
	cls: t.Union([t.Literal('exclusive'), t.Literal('network'), t.Literal('index')]),
	label: t.String(),
	target: t.Optional(t.String()),
	startedAt: t.Number()
});

const RepoOpStateSchema = t.Object({
	scope: t.String(),
	repoPath: t.Optional(t.String()),
	ops: t.Array(ActiveOpSchema)
});

onGitOpChange((state) => {
	ws.emit.project(scopeProjectId(state.scope), 'git:op-state', state);
});

/**
 * The lock path from a git error, validated to be a `.lock` file inside a git
 * directory of this project. Everything else is refused: this endpoint deletes
 * files, so it must never accept an arbitrary path.
 */
function validateLockPath(lockPath: string, roots: string[]): string {
	const resolved = path.resolve(lockPath);
	const segments = resolved.split(path.sep);
	if (!resolved.endsWith('.lock') || !segments.includes('.git')) {
		throw new Error('Not a git lock file.');
	}
	const inside = roots.some(root => {
		const base = path.resolve(root);
		return resolved.startsWith(base + path.sep);
	});
	if (!inside) throw new Error('The lock file is outside this project.');
	return resolved;
}

async function inspectLock(projectId: string, lockPath: string): Promise<GitLockStatus> {
	const clopenOpRunning = hasProjectOps(projectId);
	try {
		const info = await stat(lockPath);
		const ageMs = Math.max(0, Date.now() - info.mtimeMs);
		return {
			exists: true,
			ageMs,
			clopenOpRunning,
			removable: !clopenOpRunning && ageMs >= STALE_LOCK_AGE_MS
		};
	} catch {
		return { exists: false, ageMs: 0, clopenOpRunning, removable: false };
	}
}

const LockStatusSchema = t.Object({
	exists: t.Boolean(),
	ageMs: t.Number(),
	clopenOpRunning: t.Boolean(),
	removable: t.Boolean()
});

export const opStateHandler = createRouter()
	// Every operation running in the connection's workspace — read on mount,
	// on workspace switch and after a reconnect, when events may have been missed.
	.http('git:op-states', {
		data: t.Object({ projectId: t.String() }),
		response: t.Array(RepoOpStateSchema)
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId);
		return getScopeOpStates(ctx.scope);
	})

	.http('git:lock-status', {
		data: t.Object({ projectId: t.String(), lockPath: t.String({ minLength: 1 }) }),
		response: LockStatusSchema
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId);
		const lockPath = validateLockPath(data.lockPath, [ctx.root, ctx.projectRoot]);
		return inspectLock(ctx.projectId, lockPath);
	})

	.http('git:remove-stale-lock', {
		data: t.Object({ projectId: t.String(), lockPath: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const ctx = gitRepoContext(conn, data.projectId);
		const lockPath = validateLockPath(data.lockPath, [ctx.root, ctx.projectRoot]);
		// Re-check at the moment of deletion: the status the client saw may be old.
		const status = await inspectLock(ctx.projectId, lockPath);
		if (!status.exists) return { ok: true };
		if (status.clopenOpRunning) {
			throw new Error('A git operation started by Clopen is still running — wait for it to finish.');
		}
		if (!status.removable) {
			throw new Error('The lock was written moments ago, so another git process is probably still using it. Try again shortly.');
		}
		await unlink(lockPath);
		debug.warn('git', `Removed stale git lock file: ${lockPath}`);
		return { ok: true };
	})

	.emit('git:op-state', RepoOpStateSchema);
