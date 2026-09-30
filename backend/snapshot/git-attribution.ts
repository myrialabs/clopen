/**
 * Git's share of a turn's disk diff.
 *
 * A snapshot is a disk diff, so it cannot tell who changed a file. When the
 * user pulls, merges or switches branch while a turn is running, every file
 * git rewrote lands in that turn — one real case recorded a `git merge
 * origin/main` as 50 files "changed by the AI". Worse than the wrong count,
 * undoing that turn would have reverted the merge.
 *
 * The rule here: a change that moving HEAD explains belongs to git, not to the
 * turn, whoever typed the command. A file whose content at capture is exactly
 * the version git checked out is dropped from the turn. A file the turn edited
 * on top of git's version keeps only the turn's part — its "before" becomes
 * git's version, so undo reverts the edit and leaves the pull alone.
 *
 * Commits are the exception. `git commit` moves HEAD without touching the
 * working tree: the files it records were written by whoever edited them, so
 * reading a commit as git's own change would erase an agent's work the moment
 * it committed it. The reflog says which kind each HEAD move was.
 *
 * Every answer here fails towards "not explained". When the reflog is off, git
 * errors, or anything else is uncertain, the change stays in the turn —
 * over-reporting is visible and harmless, silently dropping a real edit is not.
 */

import path from 'path';
import fs from 'fs/promises';
import { execGit } from '../git/git-executor';
import { findNestedRepoPaths } from '../git/nested-repos';
import { blobStore } from './blob-store';
import type { SessionScopedChanges } from '$shared/types/database/schema';
import { debug } from '$shared/utils/logger';

/** Repository prefix ('' for the project root, `dir/` for a nested repo) → HEAD. */
export type RepoHeads = Map<string, string>;

export interface GitAttribution {
	/** Paths whose whole change is git's, not the turn's. */
	explained: Set<string>;
	/** Paths the turn changed on top of git: the corrected "before" hash. */
	rebased: Map<string, string>;
}

/** One HEAD move that rewrote the working tree. */
interface Transition {
	from: string;
	to: string;
}

/** Most paths passed to one git invocation — well under any argv limit. */
const PATH_BATCH = 200;

/** Reflog entries read per repository; a turn moving HEAD more is not plausible. */
const REFLOG_DEPTH = 200;

/** Pathspecs are literal: a file called `a[1].ts` must not act as a glob. */
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };

async function isRepo(dir: string): Promise<boolean> {
	try {
		await fs.access(path.join(dir, '.git'));
		return true;
	} catch {
		return false;
	}
}

async function readHead(repoDir: string): Promise<string | null> {
	try {
		const result = await execGit(['rev-parse', '--verify', '-q', 'HEAD'], repoDir, { okExitCodes: [1] });
		const sha = result.stdout.trim();
		return result.exitCode === 0 && sha ? sha : null;
	} catch {
		return null;
	}
}

/**
 * HEAD of the project and of every nested repository in it — the same set
 * of repositories the snapshot scan reads. An unborn or unreadable HEAD is
 * left out: there is nothing to compare it with later.
 */
export async function readRepoHeads(root: string): Promise<RepoHeads> {
	const heads: RepoHeads = new Map();

	const dirs: string[] = [];
	if (await isRepo(root)) dirs.push(root);
	try {
		dirs.push(...await findNestedRepoPaths(root));
	} catch (error) {
		debug.warn('snapshot', 'Nested repo discovery failed while reading HEADs:', error);
	}

	await Promise.all(dirs.map(async (dir) => {
		const head = await readHead(dir);
		if (!head) return;
		const relative = path.relative(root, dir).replace(/\\/g, '/');
		heads.set(relative ? `${relative}/` : '', head);
	}));

	return heads;
}

/**
 * Whether a reflog subject is a commit authored from the working tree.
 *
 * `commit (merge)` is not: it concludes a merge, and the content it records
 * came from the other branch.
 */
export function isAuthoredCommit(subject: string): boolean {
	return /^commit( \((initial|amend)\))?:/.test(subject);
}

/**
 * Parse `git log -g --date=unix --format=%H%x09%gd%x09%gs` output.
 * Newest first, as git prints it.
 */
export function parseReflog(stdout: string): Array<{ sha: string; time: number; subject: string }> {
	const entries: Array<{ sha: string; time: number; subject: string }> = [];
	for (const line of stdout.split('\n')) {
		const [sha, selector, ...rest] = line.split('\t');
		if (!sha || !selector) continue;
		const match = selector.match(/@\{(\d+)\}$/);
		if (!match) continue;
		entries.push({ sha, time: Number(match[1]), subject: rest.join('\t') });
	}
	return entries;
}

/**
 * The HEAD moves since `sinceMs` that rewrote the working tree, oldest first.
 *
 * The reflog stamps seconds, so the window opens a second early; an entry that
 * slips in from just before the turn only matters if it also touched a file
 * this turn changed, and then its version still has to match the disk.
 */
export function workingTreeTransitions(
	entries: Array<{ sha: string; time: number; subject: string }>,
	startSha: string,
	sinceMs: number
): Transition[] {
	const since = Math.floor(sinceMs / 1000) - 1;
	const window = [];
	for (const entry of entries) {
		if (entry.time < since) break;
		window.push(entry);
	}
	window.reverse();

	const transitions: Transition[] = [];
	let previous = startSha;
	for (const entry of window) {
		if (entry.sha !== previous && !isAuthoredCommit(entry.subject)) {
			transitions.push({ from: previous, to: entry.sha });
		}
		previous = entry.sha;
	}
	return transitions;
}

async function changedBetween(repoDir: string, from: string, to: string): Promise<string[]> {
	const result = await execGit(['diff', '--name-only', '-z', '--no-renames', from, to], repoDir, 60_000);
	if (result.exitCode !== 0) throw new Error(`git diff failed: ${result.stderr.trim()}`);
	return result.stdout.split('\0').filter(Boolean);
}

/** Blob id of each path at `sha`; a path missing from the map is absent there. */
async function treeBlobs(repoDir: string, sha: string, paths: string[]): Promise<Map<string, string>> {
	const blobs = new Map<string, string>();
	for (let i = 0; i < paths.length; i += PATH_BATCH) {
		const batch = paths.slice(i, i + PATH_BATCH);
		const result = await execGit(['ls-tree', '-r', '-z', sha, '--', ...batch], repoDir, { env: LITERAL });
		if (result.exitCode !== 0) throw new Error(`git ls-tree failed: ${result.stderr.trim()}`);
		for (const record of result.stdout.split('\0')) {
			const tab = record.indexOf('\t');
			if (tab === -1) continue;
			const [, type, object] = record.slice(0, tab).split(' ');
			if (type === 'blob') blobs.set(record.slice(tab + 1), object);
		}
	}
	return blobs;
}

/**
 * Git's blob id for each file as it is on disk now, with the repository's
 * clean filters applied — the id `git add` would give it. Comparing this with
 * a tree entry is exact, where comparing raw bytes would call every CRLF
 * checkout a modification.
 */
async function diskBlobs(repoDir: string, paths: string[]): Promise<Map<string, string>> {
	const blobs = new Map<string, string>();
	// --stdin-paths is newline-separated; a name containing one cannot be sent.
	const sendable = paths.filter((p) => !p.includes('\n'));
	for (let i = 0; i < sendable.length; i += PATH_BATCH) {
		const batch = sendable.slice(i, i + PATH_BATCH);
		const result = await execGit(['hash-object', '--stdin-paths'], repoDir, {
			stdin: batch.join('\n') + '\n'
		});
		if (result.exitCode !== 0) throw new Error(`git hash-object failed: ${result.stderr.trim()}`);
		const ids = result.stdout.split('\n').filter(Boolean);
		if (ids.length !== batch.length) throw new Error('git hash-object returned a short list');
		batch.forEach((p, index) => blobs.set(p, ids[index]));
	}
	return blobs;
}

/** Store git's checked-out version of a file and return its snapshot hash. */
async function storeGitVersion(repoDir: string, sha: string, repoPath: string): Promise<string> {
	const result = await execGit(['cat-file', '--filters', `${sha}:${repoPath}`], repoDir, { raw: true });
	if (result.exitCode !== 0 || !result.stdoutBytes) {
		throw new Error(`git cat-file failed: ${result.stderr.trim()}`);
	}
	return blobStore.storeBlob(result.stdoutBytes);
}

/**
 * Split a turn's changes into git's part and the turn's part.
 *
 * `startHeads` and `sinceMs` are what the turn recorded when it began.
 */
export async function attributeGitChanges(
	root: string,
	startHeads: RepoHeads,
	sinceMs: number,
	changes: SessionScopedChanges
): Promise<GitAttribution> {
	const attribution: GitAttribution = { explained: new Set(), rebased: new Map() };
	const changedPaths = Object.keys(changes);
	if (changedPaths.length === 0 || startHeads.size === 0) return attribution;

	// Longest prefix first, so a file inside a nested repo is never claimed by
	// the outer one.
	const prefixes = [...startHeads.keys()].sort((a, b) => b.length - a.length);
	const byRepo = new Map<string, string[]>();
	for (const changed of changedPaths) {
		const prefix = prefixes.find((p) => changed.startsWith(p));
		if (prefix === undefined) continue;
		const list = byRepo.get(prefix) ?? [];
		list.push(changed.slice(prefix.length));
		byRepo.set(prefix, list);
	}

	for (const [prefix, repoPaths] of byRepo) {
		const repoDir = path.join(root, prefix);
		const startSha = startHeads.get(prefix)!;
		try {
			const endSha = await readHead(repoDir);
			if (!endSha || endSha === startSha) continue;

			const reflog = await execGit(
				['log', '-g', '--date=unix', '--format=%H%x09%gd%x09%gs', '-n', String(REFLOG_DEPTH), 'HEAD'],
				repoDir,
				30_000
			);
			if (reflog.exitCode !== 0) continue;
			const transitions = workingTreeTransitions(parseReflog(reflog.stdout), startSha, sinceMs);
			if (transitions.length === 0) continue;

			// The version git last wrote for each path, and which commit holds it.
			const lastVersion = new Map<string, string>();
			for (const transition of transitions) {
				for (const touched of await changedBetween(repoDir, transition.from, transition.to)) {
					lastVersion.set(touched, transition.to);
				}
			}

			const candidates = repoPaths.filter((p) => lastVersion.has(p));
			if (candidates.length === 0) continue;

			const bySha = new Map<string, string[]>();
			for (const candidate of candidates) {
				const sha = lastVersion.get(candidate)!;
				bySha.set(sha, [...(bySha.get(sha) ?? []), candidate]);
			}
			const gitBlobs = new Map<string, string>();
			for (const [sha, paths] of bySha) {
				for (const [p, blob] of await treeBlobs(repoDir, sha, paths)) gitBlobs.set(p, blob);
			}

			const onDisk = candidates.filter((p) => changes[prefix + p].newHash !== '');
			const current = await diskBlobs(repoDir, onDisk);

			for (const candidate of candidates) {
				const key = prefix + candidate;
				const change = changes[key];
				const gitBlob = gitBlobs.get(candidate);
				const diskBlob = change.newHash ? current.get(candidate) : undefined;
				if (change.newHash && diskBlob === undefined) continue;

				if (gitBlob === diskBlob) {
					attribution.explained.add(key);
					continue;
				}

				const gitHash = gitBlob
					? await storeGitVersion(repoDir, lastVersion.get(candidate)!, candidate)
					: '';
				if (gitHash !== change.oldHash) attribution.rebased.set(key, gitHash);
			}
		} catch (error) {
			debug.warn('snapshot', `Git attribution skipped for ${repoDir || root}:`, error);
		}
	}

	return attribution;
}
