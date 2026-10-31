/**
 * Per-repository git operation lock.
 *
 * The panel used to guard against overlapping operations with flags that lived
 * in each browser tab, and only the flag of the button being clicked was
 * checked. A pull from the Branches tab could start while a push from the
 * Changes tab was still running, and a second device saw no spinner at all —
 * so two git processes raced for `index.lock`, or one moved HEAD under the
 * other.
 *
 * The lock lives here instead, where every client's request passes through.
 * Each mutating handler declares what it is doing; a request whose class
 * conflicts with a running operation is refused with the reason, and every
 * change is reported to listeners so the clients render one shared answer.
 *
 * In-memory on purpose: the git processes it describes die with the server,
 * so a lock that survived a restart would describe nothing.
 */

import { scopeProjectId } from '$shared/utils/workspace-scope';
import type { GitActiveOp, GitOpCategory, GitOpClass, GitRepoOpState } from '$shared/types/git';

const DEFAULT_CLASS: Record<GitOpCategory, GitOpClass> = {
	commit: 'exclusive',
	staging: 'index',
	push: 'network',
	pull: 'exclusive',
	fetch: 'network',
	more: 'exclusive',
	stash: 'exclusive',
	tag: 'network',
	branch: 'exclusive',
	resolve: 'exclusive',
	configure: 'exclusive'
};

export interface GitOpSpec {
	category: GitOpCategory;
	label: string;
	target?: string;
	/** Override the category's class, e.g. deleting a remote branch is network work. */
	cls?: GitOpClass;
	/**
	 * Wait behind running operations of the same category instead of refusing.
	 * For per-file index writes: staging three files in quick succession is
	 * three requests the user meant, and git itself would refuse the overlap
	 * with an `index.lock` error. Anything else still refuses immediately.
	 */
	queue?: boolean;
}

export interface GitOpKey {
	/** Absolute working directory of the repository — the identity of the lock. */
	cwd: string;
	/** Workspace scope key, used to route the state to the right clients. */
	scope: string;
	/** Absolute nested-repo path as the client addresses it; absent for the root. */
	repoPath?: string;
}

/** Thrown when an operation is refused because a conflicting one is running. */
export class GitBusyError extends Error {
	constructor(readonly blocking: GitActiveOp) {
		super(
			`Git is busy: ${blocking.label}${blocking.target ? ` (${blocking.target})` : ''} is still running in this repository. Try again when it finishes.`
		);
		this.name = 'GitBusyError';
	}
}

interface RepoEntry {
	scope: string;
	repoPath?: string;
	ops: GitActiveOp[];
}

const repos = new Map<string, RepoEntry>();
const waiters = new Map<string, Array<() => void>>();
const listeners = new Set<(state: GitRepoOpState) => void>();
let nextId = 0;

function classesConflict(a: GitOpClass, b: GitOpClass): boolean {
	return a === 'exclusive' || b === 'exclusive' || a === b;
}

function snapshot(entry: RepoEntry): GitRepoOpState {
	return {
		scope: entry.scope,
		...(entry.repoPath && { repoPath: entry.repoPath }),
		ops: entry.ops.map(op => ({ ...op }))
	};
}

function notify(entry: RepoEntry): void {
	const state = snapshot(entry);
	for (const listener of listeners) {
		try {
			listener(state);
		} catch {
			// A broken listener must never wedge the lock it is observing.
		}
	}
}

/**
 * Run `fn` while holding an operation slot on the repository at `key.cwd`.
 * Throws `GitBusyError` without running anything when a conflicting operation
 * already holds the repository.
 */
export async function withGitOpLock<T>(key: GitOpKey, spec: GitOpSpec, fn: () => Promise<T>): Promise<T> {
	const cls = spec.cls ?? DEFAULT_CLASS[spec.category];
	let entry = repos.get(key.cwd);
	for (;;) {
		const blockers = entry?.ops.filter(op => classesConflict(op.cls, cls)) ?? [];
		if (blockers.length === 0) break;
		// Queue only behind operations of the same kind: three files resolved in a
		// row wait for each other, but nothing waits behind a pull.
		if (!spec.queue || blockers.some(op => op.category !== spec.category)) throw new GitBusyError(blockers[0]);
		await new Promise<void>(resolve => {
			const list = waiters.get(key.cwd) ?? [];
			list.push(resolve);
			waiters.set(key.cwd, list);
		});
		entry = repos.get(key.cwd);
	}

	if (!entry) {
		entry = { scope: key.scope, repoPath: key.repoPath, ops: [] };
		repos.set(key.cwd, entry);
	}
	const op: GitActiveOp = {
		id: `op-${++nextId}`,
		category: spec.category,
		cls,
		label: spec.label,
		...(spec.target && { target: spec.target }),
		startedAt: Date.now()
	};
	entry.ops.push(op);
	notify(entry);

	try {
		return await fn();
	} finally {
		const current = repos.get(key.cwd);
		if (current) {
			current.ops = current.ops.filter(o => o.id !== op.id);
			notify(current);
			if (current.ops.length === 0) repos.delete(key.cwd);
		}
		const queued = waiters.get(key.cwd);
		if (queued) {
			waiters.delete(key.cwd);
			for (const wake of queued) wake();
		}
	}
}

/** Every repository with a running operation in one workspace scope. */
export function getScopeOpStates(scope: string): GitRepoOpState[] {
	const states: GitRepoOpState[] = [];
	for (const entry of repos.values()) {
		if (entry.scope === scope && entry.ops.length > 0) states.push(snapshot(entry));
	}
	return states;
}

/** Whether any workspace of `projectId` has a git operation running. */
export function hasProjectOps(projectId: string): boolean {
	for (const entry of repos.values()) {
		if (entry.ops.length > 0 && scopeProjectId(entry.scope) === projectId) return true;
	}
	return false;
}

/** Subscribe to lock changes. Returns the unsubscribe function. */
export function onGitOpChange(listener: (state: GitRepoOpState) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
