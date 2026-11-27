/**
 * Git: the working tree, the index, one file's diff, a commit, a branch's
 * difference from another, a stash, the files left in conflict.
 *
 * Always the repository of the workspace on screen (the project, or the
 * worktree being viewed). Every snapshot is git's own text output — the
 * format models already read best.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type { MentionCandidate } from '$shared/types/mentions';
import { buildContextDocument, countLines, type ContextSection } from '$shared/utils/context-document';
import { assertSafeGitPathOperand, assertSafeGitRevish } from '$backend/git/git-spawn-validation';
import { ago, gitText, rank, wants } from '../shared';
import { refOptional, refString, type MentionContext, type MentionSource } from '../types';

const GIT = 'git';
const COMMITS = 'git-commits';
const BRANCHES = 'git-branches';

const STATUS_TTL_MS = 2000;

interface StatusEntry {
	path: string;
	index: string;
	work: string;
}

interface RepoState {
	isRepo: boolean;
	branch: string | null;
	entries: StatusEntry[];
}

const statusCache = new Map<string, { at: number; state: Promise<RepoState> }>();

/** `git status`, reused across the keystrokes of one search. */
function repoState(root: string): Promise<RepoState> {
	const hit = statusCache.get(root);
	if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.state;
	const state = (async (): Promise<RepoState> => {
		const out = await gitText(['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'], root, 10_000);
		if (out === null) return { isRepo: false, branch: null, entries: [] };
		const records = out.split('\0');
		let branch: string | null = null;
		const entries: StatusEntry[] = [];
		for (let i = 0; i < records.length; i++) {
			const record = records[i];
			if (!record) continue;
			if (record.startsWith('## ')) {
				branch = record.slice(3).split('...')[0].replace(/^No commits yet on /, '') || null;
				continue;
			}
			const entry = { index: record[0], work: record[1], path: record.slice(3) };
			// A rename is followed by its old path.
			if (entry.index === 'R' || entry.index === 'C') i++;
			entries.push(entry);
		}
		return { isRepo: true, branch, entries };
	})();
	statusCache.set(root, { at: Date.now(), state });
	return state;
}

const isConflict = (entry: StatusEntry) =>
	entry.index === 'U' || entry.work === 'U' || (entry.index === 'A' && entry.work === 'A') || (entry.index === 'D' && entry.work === 'D');
const isStaged = (entry: StatusEntry) => entry.index !== ' ' && entry.index !== '?' && !isConflict(entry);
const isUnstaged = (entry: StatusEntry) => entry.work !== ' ' && !isConflict(entry);

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The rows that describe the working tree right now. */
async function stateRows(ctx: MentionContext): Promise<MentionCandidate[]> {
	const state = await repoState(ctx.root);
	if (!state.isRepo) return [];
	const rows: MentionCandidate[] = [];
	const unstaged = state.entries.filter(isUnstaged);
	const staged = state.entries.filter(isStaged);
	const conflicts = state.entries.filter(isConflict);
	if (unstaged.length) {
		rows.push({
			key: 'git-changes', kind: 'git-changes', group: 'Git', label: 'Working changes',
			detail: `${plural(unstaged.length, 'file')} not staged`, icon: 'lucide:file-diff', ref: {}
		});
	}
	if (staged.length) {
		rows.push({
			key: 'git-staged', kind: 'git-staged', group: 'Git', label: 'Staged changes',
			detail: plural(staged.length, 'file'), icon: 'lucide:git-commit-horizontal', ref: {}
		});
	}
	if (conflicts.length) {
		rows.push({
			key: 'git-conflicts', kind: 'git-conflicts', group: 'Git', label: 'Merge conflicts',
			detail: `${plural(conflicts.length, 'file')} in conflict`, icon: 'lucide:git-merge', ref: {}
		});
	}
	return rows;
}

function fileRows(state: RepoState): MentionCandidate[] {
	const rows: MentionCandidate[] = [];
	for (const entry of state.entries) {
		if (isConflict(entry)) continue;
		if (isStaged(entry)) {
			rows.push({
				key: `git-file:staged:${entry.path}`, kind: 'git-file', group: 'Changed files', label: entry.path,
				detail: `staged · ${describeStatus(entry.index)}`, icon: 'lucide:file-diff', ref: { path: entry.path, staged: true }
			});
		}
		if (isUnstaged(entry)) {
			rows.push({
				key: `git-file:work:${entry.path}`, kind: 'git-file', group: 'Changed files', label: entry.path,
				detail: entry.work === '?' ? 'untracked' : describeStatus(entry.work), icon: 'lucide:file-diff',
				ref: { path: entry.path, staged: false, untracked: entry.work === '?' }
			});
		}
	}
	return rows;
}

function describeStatus(code: string): string {
	return ({ M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' } as Record<string, string>)[code] ?? 'changed';
}

async function commitRows(root: string, query: string, limit: number): Promise<MentionCandidate[]> {
	const out = await gitText(['log', '-n', '300', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI'], root, 10_000);
	if (!out) return [];
	const commits = out.split('\n').filter(Boolean).map((line) => {
		const [hash, short, subject, author, date] = line.split('\x1f');
		return { hash, short, subject, author, date };
	});
	return rank(commits, query, (commit) => [commit.subject, commit.short, commit.hash, commit.author], limit).map((commit) => ({
		key: `git-commit:${commit.hash}`, kind: 'git-commit', group: 'Commits', label: commit.subject || commit.short,
		detail: `${commit.short} · ${commit.author} · ${ago(commit.date)}`, icon: 'lucide:git-commit-horizontal',
		ref: { hash: commit.hash }
	}));
}

async function branchRows(root: string, current: string | null, query: string, limit: number): Promise<MentionCandidate[]> {
	const out = await gitText(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], root, 10_000);
	if (!out) return [];
	const branches = out.split('\n').filter((name) => name && name !== current && !name.endsWith('/HEAD'));
	return rank(branches, query, (name) => [name], limit).map((name) => ({
		key: `git-branch:${name}`, kind: 'git-branch', group: 'Branches', label: `${current ?? 'HEAD'} compared with ${name}`,
		detail: 'Commits and changes since they diverged', icon: 'lucide:git-compare', ref: { base: name }
	}));
}

async function stashRows(root: string): Promise<MentionCandidate[]> {
	const out = await gitText(['stash', 'list', '--format=%gd%x1f%s%x1f%cI'], root, 10_000);
	if (!out) return [];
	return out.split('\n').filter(Boolean).map((line) => {
		const [ref, subject, date] = line.split('\x1f');
		return {
			key: `git-stash:${ref}`, kind: 'git-stash' as const, group: 'Stashes', label: subject || ref,
			detail: `${ref} · ${ago(date)}`, icon: 'lucide:archive' as const, ref: { stash: ref }
		};
	});
}

function diffSection(title: string, diff: string | null): ContextSection {
	return { title, body: diff?.trim() ? diff : 'No differences.', fence: 'diff' };
}

export const gitSource: MentionSource = {
	kinds: ['git-changes', 'git-staged', 'git-file', 'git-commit', 'git-branch', 'git-stash', 'git-conflicts'],

	async categories(ctx) {
		const state = await repoState(ctx.root);
		if (!state.isRepo) return [];
		return [
			{ id: GIT, label: 'Git changes', detail: state.entries.length ? plural(state.entries.length, 'changed file') : 'Clean', icon: 'lucide:file-diff', group: 'Git' },
			{ id: COMMITS, label: 'Commits', detail: state.branch ? `History of ${state.branch}` : 'History of this branch', icon: 'lucide:git-commit-horizontal', group: 'Git' },
			{ id: BRANCHES, label: 'Branches', detail: 'Compare with another branch', icon: 'lucide:git-branch', group: 'Git' }
		];
	},

	async list(ctx, request) {
		const query = request.query;
		if (!request.category) {
			const rows = await stateRows(ctx);
			if (!query.trim()) return rows;
			// Typing a hash finds its commit straight from the root.
			const commits = /^[0-9a-f]{5,40}$/i.test(query.trim()) ? await commitRows(ctx.root, query, 2) : [];
			return [...rank(rows, query, (row) => [row.label, 'git', 'diff'], 3), ...commits];
		}
		if (wants(request.category, GIT) === 'own') {
			const state = await repoState(ctx.root);
			const rows = [...(await stateRows(ctx)), ...fileRows(state), ...(await stashRows(ctx.root))];
			return rank(rows, query, (row) => [row.label, row.detail], request.limit);
		}
		if (wants(request.category, COMMITS) === 'own') return commitRows(ctx.root, query, request.limit);
		if (wants(request.category, BRANCHES) === 'own') {
			const state = await repoState(ctx.root);
			return branchRows(ctx.root, state.branch, query, request.limit);
		}
		return [];
	},

	async capture(ctx, kind, ref) {
		const root = ctx.root;
		const state = await repoState(root);
		if (!state.isRepo) throw new Error('This project is not a git repository');
		statusCache.delete(root);
		const branchFact: [string, string | null] = ['Branch', state.branch];

		switch (kind) {
			case 'git-changes': {
				const status = await gitText(['status', '--short'], root);
				const diff = await gitText(['diff'], root, 60_000);
				return {
					documents: [buildContextDocument({
						kind, label: 'Working changes', detail: countLines(diff ?? ''), facts: [branchFact],
						sections: [{ title: 'Status', body: status ?? '', fence: '' }, diffSection('Unstaged diff', diff)]
					})]
				};
			}
			case 'git-staged': {
				const diff = await gitText(['diff', '--cached'], root, 60_000);
				return {
					documents: [buildContextDocument({
						kind, label: 'Staged changes', detail: countLines(diff ?? ''), facts: [branchFact],
						sections: [diffSection('Staged diff', diff)]
					})]
				};
			}
			case 'git-file': {
				const path = refString(ref, 'path');
				assertSafeGitPathOperand(path, 'diff path');
				const diff = ref.untracked
					? await gitText(['diff', '--no-index', '--', '/dev/null', path], root, 30_000, [1])
					: await gitText(ref.staged ? ['diff', '--cached', '--', path] : ['diff', '--', path], root, 30_000);
				return {
					documents: [buildContextDocument({
						kind, label: path, detail: ref.staged ? 'staged' : ref.untracked ? 'untracked' : 'not staged',
						facts: [branchFact, ['File', path]], sections: [diffSection('Diff', diff)]
					})]
				};
			}
			case 'git-commit': {
				const hash = refString(ref, 'hash');
				assertSafeGitRevish(hash, 'commit hash');
				const shown = await gitText(['show', '--stat', '--patch', '--format=fuller', hash], root, 60_000);
				if (shown === null) throw new Error('That commit was not found');
				const subject = (await gitText(['log', '-1', '--format=%s', hash], root))?.trim() || hash.slice(0, 7);
				return {
					documents: [buildContextDocument({
						kind, label: subject, detail: hash.slice(0, 12), facts: [['Commit', hash]],
						sections: [{ title: 'Commit', body: shown, fence: 'diff' }]
					})]
				};
			}
			case 'git-branch': {
				const base = refString(ref, 'base');
				assertSafeGitRevish(base, 'branch');
				const head = state.branch ?? 'HEAD';
				const log = await gitText(['log', '--oneline', `${base}..HEAD`], root, 30_000);
				const diff = await gitText(['diff', `${base}...HEAD`], root, 60_000);
				return {
					documents: [buildContextDocument({
						kind, label: `${head} vs ${base}`, detail: plural((log ?? '').split('\n').filter(Boolean).length, 'commit'),
						facts: [['Branch', head], ['Compared with', base]],
						sections: [{ title: `Commits on ${head} not on ${base}`, body: log ?? '', fence: '' }, diffSection('Diff', diff)]
					})]
				};
			}
			case 'git-stash': {
				const stash = refString(ref, 'stash');
				if (!/^stash@\{\d+\}$/.test(stash)) throw new Error('Not a stash');
				const diff = await gitText(['stash', 'show', '-p', '--include-untracked', stash], root, 30_000)
					?? await gitText(['stash', 'show', '-p', stash], root, 30_000);
				return {
					documents: [buildContextDocument({
						kind, label: refOptional(ref, 'label') ?? stash, detail: stash, facts: [branchFact],
						sections: [diffSection('Stashed changes', diff)]
					})]
				};
			}
			case 'git-conflicts': {
				const conflicted = state.entries.filter(isConflict).map((entry) => entry.path);
				const sections: ContextSection[] = [];
				for (const path of conflicted) {
					let body: string;
					try {
						body = await readFile(join(root, path), 'utf8');
					} catch {
						body = '(deleted on one side)';
					}
					sections.push({ title: path, body, fence: '' });
				}
				const operation = await gitText(['rev-parse', '--verify', '-q', 'MERGE_HEAD'], root) ? 'merge'
					: await gitText(['rev-parse', '--verify', '-q', 'REBASE_HEAD'], root) ? 'rebase' : 'operation';
				return {
					documents: [buildContextDocument({
						kind, label: 'Merge conflicts', detail: plural(conflicted.length, 'file'),
						facts: [branchFact, ['In progress', operation], ['Files', conflicted.join(', ')]], sections
					})]
				};
			}
			default:
				throw new Error(`Git cannot capture ${kind}`);
		}
	}
};
