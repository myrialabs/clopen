/**
 * Git Service
 * High-level git operations built on top of executor and parser
 */

import { execGit, isGitRepo, getGitRoot } from './git-executor';
import { resolveBinary } from '../utils/cli';
import { getCleanSpawnEnv } from '../utils/env';
import {
	parseStatus,
	parseBranches,
	parseAheadBehind,
	parseDiff,
	parseLog,
	parseRemotes,
	parseStashList,
	parseConflictMarkers
} from './git-parser';
import type {
	GitStatus,
	GitBranchInfo,
	GitOperation,
	GitFileDiff,
	GitLogResult,
	GitRemote,
	GitStashEntry,
	GitConflictFile
} from '$shared/types/git';
import { debug } from '$shared/utils/logger';
import {
	assertSafeGitCommitMessage,
	assertSafeGitPathOperand,
	assertSafeGitRemoteName,
	assertSafeGitRemoteUrl,
	assertSafeGitRevish,
	assertSafeGitShowRef
} from './git-spawn-validation';
import { findNestedRepoPaths, findSubmodulePaths } from '../snapshot/gitignore';
import path from 'node:path';

export class GitService {
	/**
	 * Check if path is a git repo
	 */
	async isRepo(cwd: string): Promise<boolean> {
		return isGitRepo(cwd);
	}

	/**
	 * Get repository root
	 */
	async getRoot(cwd: string): Promise<string | null> {
		return getGitRoot(cwd);
	}

	/**
	 * Initialize a new git repository
	 */
	async init(cwd: string, defaultBranch?: string): Promise<void> {
		const args = ['init'];
		if (defaultBranch) {
			assertSafeGitRevish(defaultBranch, 'default branch');
			args.push('-b', defaultBranch);
		}
		const result = await execGit(args, cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git init failed: ${result.stderr}`);
		}
	}

	// ============================================
	// Status
	// ============================================

	async getStatus(cwd: string): Promise<GitStatus> {
		const result = await execGit(['status', '--porcelain=v1', '-u'], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git status failed: ${result.stderr}`);
		}
		return parseStatus(result.stdout);
	}

	// ============================================
	// Staging
	// ============================================

	async stageFile(cwd: string, filePath: string): Promise<void> {
		assertSafeGitPathOperand(filePath, 'stage path');
		const result = await execGit(['add', '--', filePath], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git add failed: ${result.stderr}`);
		}
	}

	async stageAll(cwd: string): Promise<void> {
		const result = await execGit(['add', '-A'], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git add -A failed: ${result.stderr}`);
		}
	}

	async unstageFile(cwd: string, filePath: string): Promise<void> {
		assertSafeGitPathOperand(filePath, 'unstage path');
		// Try normal reset first, fall back to rm --cached for initial commit
		const result = await execGit(['reset', 'HEAD', '--', filePath], cwd);
		if (result.exitCode !== 0) {
			const fallback = await execGit(['rm', '--cached', '--', filePath], cwd); // filePath validated above
			if (fallback.exitCode !== 0) {
				throw new Error(`git unstage failed: ${result.stderr}`);
			}
		}
	}

	async unstageAll(cwd: string): Promise<void> {
		// Try normal reset first, fall back to rm --cached for initial commit
		const result = await execGit(['reset', 'HEAD'], cwd);
		if (result.exitCode !== 0) {
			const fallback = await execGit(['rm', '-r', '--cached', '.'], cwd);
			if (fallback.exitCode !== 0) {
				throw new Error(`git unstage all failed: ${result.stderr}`);
			}
		}
	}

	async discardFile(cwd: string, filePath: string): Promise<void> {
		assertSafeGitPathOperand(filePath, 'discard path');
		// Check if file is untracked
		const statusResult = await execGit(['status', '--porcelain=v1', '--', filePath], cwd);
		const statusLine = statusResult.stdout.trim();

		if (statusLine.startsWith('??')) {
			// Untracked file - delete it
			const { unlink } = await import('node:fs/promises');
			const { join } = await import('node:path');
			await unlink(join(cwd, filePath));
		} else {
			// Tracked file - restore it
			const result = await execGit(['checkout', '--', filePath], cwd);
			if (result.exitCode !== 0) {
				throw new Error(`git checkout failed: ${result.stderr}`);
			}
		}
	}

	async discardAll(cwd: string): Promise<void> {
		// Restore tracked files
		await execGit(['checkout', '--', '.'], cwd);
		// Remove untracked files
		await execGit(['clean', '-fd'], cwd);
	}

	// ============================================
	// Commit
	// ============================================

	async commit(cwd: string, message: string): Promise<string> {
		assertSafeGitCommitMessage(message);
		const result = await execGit(['commit', '-m', message], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git commit failed: ${result.stderr}`);
		}
		// Return the commit hash
		const hashResult = await execGit(['rev-parse', 'HEAD'], cwd);
		return hashResult.stdout.trim();
	}

	async amendCommit(cwd: string, message?: string): Promise<string> {
		const args = ['commit', '--amend'];
		if (message) {
			assertSafeGitCommitMessage(message);
			args.push('-m', message);
		} else {
			args.push('--no-edit');
		}
		const result = await execGit(args, cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git commit --amend failed: ${result.stderr}`);
		}
		const hashResult = await execGit(['rev-parse', 'HEAD'], cwd);
		return hashResult.stdout.trim();
	}

	// ============================================
	// Diff
	// ============================================

	async getDiffUnstaged(cwd: string, filePath?: string): Promise<GitFileDiff[]> {
		const args = ['diff'];
		if (filePath) {
			assertSafeGitPathOperand(filePath, 'diff path');
			args.push('--', filePath);
		}
		const result = await execGit(args, cwd);
		return parseDiff(result.stdout);
	}

	async getDiffStaged(cwd: string, filePath?: string): Promise<GitFileDiff[]> {
		const args = ['diff', '--cached'];
		if (filePath) {
			assertSafeGitPathOperand(filePath, 'diff path');
			args.push('--', filePath);
		}
		const result = await execGit(args, cwd);
		return parseDiff(result.stdout);
	}

	async getDiffCommit(cwd: string, commitHash: string): Promise<GitFileDiff[]> {
		assertSafeGitRevish(commitHash, 'commit hash');
		// Root commits have no parent, so `<hash>^` can't resolve and `git diff`
		// fails silently (empty stdout) — which previously surfaced as "No files
		// changed". Detect the parentless case and diff against the empty tree via
		// `diff-tree --root` so the initial commit's files show up as additions.
		// Commits with a parent (including merges) keep the original behaviour.
		const hasParent =
			(await execGit(['rev-parse', '--verify', '--quiet', `${commitHash}^`], cwd)).exitCode === 0;
		const result = hasParent
			? await execGit(['diff', `${commitHash}^`, commitHash], cwd)
			: await execGit(['diff-tree', '-p', '--root', '--no-commit-id', commitHash], cwd);
		return parseDiff(result.stdout);
	}

	async getDiffBetween(cwd: string, from: string, to: string): Promise<GitFileDiff[]> {
		assertSafeGitRevish(from, 'diff from');
		assertSafeGitRevish(to, 'diff to');
		const result = await execGit(['diff', from, to], cwd);
		return parseDiff(result.stdout);
	}

	/**
	 * Read a file's content at a specific git ref (e.g. HEAD).
	 * Returns null when the file does not exist at that ref (untracked / new file).
	 */
	async getFileAtRef(cwd: string, ref: string, filePath: string): Promise<string | null> {
		assertSafeGitShowRef(ref);
		assertSafeGitPathOperand(filePath, 'show path');
		const result = await execGit(['show', `${ref}:${filePath}`], cwd);
		if (result.exitCode !== 0) {
			return null;
		}
		return result.stdout;
	}

	// ============================================
	// Branches
	// ============================================

	async getBranches(cwd: string, selectedRemote?: string): Promise<GitBranchInfo> {
		// `git for-each-ref` lets us pull the committer date alongside the
		// short hash and subject in a single call per ref namespace, which
		// the old `git branch -v` output doesn't expose. Format:
		//   `HEAD|short-name|short-hash|subject|iso-date`
		// where `HEAD` is `*` for the current branch and ` ` for others.
		// `iso-date` is strict ISO 8601 so it can't collide with the `|`
		// separators — the parser uses `lastIndexOf('|')` to extract it.
		const localFmt = '%(HEAD)|%(refname:short)|%(objectname:short)|%(subject)|%(committerdate:iso8601)';
		const remoteFmt = '%(refname:short)|%(objectname:short)|%(subject)|%(committerdate:iso8601)';
		const [localResult, remoteResult, headRef] = await Promise.all([
			execGit(['for-each-ref', `--format=${localFmt}`, 'refs/heads/'], cwd),
			execGit(['for-each-ref', `--format=${remoteFmt}`, 'refs/remotes/'], cwd),
			execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
		]);

		// Handle empty repo (no commits yet) — for-each-ref returns empty
		if (!localResult.stdout.trim()) {
			// Try to get the initial branch name from HEAD
			const headResult = await execGit(['symbolic-ref', '--short', 'HEAD'], cwd);
			const initialBranch = headResult.exitCode === 0 ? headResult.stdout.trim() : 'main';
			return { current: initialBranch, local: [], remote: [], ahead: 0, behind: 0 };
		}

		const branchInfo = parseBranches(localResult.stdout, remoteResult.stdout);
		branchInfo.operation = await this.detectGitOperation(cwd);

		// Resolve the current branch authoritatively instead of trusting the parsed
		// `git branch -v` text: while HEAD is detached (rebase, bisect, or a detached
		// checkout) git prints a parenthesized pseudo-ref, which previously leaked
		// through as a bogus "(no" branch name.
		const headName = headRef.exitCode === 0 ? headRef.stdout.trim() : '';
		if (headName === '' || headName === 'HEAD') {
			// Detached HEAD — show a clean short hash, never a real branch.
			branchInfo.detached = true;
			const shortHash = await execGit(['rev-parse', '--short', 'HEAD'], cwd);
			branchInfo.current = shortHash.exitCode === 0 ? shortHash.stdout.trim() : '';
			for (const b of branchInfo.local) b.isCurrent = false;
			return branchInfo;
		}

		branchInfo.detached = false;
		branchInfo.current = headName;
		for (const b of branchInfo.local) b.isCurrent = b.name === headName;

		// Get ahead/behind for current branch relative to the SELECTED remote
		if (branchInfo.current && selectedRemote) {
			try {
				const remoteRef = `${selectedRemote}/${branchInfo.current}`;
				const abResult = await execGit(
					['rev-list', '--left-right', '--count', `${branchInfo.current}...${remoteRef}`],
					cwd
				);
				if (abResult.exitCode === 0) {
					const { ahead, behind } = parseAheadBehind(abResult.stdout);
					branchInfo.ahead = ahead;
					branchInfo.behind = behind;

					const currentBranch = branchInfo.local.find(b => b.isCurrent);
					if (currentBranch) {
						currentBranch.ahead = ahead;
						currentBranch.behind = behind;
					}
				}
			} catch {
				// Remote tracking branch doesn't exist — show 0
			}
		}

		// Discover nested git repos (submodules, gitignored embedded repos,
		// worktrees) and aggregate their branch info so the Branches tab can
		// render one collapsible group per sub-repo. Failures in a single
		// nested repo must not break the outer result — we record the error
		// on the entry and move on.
		try {
			const [nestedPaths, submodulePaths] = await Promise.all([
				findNestedRepoPaths(cwd),
				findSubmodulePaths(cwd)
			]);
			if (nestedPaths.length > 0) {
				const nestedResults = await Promise.all(
					nestedPaths.map(async (repoPath) => {
						const relPath = path.relative(cwd, repoPath).replace(/\\/g, '/');
						const isSubmodule = submodulePaths.has(relPath);
						try {
							const info = await this.getBranches(repoPath, selectedRemote);
							return { path: repoPath, relPath, isSubmodule, info };
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							return {
								path: repoPath,
								relPath,
								isSubmodule,
								info: { current: '', local: [], remote: [], ahead: 0, behind: 0 },
								error: message
							};
						}
					})
				);
				// Stable order for the UI (sorted by relPath).
				nestedResults.sort((a, b) => a.relPath.localeCompare(b.relPath));
				branchInfo.nested = nestedResults;
			}
		} catch (err) {
			debug.warn('git', `Failed to enumerate nested repos: ${err instanceof Error ? err.message : String(err)}`);
		}

		return branchInfo;
	}

	async createBranch(cwd: string, name: string, startPoint?: string): Promise<void> {
		assertSafeGitRevish(name, 'branch name');
		const args = ['checkout', '-b', name];
		if (startPoint) {
			assertSafeGitRevish(startPoint, 'start point');
			args.push(startPoint);
		}
		const result = await execGit(args, cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git checkout -b failed: ${result.stderr}`);
		}
	}

	async switchBranch(cwd: string, name: string): Promise<void> {
		assertSafeGitRevish(name, 'branch name');
		const result = await execGit(['checkout', name], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git checkout failed: ${result.stderr}`);
		}
	}

	async checkoutCommit(cwd: string, commitHash: string): Promise<void> {
		assertSafeGitRevish(commitHash, 'commit hash');
		const result = await execGit(['checkout', commitHash], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git checkout failed: ${result.stderr}`);
		}
	}

	async deleteBranch(cwd: string, name: string, force = false): Promise<void> {
		assertSafeGitRevish(name, 'branch name');
		const flag = force ? '-D' : '-d';
		const result = await execGit(['branch', flag, name], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git branch ${flag} failed: ${result.stderr}`);
		}
	}

	async renameBranch(cwd: string, oldName: string, newName: string): Promise<void> {
		assertSafeGitRevish(oldName, 'old branch name');
		assertSafeGitRevish(newName, 'new branch name');
		const result = await execGit(['branch', '-m', oldName, newName], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git branch -m failed: ${result.stderr}`);
		}
	}

	async deleteRemoteBranch(cwd: string, remote: string, branch: string): Promise<void> {
		assertSafeGitRevish(remote, 'remote name');
		assertSafeGitRevish(branch, 'branch name');
		const result = await execGit(['push', remote, '--delete', branch], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git push --delete failed: ${result.stderr}`);
		}
	}

	async mergeBranch(cwd: string, branchName: string, noFastForward = false): Promise<{ success: boolean; message: string }> {
		assertSafeGitRevish(branchName, 'merge branch');
		const args = ['merge'];
		if (noFastForward) args.push('--no-ff');
		args.push(branchName);
		const result = await execGit(args, cwd);
		return {
			success: result.exitCode === 0,
			message: result.exitCode === 0 ? result.stdout : result.stderr
		};
	}

	// ============================================
	// Log
	// ============================================

	async getLog(cwd: string, limit = 50, skip = 0, branch?: string): Promise<GitLogResult> {
		const SEPARATOR = '|||';
		const format = `%H${SEPARATOR}%h${SEPARATOR}%an${SEPARATOR}%ae${SEPARATOR}%aI${SEPARATOR}%P${SEPARATOR}%D%n%s%x00`;

		const args = [
			'log',
			'--topo-order',
			`--format=${format}`,
			`--max-count=${limit + 1}`, // +1 to check if there are more
			`--skip=${skip}`
		];

		if (branch) {
			assertSafeGitRevish(branch, 'log branch');
			args.push(branch);
		}

		const result = await execGit(args, cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git log failed: ${result.stderr}`);
		}

		const commits = parseLog(result.stdout);
		const hasMore = commits.length > limit;
		if (hasMore) commits.pop(); // Remove the extra one

		// Get total count
		const countRef = branch ?? 'HEAD';
		const countResult = await execGit(['rev-list', '--count', countRef], cwd);
		const total = parseInt(countResult.stdout.trim()) || commits.length;

		return { commits, total, hasMore };
	}

	// ============================================
	// Remote Operations
	// ============================================

	async getRemotes(cwd: string): Promise<GitRemote[]> {
		const result = await execGit(['remote', '-v'], cwd);
		return parseRemotes(result.stdout);
	}

	async fetch(cwd: string, remote = 'origin'): Promise<string> {
		assertSafeGitRemoteName(remote);
		// Use explicit refspec to ensure all branches are fetched regardless of clone config
		const result = await execGit(['fetch', remote, `+refs/heads/*:refs/remotes/${remote}/*`, '--prune'], cwd, 60000);
		if (result.exitCode !== 0) {
			throw new Error(`git fetch failed: ${result.stderr}`);
		}
		return result.stderr || result.stdout; // git fetch outputs to stderr
	}

	async pull(cwd: string, remote = 'origin', branch?: string, rebase = false): Promise<{ success: boolean; message: string }> {
		assertSafeGitRemoteName(remote);
		const args = ['pull'];
		if (rebase) args.push('--rebase');
		args.push(remote);
		if (branch) {
			assertSafeGitRevish(branch, 'pull branch');
			args.push(branch);
		}
		const result = await execGit(args, cwd, 60000);
		return {
			success: result.exitCode === 0,
			message: result.exitCode === 0 ? result.stdout : result.stderr
		};
	}

	async push(cwd: string, remote = 'origin', branch?: string, force = false): Promise<{ success: boolean; message: string }> {
		assertSafeGitRemoteName(remote);
		const args = ['push', remote];
		if (branch) {
			assertSafeGitRevish(branch, 'push branch');
			args.push(branch);
		}
		if (force) args.push('--force-with-lease');
		// Set upstream if needed
		args.push('-u');
		const result = await execGit(args, cwd, 60000);
		return {
			success: result.exitCode === 0,
			message: result.exitCode === 0 ? (result.stderr || result.stdout) : result.stderr
		};
	}

	/**
	 * Advanced push variants surfaced in the "More" menu:
	 *  - `with-tags`    → push branch + reachable annotated tags (--follow-tags)
	 *  - `all-tags`     → push all local tags (--tags), no branch
	 *  - `force-lease`  → safe force push (--force-with-lease)
	 *  - `force`        → unconditional force push (--force)
	 */
	async pushAdvanced(
		cwd: string,
		mode: 'with-tags' | 'all-tags' | 'force-lease' | 'force',
		remote = 'origin',
		branch?: string
	): Promise<{ success: boolean; message: string }> {
		assertSafeGitRemoteName(remote);
		const args = ['push', remote];
		if (mode === 'all-tags') {
			args.push('--tags');
		} else {
			if (branch) {
				assertSafeGitRevish(branch, 'push branch');
				args.push(branch);
			}
			if (mode === 'with-tags') args.push('--follow-tags');
			else if (mode === 'force-lease') args.push('--force-with-lease');
			else if (mode === 'force') args.push('--force');
			args.push('-u');
		}
		const result = await execGit(args, cwd, 60000);
		return {
			success: result.exitCode === 0,
			message: result.exitCode === 0 ? (result.stderr || result.stdout) : result.stderr
		};
	}

	/** Fetch every configured remote and prune deleted remote-tracking refs. */
	async fetchAll(cwd: string): Promise<string> {
		const result = await execGit(['fetch', '--all', '--prune', '--tags'], cwd, 60000);
		if (result.exitCode !== 0) {
			throw new Error(`git fetch --all failed: ${result.stderr}`);
		}
		return result.stderr || result.stdout;
	}

	async addRemote(cwd: string, name: string, url: string): Promise<void> {
		assertSafeGitRemoteName(name);
		assertSafeGitRemoteUrl(url);
		const result = await execGit(['remote', 'add', name, url], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git remote add failed: ${result.stderr}`);
		}
	}

	async setRemoteUrl(cwd: string, name: string, url: string): Promise<void> {
		assertSafeGitRemoteName(name);
		assertSafeGitRemoteUrl(url);
		const result = await execGit(['remote', 'set-url', name, url], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git remote set-url failed: ${result.stderr}`);
		}
	}

	async renameRemote(cwd: string, oldName: string, newName: string): Promise<void> {
		assertSafeGitRemoteName(oldName);
		assertSafeGitRemoteName(newName);
		if (oldName === newName) return;
		const result = await execGit(['remote', 'rename', oldName, newName], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git remote rename failed: ${result.stderr}`);
		}
	}

	async removeRemote(cwd: string, name: string): Promise<void> {
		assertSafeGitRemoteName(name);
		const result = await execGit(['remote', 'remove', name], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git remote remove failed: ${result.stderr}`);
		}
	}

	// ============================================
	// Stash
	// ============================================

	async stashList(cwd: string): Promise<GitStashEntry[]> {
		// Custom format appends the committer date (ISO 8601) after a ` | `
		// separator so the parser can extract it. The default `git stash list`
		// output has no date. `%cI` is the strict ISO format — it contains
		// colons and dashes but never ` | `, so the lastIndexOf split is safe.
		const result = await execGit(['stash', 'list', '--format=%gd: %gs | %cI'], cwd);
		return parseStashList(result.stdout);
	}

	async stashSave(cwd: string, message?: string, stagedOnly = false): Promise<void> {
		const args = ['stash', 'push'];
		// `--staged` stashes exactly the index (works at hunk level, so partially
		// staged files are handled precisely). Requires Git >= 2.35.
		if (stagedOnly) args.push('--staged');
		if (message) {
			assertSafeGitCommitMessage(message);
			args.push('-m', message);
		}
		const result = await execGit(args, cwd);
		if (result.exitCode !== 0) {
			// Git < 2.35 doesn't know `--staged`; surface an actionable message
			// instead of the raw "unknown option" / "usage:" noise.
			if (stagedOnly && /unknown option|--staged|usage:/i.test(result.stderr)) {
				throw new Error(
					'Stashing staged changes only requires Git 2.35 or newer. Please update Git to use this option.'
				);
			}
			throw new Error(`git stash failed: ${result.stderr}`);
		}
	}

	async stashPop(
		cwd: string,
		index = 0
	): Promise<{ success: boolean; hasConflicts: boolean; message: string }> {
		if (!Number.isInteger(index) || index < 0) {
			throw new Error('Invalid stash index');
		}
		const result = await execGit(['stash', 'pop', `stash@{${index}}`], cwd);
		// Conflict during pop: git exits non-zero but the working tree now contains
		// unmerged paths. Surface this as a normal result so the caller can prompt
		// the user to resolve — throwing here would just produce an opaque toast.
		const combined = `${result.stdout}\n${result.stderr}`;
		const hasConflicts = /CONFLICT \(/.test(combined) || /needs merge/.test(combined);
		if (result.exitCode !== 0) {
			if (hasConflicts) {
				return { success: false, hasConflicts: true, message: result.stderr || result.stdout };
			}
			throw new Error(`git stash pop failed: ${result.stderr}`);
		}
		return { success: true, hasConflicts: false, message: result.stdout };
	}

	async stashDrop(cwd: string, index = 0): Promise<void> {
		if (!Number.isInteger(index) || index < 0) {
			throw new Error('Invalid stash index');
		}
		const result = await execGit(['stash', 'drop', `stash@{${index}}`], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git stash drop failed: ${result.stderr}`);
		}
	}

	async stashDiff(cwd: string, index = 0): Promise<GitFileDiff[]> {
		if (!Number.isInteger(index) || index < 0) {
			throw new Error('Invalid stash index');
		}
		// `git stash show -p stash@{N}` produces a unified diff in the
		// same format as `git diff`, so `parseDiff` handles it unchanged.
		const result = await execGit(['stash', 'show', '-p', `stash@{${index}}`], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git stash show failed: ${result.stderr}`);
		}
		return parseDiff(result.stdout);
	}

	// ============================================
	// Tags
	// ============================================

	async getTags(cwd: string): Promise<{ name: string; hash: string; message: string; date: string; isAnnotated: boolean }[]> {
		const result = await execGit(
			['tag', '-l', '--sort=-creatordate', '--format=%(refname:short)|||%(objectname:short)|||%(contents:subject)|||%(creatordate:iso-strict)|||%(objecttype)'],
			cwd
		);
		if (result.exitCode !== 0) return [];

		const tags: { name: string; hash: string; message: string; date: string; isAnnotated: boolean }[] = [];
		const lines = result.stdout.split('\n').filter(Boolean);
		for (const line of lines) {
			const parts = line.split('|||');
			if (parts.length >= 2) {
				tags.push({
					name: parts[0],
					hash: parts[1],
					message: parts[2] || '',
					date: parts[3] || '',
					isAnnotated: parts[4] === 'tag'
				});
			}
		}
		return tags;
	}

	async createTag(cwd: string, name: string, message?: string, commitHash?: string): Promise<void> {
		assertSafeGitRevish(name, 'tag name');
		const args = ['tag'];
		if (message) {
			assertSafeGitCommitMessage(message);
			args.push('-a', name, '-m', message);
		} else {
			args.push(name);
		}
		if (commitHash) {
			assertSafeGitRevish(commitHash, 'tag target');
			args.push(commitHash);
		}
		const result = await execGit(args, cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git tag failed: ${result.stderr}`);
		}
	}

	async deleteTag(cwd: string, name: string): Promise<void> {
		assertSafeGitRevish(name, 'tag name');
		const result = await execGit(['tag', '-d', name], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git tag -d failed: ${result.stderr}`);
		}
	}

	async pushTag(cwd: string, name: string, remote = 'origin'): Promise<{ success: boolean; message: string }> {
		assertSafeGitRemoteName(remote);
		assertSafeGitRevish(name, 'tag name');
		const result = await execGit(['push', remote, name], cwd, 60000);
		return {
			success: result.exitCode === 0,
			message: result.exitCode === 0 ? (result.stderr || result.stdout) : result.stderr
		};
	}

	// ============================================
	// Conflict Resolution
	// ============================================

	async getConflictFiles(cwd: string): Promise<GitConflictFile[]> {
		const status = await this.getStatus(cwd);
		const conflicts: GitConflictFile[] = [];

		for (const file of status.conflicted) {
			try {
				const { readFile } = await import('node:fs/promises');
				const { join } = await import('node:path');
				const content = await readFile(join(cwd, file.path), 'utf-8');
				const markers = parseConflictMarkers(content);
				conflicts.push({ path: file.path, content, markers });
			} catch (err) {
				debug.error('git', `Failed to read conflict file: ${file.path}`, err);
			}
		}

		return conflicts;
	}

	async resolveConflict(
		cwd: string,
		filePath: string,
		resolution: 'ours' | 'theirs' | 'custom',
		customContent?: string
	): Promise<void> {
		assertSafeGitPathOperand(filePath, 'conflict path');
		if (resolution === 'custom' && customContent !== undefined) {
			// Write custom content
			const { writeFile } = await import('node:fs/promises');
			const { join } = await import('node:path');
			await writeFile(join(cwd, filePath), customContent, 'utf-8');
		} else if (resolution === 'ours') {
			await execGit(['checkout', '--ours', '--', filePath], cwd);
		} else if (resolution === 'theirs') {
			await execGit(['checkout', '--theirs', '--', filePath], cwd);
		}

		// Stage the resolved file
		await this.stageFile(cwd, filePath);
	}

	/**
	 * Aborts the in-progress conflict-producing operation: merge, cherry-pick,
	 * revert, rebase, or a stash pop that left unmerged paths. We detect the
	 * type via `.git/*_HEAD` sentinel files and pick the matching abort command.
	 * For stash conflicts (no sentinel) we fall back to `git reset --merge`,
	 * which unwinds the unmerged paths while keeping unrelated local edits.
	 */
	/** Resolve the absolute git dir for a working tree (handles worktrees/.git files). */
	private async resolveGitDir(cwd: string): Promise<string> {
		const { join } = await import('node:path');
		const result = await execGit(['rev-parse', '--git-dir'], cwd);
		const raw = result.exitCode === 0 ? result.stdout.trim() : '.git';
		return raw.startsWith('/') ? raw : join(cwd, raw);
	}

	/**
	 * Detect an in-progress operation (rebase, merge, cherry-pick, revert, bisect)
	 * by probing the sentinel files git writes under the git dir. Returns null when
	 * the working tree is in a normal state.
	 */
	private async detectGitOperation(cwd: string): Promise<GitOperation | null> {
		const { existsSync } = await import('node:fs');
		const { join } = await import('node:path');
		const gitDir = await this.resolveGitDir(cwd);
		const has = (name: string) => existsSync(join(gitDir, name));

		if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
		if (has('MERGE_HEAD')) return 'merge';
		if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
		if (has('REVERT_HEAD')) return 'revert';
		if (has('BISECT_LOG')) return 'bisect';
		return null;
	}

	async abortMerge(cwd: string): Promise<void> {
		const { existsSync } = await import('node:fs');
		const { join } = await import('node:path');

		const gitDir = await this.resolveGitDir(cwd);
		const has = (name: string) => existsSync(join(gitDir, name));

		let args: string[] | null = null;
		if (has('MERGE_HEAD')) args = ['merge', '--abort'];
		else if (has('CHERRY_PICK_HEAD')) args = ['cherry-pick', '--abort'];
		else if (has('REVERT_HEAD')) args = ['revert', '--abort'];
		else if (has('rebase-merge') || has('rebase-apply')) args = ['rebase', '--abort'];

		if (args) {
			const result = await execGit(args, cwd);
			if (result.exitCode !== 0) {
				throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
			}
			return;
		}

		// No standard in-progress operation — likely a stash pop conflict. Use
		// `git reset --merge` to unwind unmerged paths safely.
		const reset = await execGit(['reset', '--merge'], cwd);
		if (reset.exitCode !== 0) {
			throw new Error(`git reset --merge failed: ${reset.stderr}`);
		}
	}

	// ============================================
	// History rewrite / undo
	// ============================================

	/**
	 * Undo the last commit by moving HEAD back one commit.
	 *  - `soft`  keeps the changes staged
	 *  - `mixed` keeps the changes in the working tree (unstaged)
	 *  - `hard`  discards the changes entirely (destructive)
	 */
	async undoLastCommit(cwd: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
		const flag = mode === 'soft' ? '--soft' : mode === 'hard' ? '--hard' : '--mixed';
		const result = await execGit(['reset', flag, 'HEAD~1'], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git reset ${flag} failed: ${result.stderr}`);
		}
	}

	/** Create a new commit that reverses a previous one (default: HEAD). */
	async revertCommit(cwd: string, ref = 'HEAD'): Promise<{ success: boolean; message: string }> {
		assertSafeGitRevish(ref, 'revert ref');
		const result = await execGit(['revert', '--no-edit', ref], cwd);
		return {
			success: result.exitCode === 0,
			message: result.exitCode === 0 ? (result.stdout || result.stderr) : result.stderr
		};
	}

	/** Cherry-pick one or more commits onto the current branch (`git cherry-pick <hash>...`). */
	async cherryPick(cwd: string, refs: string[]): Promise<{ success: boolean; message: string }> {
		if (refs.length === 0) {
			return { success: false, message: 'No commits provided' };
		}
		for (const ref of refs) {
			assertSafeGitRevish(ref, 'cherry-pick ref');
		}
		const result = await execGit(['cherry-pick', ...refs], cwd);
		return {
			success: result.exitCode === 0,
			message: result.exitCode === 0 ? (result.stdout || result.stderr || 'Cherry-pick succeeded') : result.stderr
		};
	}

	// ============================================
	// Maintenance
	// ============================================

	/** Remove untracked files and directories (`git clean -fd`). */
	async cleanUntracked(cwd: string): Promise<string> {
		const result = await execGit(['clean', '-fd'], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git clean failed: ${result.stderr}`);
		}
		return result.stdout.trim();
	}

	/** Run garbage collection to optimize the repository. */
	async optimize(cwd: string): Promise<string> {
		const result = await execGit(['gc'], cwd, 180000);
		if (result.exitCode !== 0) {
			throw new Error(`git gc failed: ${result.stderr}`);
		}
		return (result.stderr || result.stdout).trim() || 'Repository optimized';
	}

	// ============================================
	// npm version
	// ============================================

	/**
	 * Bump the package version with `npm version <patch|minor|major>`. In a git
	 * repo npm creates the version-bump commit and tag automatically. Requires a
	 * clean working tree (npm refuses otherwise) — that error is surfaced verbatim.
	 */
	async npmVersion(
		cwd: string,
		bump: 'patch' | 'minor' | 'major'
	): Promise<{ success: boolean; version: string; message: string }> {
		const npmPath = resolveBinary('npm');
		if (!npmPath) {
			throw new Error('npm binary not found on PATH');
		}
		const proc = Bun.spawn([npmPath, 'version', bump], {
			cwd,
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...getCleanSpawnEnv() }
		});
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text()
		]);
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			return { success: false, version: '', message: (stderr || stdout).trim() };
		}
		// npm prints the new version (e.g. "v1.2.3") on stdout.
		const version = stdout.trim().split('\n').pop()?.trim() || '';
		return { success: true, version, message: version };
	}
}

// Singleton
export const gitService = new GitService();
