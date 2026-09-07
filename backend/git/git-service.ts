/**
 * Git Service
 * High-level git operations built on top of executor and parser
 */

import { execGit, isGitRepo, getGitRoot, type GitExecResult } from './git-executor';
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
	parseConflictMarkers,
	parseReflog,
	parseUnmergedStages,
	hasConflictMarkers
} from './git-parser';
import type {
	GitStatus,
	GitBranchInfo,
	GitOperation,
	GitFileDiff,
	GitCommitDiff,
	GitLogResult,
	GitRemote,
	GitStashEntry,
	GitPushTarget,
	GitConflictFile,
	GitConflictKind,
	GitConflictResolution,
	GitOperationState,
	GitReflogEntry
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
import { findNestedRepoPaths, findSubmodulePaths } from './nested-repos';
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
	// Revision probes
	// ============================================

	/**
	 * True when the repo has at least one commit.
	 *
	 * A freshly `git init`ed repo has an unborn HEAD: every HEAD-relative revision
	 * (`HEAD`, `HEAD~1`, `HEAD^`) fails to resolve, and git reports it as a raw
	 * `fatal: ambiguous argument` / `bad revision`. Callers probe this so they can
	 * answer with an actionable message — or skip the operation entirely — instead
	 * of leaking that fatal into a toast.
	 */
	private async hasCommits(cwd: string): Promise<boolean> {
		return (await execGit(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd)).exitCode === 0;
	}

	/**
	 * True when `ref` has a parent commit — false for a root (parentless) commit,
	 * where `<ref>^` / `<ref>~1` cannot resolve even though `<ref>` itself does.
	 */
	private async hasParent(cwd: string, ref = 'HEAD'): Promise<boolean> {
		assertSafeGitRevish(ref, 'parent probe ref');
		return (await execGit(['rev-parse', '--verify', '--quiet', `${ref}^`], cwd)).exitCode === 0;
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

	/**
	 * Stage everything. Git will happily record a conflicted file that still has
	 * `<<<<<<<` in it as resolved, so we check first and refuse — committing the
	 * markers is far more expensive to undo than this error is to read.
	 */
	async stageAll(cwd: string): Promise<void> {
		const unresolved = await this.findFilesWithLeftoverMarkers(cwd);
		if (unresolved.length > 0) {
			const shown = unresolved.slice(0, 5).join(', ');
			const rest = unresolved.length > 5 ? ` and ${unresolved.length - 5} more` : '';
			throw new Error(
				`Cannot stage everything: ${shown}${rest} still contain conflict markers. Resolve them first.`
			);
		}
		const result = await execGit(['add', '-A'], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git add -A failed: ${result.stderr}`);
		}
	}

	/** Unmerged paths whose working-tree text still has conflict markers in it. */
	private async findFilesWithLeftoverMarkers(cwd: string): Promise<string[]> {
		const unmerged = await this.getUnmergedPaths(cwd);
		if (unmerged.length === 0) return [];

		const { readFile } = await import('node:fs/promises');
		const { join } = await import('node:path');
		const offenders: string[] = [];

		for (const filePath of unmerged) {
			try {
				const buffer = await readFile(join(cwd, filePath));
				if (buffer.subarray(0, 8000).includes(0)) continue;
				if (hasConflictMarkers(buffer.toString('utf-8'))) offenders.push(filePath);
			} catch {
				// Missing file (both-deleted) has no markers to leave behind.
			}
		}

		return offenders;
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

	/**
	 * Discard every working-tree change.
	 *
	 * Refused during a conflict: `git checkout -- .` cannot restore an unmerged
	 * path, so it would half-succeed — wiping the unrelated edits while leaving
	 * the conflict in place — and the old code ignored both exit codes, so that
	 * partial result was invisible. Unwinding a merge is `abortOperation`'s job.
	 */
	async discardAll(cwd: string): Promise<void> {
		const unmerged = await this.getUnmergedPaths(cwd);
		if (unmerged.length > 0) {
			throw new Error(
				'Cannot discard everything while a merge is unresolved. Abort the operation instead, or resolve the conflicts first.'
			);
		}

		// Restore tracked files
		const restore = await execGit(['checkout', '--', '.'], cwd);
		if (restore.exitCode !== 0 && restore.stderr.trim()) {
			throw new Error(`git checkout failed: ${restore.stderr.trim()}`);
		}
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
			// Unborn HEAD — git says "You have nothing to amend", which reads like a
			// failure rather than "commit normally instead".
			if (!(await this.hasCommits(cwd))) {
				throw new Error('There is no commit to amend yet — create the first commit instead.');
			}
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

	async getDiffCommit(cwd: string, commitHash: string): Promise<GitCommitDiff> {
		assertSafeGitRevish(commitHash, 'commit hash');
		// Root commits have no parent, so `<hash>^` can't resolve and `git diff`
		// fails silently (empty stdout) — which previously surfaced as "No files
		// changed". Detect the parentless case and diff against the empty tree via
		// `diff-tree --root` so the initial commit's files show up as additions.
		// Commits with a parent (including merges) keep the original behaviour.
		const hasParent = await this.hasParent(cwd, commitHash);
		// Fetch the full commit message alongside the diff so the detail view can
		// render the body. `%s\0%b` splits cleanly on NUL since a subject never
		// contains one; the body is kept verbatim (it may span many lines).
		const [result, messageResult] = await Promise.all([
			hasParent
				? execGit(['diff', `${commitHash}^`, commitHash], cwd)
				: execGit(['diff-tree', '-p', '--root', '--no-commit-id', commitHash], cwd),
			execGit(['log', '-1', '--format=%s%x00%b', commitHash], cwd)
		]);

		const raw = messageResult.stdout;
		const nulIdx = raw.indexOf('\0');
		const subject = nulIdx >= 0 ? raw.slice(0, nulIdx) : raw.trim();
		// Preserve leading whitespace (list/paragraph indentation) but drop the
		// trailing newline git appends after the body.
		const body = nulIdx >= 0 ? raw.slice(nulIdx + 1).replace(/\s+$/, '') : '';

		return { files: parseDiff(result.stdout), subject, body };
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
		// `%1f` emits a literal 0x1F, which separates the upstream from the legacy
		// pipe-delimited fields without colliding with a `|` inside a subject.
		const localFmt =
			'%(HEAD)|%(refname:short)|%(objectname:short)|%(subject)|%(committerdate:iso8601)%1f%(upstream:short)';
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

		// Fill in upstreams that git cannot name. `gh pr checkout` on a fork PR
		// writes the fork's URL into `branch.<name>.remote`, and a URL has no
		// remote-tracking ref, so `%(upstream:short)` comes back empty even though
		// the branch is very much tracking something.
		for (const localBranch of branchInfo.local) {
			if (localBranch.upstream) continue;
			const configured = await this.readBranchTracking(cwd, localBranch.name);
			if (configured) localBranch.upstream = `${configured.remote}/${configured.remoteBranch}`;
		}

		// Ahead/behind belongs against the branch's REAL upstream. Measuring it
		// against `<selectedRemote>/<same name>` reported 0/0 whenever the branch
		// tracked a differently-named branch or a different remote — which is
		// exactly the fork-PR case.
		const currentUpstream = branchInfo.local.find(b => b.isCurrent)?.upstream;
		const trackingRef = currentUpstream
			? // Tracks something. Use it when it resolves locally; when it does not —
				// a URL upstream has no local ref — report nothing rather than compare
				// against an unrelated same-named branch on the selected remote.
				(await this.hasRef(cwd, currentUpstream))
				? currentUpstream
				: null
			: selectedRemote
				? `${selectedRemote}/${branchInfo.current}`
				: null;

		if (branchInfo.current && trackingRef) {
			try {
				const remoteRef = trackingRef;
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

	/**
	 * Merge `branchName` into the current branch.
	 *
	 * The three mode flags are mutually exclusive in git, so the caller picks one:
	 * `--no-ff` always records a merge commit, `--squash` collapses the branch into
	 * staged changes without committing, `--ff-only` refuses anything that is not a
	 * fast-forward.
	 */
	async mergeBranch(
		cwd: string,
		branchName: string,
		options: { noFastForward?: boolean; squash?: boolean; ffOnly?: boolean } | boolean = false
	): Promise<{ success: boolean; message: string }> {
		assertSafeGitRevish(branchName, 'merge branch');
		const opts = typeof options === 'boolean' ? { noFastForward: options } : options;
		const args = ['merge'];
		if (opts.squash) args.push('--squash');
		else if (opts.ffOnly) args.push('--ff-only');
		else if (opts.noFastForward) args.push('--no-ff');
		args.push(branchName);
		const result = await execGit(args, cwd, 120000);
		return {
			success: result.exitCode === 0,
			message: result.exitCode === 0 ? result.stdout : result.stderr
		};
	}

	// ============================================
	// Log
	// ============================================

	async getLog(cwd: string, limit = 50, skip = 0, branch?: string, allBranches = false): Promise<GitLogResult> {
		const SEPARATOR = '|||';
		const format = `%H${SEPARATOR}%h${SEPARATOR}%an${SEPARATOR}%ae${SEPARATOR}%aI${SEPARATOR}%P${SEPARATOR}%D%n%s%x00`;

		const args = [
			'log',
			'--topo-order',
			`--format=${format}`,
			`--max-count=${limit + 1}`, // +1 to check if there are more
			`--skip=${skip}`
		];

		// `--all` is a flag, not a revision, so it stays out of the value slot that
		// `assertSafeGitRevish` guards against option injection.
		if (allBranches) {
			args.push('--all');
		} else if (branch) {
			assertSafeGitRevish(branch, 'log branch');
			args.push(branch);
		}

		const result = await execGit(args, cwd);
		if (result.exitCode !== 0) {
			// A repo with no commits yet isn't an error — `git log` just has nothing
			// to walk. Report it as an empty history so the UI shows its empty state.
			if (!(await this.hasCommits(cwd))) {
				return { commits: [], total: 0, hasMore: false };
			}
			throw new Error(`git log failed: ${result.stderr}`);
		}

		const commits = parseLog(result.stdout);
		const hasMore = commits.length > limit;
		if (hasMore) commits.pop(); // Remove the extra one

		// Get total count
		const countRef = allBranches ? '--all' : (branch ?? 'HEAD');
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

	/**
	 * Pull the current branch.
	 *
	 * Mirrors `push`: naming `<selectedRemote> <localName>` explicitly pulled from
	 * the wrong place whenever the branch tracked a different remote or a
	 * differently-named branch, which is the normal state of a fork PR under
	 * review. A tracked branch pulls from its own upstream.
	 */
	async pull(cwd: string, remote = 'origin', branch?: string, rebase = false): Promise<{ success: boolean; message: string }> {
		const args = ['pull'];
		if (rebase) args.push('--rebase');

		const target = await this.getPushTarget(cwd, branch);
		if (!target.hasUpstream) {
			assertSafeGitRemoteName(remote);
			args.push(remote);
			if (branch) {
				assertSafeGitRevish(branch, 'pull branch');
				args.push(branch);
			}
		}

		const result = await execGit(args, cwd, 60000);
		return {
			success: result.exitCode === 0,
			message: result.exitCode === 0 ? result.stdout : result.stderr
		};
	}

	/**
	 * Shape a `git push` outcome. On an unborn HEAD git only reports
	 * `src refspec <branch> does not match any`, which reads like a broken remote
	 * rather than "there is nothing here to push yet".
	 */
	private async describePushResult(
		cwd: string,
		result: GitExecResult
	): Promise<{ success: boolean; message: string }> {
		if (result.exitCode === 0) {
			return { success: true, message: result.stderr || result.stdout };
		}
		if (!(await this.hasCommits(cwd))) {
			return { success: false, message: 'This branch has no commits yet, so there is nothing to push.' };
		}
		// `--force-with-lease` compares against the remote-tracking ref. A branch
		// that tracks a bare URL — a fork PR checked out for review — has no such
		// ref, so git refuses with a bare "stale info" that explains nothing.
		if (/stale info/i.test(result.stderr)) {
			return {
				success: false,
				message:
					'Force push with lease needs a remote-tracking ref to compare against, and this branch does not have one (it tracks a URL rather than a named remote). Fetch the branch first, or use a plain force push.'
			};
		}
		return { success: false, message: result.stderr };
	}

	/** Read a single git config value, or null when it is unset. */
	private async readConfig(cwd: string, key: string): Promise<string | null> {
		const result = await execGit(['config', '--get', key], cwd, { okExitCodes: [1] });
		const value = result.stdout.trim();
		return result.exitCode === 0 && value ? value : null;
	}

	/** True when `ref` resolves in this repo. */
	private async hasRef(cwd: string, ref: string): Promise<boolean> {
		if (!/^[^\0\n\r]+$/.test(ref) || ref.startsWith('-')) return false;
		const result = await execGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd, {
			okExitCodes: [1]
		});
		return result.exitCode === 0;
	}

	/**
	 * The tracking configuration recorded for a branch, straight from git config.
	 *
	 * Read from config rather than from `@{upstream}` on purpose: when
	 * `branch.<name>.remote` holds a URL instead of a remote name — which is what
	 * `gh pr checkout` writes for a fork PR — every ref-based lookup fails with
	 * "not stored as a remote-tracking branch", even though the branch does track
	 * something and a plain `git push` sends it to exactly the right place.
	 */
	private async readBranchTracking(
		cwd: string,
		branch: string
	): Promise<{ remote: string; remoteBranch: string } | null> {
		assertSafeGitRevish(branch, 'branch name');
		const remote = await this.readConfig(cwd, `branch.${branch}.remote`);
		const merge = await this.readConfig(cwd, `branch.${branch}.merge`);
		if (!remote || !merge) return null;
		return { remote, remoteBranch: merge.replace(/^refs\/heads\//, '') };
	}

	/** A remote name is a configured remote; anything else we treat as a URL. */
	private async isConfiguredRemote(cwd: string, name: string): Promise<boolean> {
		const result = await execGit(['remote'], cwd);
		return result.stdout.split('\n').map(r => r.trim()).includes(name);
	}

	/**
	 * Resolve where a push would actually land, following git's own precedence:
	 * `branch.<name>.pushRemote` > `remote.pushDefault` > `branch.<name>.remote`.
	 *
	 * Used for display and to decide whether a push needs `-u`; the push itself
	 * still delegates to git so nothing here can drift from what git does.
	 */
	async getPushTarget(cwd: string, branch?: string): Promise<GitPushTarget> {
		const current = branch ?? (await execGit(['branch', '--show-current'], cwd)).stdout.trim();
		const fallback: GitPushTarget = {
			remote: 'origin',
			remoteBranch: current,
			hasUpstream: false,
			isUrl: false,
			branch: current
		};
		if (!current) return fallback;

		const tracking = await this.readBranchTracking(cwd, current);
		const pushRemote =
			(await this.readConfig(cwd, `branch.${current}.pushRemote`)) ??
			(await this.readConfig(cwd, 'remote.pushDefault')) ??
			tracking?.remote ??
			null;

		if (!pushRemote) return fallback;

		return {
			remote: pushRemote,
			// When pushing to a different remote than the branch fetches from, git's
			// default `push.default=simple` uses the local name; otherwise it uses
			// the configured merge ref.
			remoteBranch:
				tracking && pushRemote === tracking.remote ? tracking.remoteBranch : current,
			hasUpstream: Boolean(tracking),
			isUrl: !(await this.isConfiguredRemote(cwd, pushRemote)),
			branch: current
		};
	}

	/**
	 * Push the current branch.
	 *
	 * When the branch already tracks something we run a bare `git push` and let
	 * git resolve the destination. Naming a remote and a branch explicitly — which
	 * this used to do unconditionally, with `-u` — sent a fork PR's review commits
	 * into the main repository as a brand-new branch, and the `-u` then rewrote
	 * the branch's remote so every subsequent push went there too.
	 *
	 * `remote`/`branch` are only used for the genuinely untracked case (the first
	 * push of a new local branch), where a destination has to be chosen and `-u`
	 * is what the user wants.
	 */
	async push(
		cwd: string,
		remote = 'origin',
		branch?: string,
		force = false,
		options: { useUpstream?: boolean } = {}
	): Promise<{ success: boolean; message: string }> {
		const { useUpstream = true } = options;
		const target = await this.getPushTarget(cwd, branch);

		if (useUpstream && target.hasUpstream) {
			const args = ['push'];
			if (force) args.push('--force-with-lease');
			return this.describePushResult(cwd, await execGit(args, cwd, 60000));
		}

		assertSafeGitRemoteName(remote);
		const args = ['push', remote];
		if (branch) {
			assertSafeGitRevish(branch, 'push branch');
			args.push(branch);
		}
		if (force) args.push('--force-with-lease');
		// Only safe here: the branch tracks nothing, so there is no upstream to
		// overwrite and recording one is the point of a first push.
		args.push('-u');
		return this.describePushResult(cwd, await execGit(args, cwd, 60000));
	}

	/** Point a branch at a different upstream — the way back from a wrong push. */
	async setUpstream(
		cwd: string,
		branch: string,
		remote: string,
		remoteBranch?: string
	): Promise<void> {
		assertSafeGitRevish(branch, 'branch name');
		assertSafeGitRemoteName(remote);
		const target = remoteBranch ?? branch;
		assertSafeGitRevish(target, 'upstream branch');
		const result = await execGit(
			['branch', `--set-upstream-to=${remote}/${target}`, branch],
			cwd
		);
		if (result.exitCode !== 0) {
			throw new Error(`Could not set upstream: ${result.stderr.trim() || 'unknown error'}`);
		}
	}

	async unsetUpstream(cwd: string, branch: string): Promise<void> {
		assertSafeGitRevish(branch, 'branch name');
		const result = await execGit(['branch', '--unset-upstream', branch], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`Could not clear upstream: ${result.stderr.trim() || 'unknown error'}`);
		}
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
		// `--tags` is about the tag namespace, not this branch, so it always needs
		// an explicit remote.
		if (mode === 'all-tags') {
			assertSafeGitRemoteName(remote);
			return this.describePushResult(
				cwd,
				await execGit(['push', remote, '--tags'], cwd, 60000)
			);
		}

		const flag =
			mode === 'with-tags'
				? '--follow-tags'
				: mode === 'force-lease'
					? '--force-with-lease'
					: '--force';

		// Same rule as `push`: a tracked branch goes where git says it goes.
		const target = await this.getPushTarget(cwd, branch);
		if (target.hasUpstream) {
			return this.describePushResult(cwd, await execGit(['push', flag], cwd, 60000));
		}

		assertSafeGitRemoteName(remote);
		const args = ['push', remote];
		if (branch) {
			assertSafeGitRevish(branch, 'push branch');
			args.push(branch);
		}
		args.push(flag, '-u');
		return this.describePushResult(cwd, await execGit(args, cwd, 60000));
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
			// Stashing needs a commit to record the base state against.
			if (!(await this.hasCommits(cwd))) {
				throw new Error('Stashing requires at least one commit — create the first commit first.');
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

	/**
	 * Like `stashPop`, but leaves the entry in the stash list. Preferred when the
	 * changes might not apply cleanly: a conflicted `pop` is easy to abort into a
	 * state where the work looks lost, whereas `apply` always keeps a copy.
	 */
	async stashApply(
		cwd: string,
		index = 0
	): Promise<{ success: boolean; hasConflicts: boolean; message: string }> {
		if (!Number.isInteger(index) || index < 0) {
			throw new Error('Invalid stash index');
		}
		const result = await execGit(['stash', 'apply', `stash@{${index}}`], cwd);
		const combined = `${result.stdout}\n${result.stderr}`;
		const hasConflicts = /CONFLICT \(/.test(combined) || /needs merge/.test(combined);
		if (result.exitCode !== 0) {
			if (hasConflicts) {
				return { success: false, hasConflicts: true, message: result.stderr || result.stdout };
			}
			throw new Error(`git stash apply failed: ${result.stderr}`);
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

	/**
	 * Working-tree text above this size is not shipped to the client. A conflicted
	 * minified bundle can be tens of megabytes; reading it, holding it as a JS
	 * string and pushing it down the WebSocket stalls the panel for no benefit,
	 * since nobody resolves a 20 MB file marker-by-marker anyway.
	 */
	private static readonly MAX_CONFLICT_CONTENT_BYTES = 2 * 1024 * 1024;

	/**
	 * Classify a conflict from the stages present in the index. Git records up to
	 * three: 1 = merge base, 2 = ours, 3 = theirs. A missing stage means that side
	 * deleted (or never had) the path.
	 */
	private conflictKindFromStages(stages: Set<number>): GitConflictKind {
		const base = stages.has(1);
		const ours = stages.has(2);
		const theirs = stages.has(3);

		if (ours && theirs) return base ? 'both-modified' : 'both-added';
		if (ours && !theirs) return base ? 'deleted-by-them' : 'added-by-us';
		if (!ours && theirs) return base ? 'deleted-by-us' : 'added-by-them';
		return 'both-deleted';
	}

	/**
	 * List every unmerged path with enough context for the resolver to render it.
	 *
	 * The source of truth is `git ls-files -u`, not the working tree. Reading files
	 * first (and dropping the ones that throw) silently hid whole classes of
	 * conflict: both-deleted has no file on disk at all, so those paths vanished
	 * from the UI while git still refused to continue.
	 */
	async getConflictFiles(cwd: string): Promise<GitConflictFile[]> {
		const result = await execGit(['ls-files', '-u', '-z'], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git ls-files -u failed: ${result.stderr}`);
		}

		const stages = parseUnmergedStages(result.stdout);
		const { readFile, stat } = await import('node:fs/promises');
		const { join } = await import('node:path');
		const conflicts: GitConflictFile[] = [];

		for (const [filePath, fileStages] of stages) {
			const kind = this.conflictKindFromStages(fileStages);
			const entry: GitConflictFile = {
				path: filePath,
				content: '',
				markers: [],
				kind,
				contentOmitted: true
			};

			try {
				const info = await stat(join(cwd, filePath));
				entry.size = info.size;
				if (info.size > GitService.MAX_CONFLICT_CONTENT_BYTES) {
					entry.omitReason = 'too-large';
				} else {
					const buffer = await readFile(join(cwd, filePath));
					// A NUL in the head is git's own binary heuristic. Decoding such a
					// file as UTF-8 produces replacement characters, and writing that
					// back as a "resolution" would corrupt it.
					if (buffer.subarray(0, 8000).includes(0)) {
						entry.omitReason = 'binary';
					} else {
						entry.content = buffer.toString('utf-8');
						entry.markers = parseConflictMarkers(entry.content);
						entry.contentOmitted = false;
					}
				}
			} catch {
				// No working-tree file: both-deleted, or deleted-by-us before the user
				// restored it. Still a conflict git needs an answer for.
				entry.omitReason = 'missing';
			}

			conflicts.push(entry);
		}

		return conflicts;
	}

	/**
	 * Apply one resolution to one conflicted path and stage the result.
	 *
	 * `ours`/`theirs` need the file to have that stage — `git checkout --ours` on a
	 * path the other side deleted fails with an opaque "does not have our version",
	 * so we translate those into the keep/delete answer git actually wants.
	 */
	async resolveConflict(
		cwd: string,
		filePath: string,
		resolution: GitConflictResolution,
		customContent?: string
	): Promise<void> {
		assertSafeGitPathOperand(filePath, 'conflict path');
		const { writeFile, readFile } = await import('node:fs/promises');
		const { join } = await import('node:path');
		const absolute = join(cwd, filePath);

		if (resolution === 'reset') {
			// Re-materialize the conflict so the user can start over.
			const reset = await execGit(['checkout', '--merge', '--', filePath], cwd);
			if (reset.exitCode !== 0) {
				throw new Error(`git checkout --merge failed: ${reset.stderr}`);
			}
			return;
		}

		if (resolution === 'delete') {
			const removed = await execGit(['rm', '-f', '--', filePath], cwd);
			if (removed.exitCode !== 0) {
				throw new Error(`git rm failed: ${removed.stderr}`);
			}
			return;
		}

		if (resolution === 'custom') {
			if (customContent === undefined) {
				throw new Error('A custom resolution needs the resolved file content');
			}
			this.assertNoLeftoverMarkers(customContent, filePath);
			await writeFile(absolute, customContent, 'utf-8');
		} else if (resolution === 'ours' || resolution === 'theirs') {
			const stages = parseUnmergedStages(
				(await execGit(['ls-files', '-u', '-z', '--', filePath], cwd)).stdout
			);
			const present = stages.get(filePath) ?? new Set<number>();
			const wanted = resolution === 'ours' ? 2 : 3;
			if (!present.has(wanted)) {
				// That side deleted the path — "take ours" means "stay deleted".
				const removed = await execGit(['rm', '-f', '--', filePath], cwd);
				if (removed.exitCode !== 0) {
					throw new Error(`git rm failed: ${removed.stderr}`);
				}
				return;
			}
			const flag = resolution === 'ours' ? '--ours' : '--theirs';
			const checkout = await execGit(['checkout', flag, '--', filePath], cwd);
			if (checkout.exitCode !== 0) {
				throw new Error(`git checkout ${flag} failed: ${checkout.stderr}`);
			}
		} else if (resolution === 'keep') {
			// Keep whatever is on disk — but not if it still has markers in it.
			try {
				const buffer = await readFile(absolute);
				if (!buffer.subarray(0, 8000).includes(0)) {
					this.assertNoLeftoverMarkers(buffer.toString('utf-8'), filePath);
				}
			} catch (err) {
				if (err instanceof Error && err.message.includes('conflict marker')) throw err;
				throw new Error(`Cannot keep "${filePath}": the file is not in the working tree`);
			}
		}

		await this.stageFile(cwd, filePath);
	}

	/**
	 * Refuse to stage text that still contains `<<<<<<<`. Git does not check this,
	 * so without the guard a half-finished resolution commits the markers.
	 */
	private assertNoLeftoverMarkers(content: string, filePath: string): void {
		if (hasConflictMarkers(content)) {
			throw new Error(
				`"${filePath}" still contains conflict markers. Remove every <<<<<<< / ======= / >>>>>>> block before staging it.`
			);
		}
	}

	/** Paths git still considers unmerged. */
	async getUnmergedPaths(cwd: string): Promise<string[]> {
		const result = await execGit(['diff', '--name-only', '--diff-filter=U', '-z'], cwd);
		if (result.exitCode !== 0) return [];
		return result.stdout.split('\0').filter(Boolean);
	}

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

	/** Short subject of a revision, or an empty string when it cannot be read. */
	private async subjectOf(cwd: string, rev: string): Promise<string> {
		const result = await execGit(['log', '-1', '--format=%s', rev], cwd);
		return result.exitCode === 0 ? result.stdout.trim() : '';
	}

	/** Best human name for a commit-ish: a branch name if one points at it, else a short hash. */
	private async describeRef(cwd: string, rev: string): Promise<string> {
		const named = await execGit(
			['name-rev', '--name-only', '--refs=refs/heads/*', '--refs=refs/remotes/*', rev],
			cwd
		);
		const name = named.stdout.trim();
		if (named.exitCode === 0 && name && name !== 'undefined') {
			return name.replace(/^remotes\//, '');
		}
		const short = await execGit(['rev-parse', '--short', rev], cwd);
		return short.exitCode === 0 ? short.stdout.trim() : rev;
	}

	/**
	 * Everything the UI needs to describe and finish an in-progress operation.
	 *
	 * The `ours`/`theirs` labels matter more than they look: during a rebase git
	 * replays your commit on top of the upstream, so `--ours` is the upstream and
	 * `--theirs` is your own work — inverted relative to a merge. Surfacing the
	 * raw words without the branch names is what makes people pick the wrong side.
	 */
	async getOperationState(cwd: string): Promise<GitOperationState> {
		const { existsSync, readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const gitDir = await this.resolveGitDir(cwd);
		const readTrimmed = (...parts: string[]): string => {
			const target = join(gitDir, ...parts);
			try {
				return existsSync(target) ? readFileSync(target, 'utf-8').trim() : '';
			} catch {
				return '';
			}
		};

		const operation = await this.detectGitOperation(cwd);
		const unmerged = await this.getUnmergedPaths(cwd);
		const state: GitOperationState = {
			operation,
			oursLabel: 'ours',
			theirsLabel: 'theirs',
			unmergedCount: unmerged.length,
			canContinue: false,
			canSkip: false,
			stashConflict: false
		};

		const currentBranch = (await execGit(['branch', '--show-current'], cwd)).stdout.trim();

		if (operation === 'rebase') {
			// Interactive/merge-backend rebases use rebase-merge; `git am`-style ones
			// use rebase-apply. They spell the same counters differently.
			const isMerge = existsSync(join(gitDir, 'rebase-merge'));
			const dir = isMerge ? 'rebase-merge' : 'rebase-apply';
			const step = Number(readTrimmed(dir, isMerge ? 'msgnum' : 'next'));
			const total = Number(readTrimmed(dir, isMerge ? 'end' : 'last'));
			if (Number.isInteger(step) && step > 0) state.step = step;
			if (Number.isInteger(total) && total > 0) state.total = total;

			const headName = readTrimmed(dir, 'head-name').replace(/^refs\/heads\//, '');
			const onto = readTrimmed(dir, 'onto');
			state.oursLabel = onto ? await this.describeRef(cwd, onto) : 'upstream';
			state.theirsLabel = headName ? `your commit (${headName})` : 'your commit';

			const stopped = readTrimmed(dir, 'stopped-sha') || readTrimmed(dir, 'original-commit');
			if (stopped) state.currentCommit = await this.subjectOf(cwd, stopped);
			state.canSkip = true;
		} else if (operation === 'merge') {
			state.oursLabel = currentBranch || 'current branch';
			state.theirsLabel = await this.describeRef(cwd, 'MERGE_HEAD');
			state.currentCommit = await this.subjectOf(cwd, 'MERGE_HEAD');
		} else if (operation === 'cherry-pick' || operation === 'revert') {
			const head = operation === 'cherry-pick' ? 'CHERRY_PICK_HEAD' : 'REVERT_HEAD';
			state.oursLabel = currentBranch || 'current branch';
			state.theirsLabel = await this.describeRef(cwd, head);
			state.currentCommit = await this.subjectOf(cwd, head);
			state.canSkip = true;
		} else if (operation === null && unmerged.length > 0) {
			// Unmerged paths with no sentinel: a stash pop/apply that conflicted.
			state.stashConflict = true;
			state.oursLabel = currentBranch || 'working tree';
			state.theirsLabel = 'stashed changes';
		}

		// Bisect never has a "continue"; everything else is finishable once the
		// index is clean.
		state.canContinue =
			operation !== null && operation !== 'bisect' && unmerged.length === 0;

		return state;
	}

	/**
	 * Finish the in-progress operation. Returns the git output instead of throwing
	 * on failure, because the common failures here are instructions rather than
	 * errors — "nothing to commit, use --skip" is something the user must read.
	 */
	async continueOperation(cwd: string): Promise<{ success: boolean; message: string }> {
		const operation = await this.detectGitOperation(cwd);
		const unmerged = await this.getUnmergedPaths(cwd);
		if (unmerged.length > 0) {
			throw new Error(
				`${unmerged.length} file${unmerged.length === 1 ? ' is' : 's are'} still unmerged. Resolve and stage them first.`
			);
		}

		let args: string[];
		switch (operation) {
			case 'rebase':
				args = ['rebase', '--continue'];
				break;
			case 'merge':
				args = ['merge', '--continue'];
				break;
			case 'cherry-pick':
				args = ['cherry-pick', '--continue'];
				break;
			case 'revert':
				args = ['revert', '--continue'];
				break;
			default:
				throw new Error('There is no operation to continue.');
		}

		const result = await execGit(args, cwd, 120000);
		return {
			success: result.exitCode === 0,
			message: (result.exitCode === 0 ? result.stdout : result.stderr).trim()
		};
	}

	/** Drop the commit git is currently stuck on and move to the next one. */
	async skipOperation(cwd: string): Promise<{ success: boolean; message: string }> {
		const operation = await this.detectGitOperation(cwd);
		let args: string[];
		switch (operation) {
			case 'rebase':
				args = ['rebase', '--skip'];
				break;
			case 'cherry-pick':
				args = ['cherry-pick', '--skip'];
				break;
			case 'revert':
				args = ['revert', '--skip'];
				break;
			default:
				throw new Error('This operation cannot be skipped.');
		}

		const result = await execGit(args, cwd, 120000);
		return {
			success: result.exitCode === 0,
			message: (result.exitCode === 0 ? result.stdout : result.stderr).trim()
		};
	}

	/**
	 * Aborts the in-progress conflict-producing operation: merge, cherry-pick,
	 * revert, rebase, or a stash pop that left unmerged paths. We detect the
	 * type via `.git/*_HEAD` sentinel files and pick the matching abort command.
	 * For stash conflicts (no sentinel) we fall back to `git reset --merge`,
	 * which unwinds the unmerged paths while keeping unrelated local edits — the
	 * stash entry itself survives a failed pop, so nothing is actually lost.
	 */
	async abortOperation(cwd: string): Promise<void> {
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
			const result = await execGit(args, cwd, 120000);
			if (result.exitCode !== 0) {
				throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
			}
			return;
		}

		const reset = await execGit(['reset', '--merge'], cwd);
		if (reset.exitCode !== 0) {
			throw new Error(`git reset --merge failed: ${reset.stderr}`);
		}
	}

	/** Back-compat alias — the panel called this before rebase/cherry-pick were handled. */
	async abortMerge(cwd: string): Promise<void> {
		return this.abortOperation(cwd);
	}

	/**
	 * Rebase the current branch onto `upstream`.
	 *
	 * `--autostash` is on by default: without it git refuses to start whenever the
	 * working tree is dirty, which from the panel just looks like the button not
	 * working.
	 */
	async rebaseOnto(
		cwd: string,
		upstream: string,
		autostash = true
	): Promise<{ success: boolean; hasConflicts: boolean; message: string }> {
		assertSafeGitRevish(upstream, 'rebase upstream');
		const args = ['rebase'];
		if (autostash) args.push('--autostash');
		args.push(upstream);

		const result = await execGit(args, cwd, 120000);
		const combined = `${result.stdout}\n${result.stderr}`;
		const hasConflicts = /CONFLICT \(/.test(combined) || /could not apply/i.test(combined);
		if (result.exitCode !== 0 && !hasConflicts) {
			throw new Error(`git rebase failed: ${result.stderr || result.stdout}`);
		}
		return {
			success: result.exitCode === 0,
			hasConflicts,
			message: (result.exitCode === 0 ? result.stdout : result.stderr || result.stdout).trim()
		};
	}

	/** Restore the HEAD position recorded before the last checkout. */
	async returnToBranch(cwd: string, branch?: string): Promise<void> {
		if (branch) {
			await this.switchBranch(cwd, branch);
			return;
		}
		// `-` is git's own "previous checkout" shorthand, which is exactly what the
		// user wants after inspecting a commit from the history view.
		const result = await execGit(['checkout', '-'], cwd);
		if (result.exitCode !== 0) {
			throw new Error(
				`Could not return to the previous branch: ${result.stderr.trim() || 'no previous checkout recorded'}`
			);
		}
	}

	/** Read the repo's undo journal — the only way back from a bad reset or rebase. */
	async getReflog(cwd: string, limit = 100): Promise<GitReflogEntry[]> {
		const SEPARATOR = '|||';
		const format = `%H${SEPARATOR}%h${SEPARATOR}%gd${SEPARATOR}%gs${SEPARATOR}%cI`;
		const result = await execGit(
			['reflog', `--format=${format}`, `--max-count=${Math.max(1, Math.min(limit, 500))}`],
			cwd
		);
		if (result.exitCode !== 0) {
			if (!(await this.hasCommits(cwd))) return [];
			throw new Error(`git reflog failed: ${result.stderr}`);
		}
		return parseReflog(result.stdout);
	}

	// ============================================
	// History rewrite / undo
	// ============================================

	/**
	 * Undo the last commit by moving HEAD back one commit.
	 *  - `soft`  keeps the changes staged
	 *  - `mixed` keeps the changes in the working tree (unstaged)
	 *  - `hard`  discards the changes entirely (destructive)
	 *
	 * The root commit has no `HEAD~1` to reset onto, so undoing it means deleting
	 * the branch ref itself: `update-ref -d HEAD` returns the repo to the unborn
	 * state while leaving the index intact — which is exactly `--soft`. `--mixed`
	 * and `--hard` then unwind the index (and working tree) from there.
	 */
	async undoLastCommit(cwd: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
		if (!(await this.hasCommits(cwd))) {
			throw new Error('This repository has no commits yet, so there is nothing to undo.');
		}

		if (await this.hasParent(cwd)) {
			const flag = mode === 'soft' ? '--soft' : mode === 'hard' ? '--hard' : '--mixed';
			const result = await execGit(['reset', flag, 'HEAD~1'], cwd);
			if (result.exitCode !== 0) {
				throw new Error(`git reset ${flag} failed: ${result.stderr}`);
			}
			return;
		}

		// Root commit. `--hard` must discard the working tree while HEAD still
		// resolves — once the ref is gone there is no commit left to reset onto.
		if (mode === 'hard') {
			const discard = await execGit(['reset', '--hard', 'HEAD'], cwd);
			if (discard.exitCode !== 0) {
				throw new Error(`git reset --hard failed: ${discard.stderr}`);
			}
		}

		const removeRef = await execGit(['update-ref', '-d', 'HEAD'], cwd);
		if (removeRef.exitCode !== 0) {
			throw new Error(`git update-ref -d HEAD failed: ${removeRef.stderr}`);
		}

		if (mode === 'mixed') {
			// Drop the index so the commit's files come back as untracked changes.
			const unstage = await execGit(['reset'], cwd);
			if (unstage.exitCode !== 0) {
				throw new Error(`git reset failed: ${unstage.stderr}`);
			}
		} else if (mode === 'hard') {
			// Delete exactly what the commit tracked — unrelated untracked files
			// survive, matching `reset --hard HEAD~1` on a non-root commit. The
			// `:/` pathspec covers the whole work tree even when cwd is a subdir,
			// and `--ignore-unmatch` keeps an empty root commit from erroring.
			const clearIndex = await execGit(['rm', '-rf', '--quiet', '--ignore-unmatch', '--', ':/'], cwd);
			if (clearIndex.exitCode !== 0) {
				throw new Error(`git rm failed: ${clearIndex.stderr}`);
			}
		}
	}

	/** Create a new commit that reverses a previous one (default: HEAD). */
	async revertCommit(cwd: string, ref = 'HEAD'): Promise<{ success: boolean; message: string }> {
		assertSafeGitRevish(ref, 'revert ref');
		const result = await execGit(['revert', '--no-edit', ref], cwd);
		if (result.exitCode !== 0 && !(await this.hasCommits(cwd))) {
			// Unborn HEAD — git only reports `bad revision 'HEAD'`.
			return { success: false, message: 'This repository has no commits yet, so there is nothing to revert.' };
		}
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
