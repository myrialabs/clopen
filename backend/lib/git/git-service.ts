/**
 * Git Service
 * High-level git operations built on top of executor and parser
 */

import { execGit, isGitRepo, getGitRoot } from './git-executor';
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
	GitFileDiff,
	GitLogResult,
	GitRemote,
	GitStashEntry,
	GitConflictFile
} from '$shared/types/git';
import { debug } from '$shared/utils/logger';

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
		if (defaultBranch) args.push('-b', defaultBranch);
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
		// Try normal reset first, fall back to rm --cached for initial commit
		const result = await execGit(['reset', 'HEAD', '--', filePath], cwd);
		if (result.exitCode !== 0) {
			const fallback = await execGit(['rm', '--cached', '--', filePath], cwd);
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
		if (filePath) args.push('--', filePath);
		const result = await execGit(args, cwd);
		return parseDiff(result.stdout);
	}

	async getDiffStaged(cwd: string, filePath?: string): Promise<GitFileDiff[]> {
		const args = ['diff', '--cached'];
		if (filePath) args.push('--', filePath);
		const result = await execGit(args, cwd);
		return parseDiff(result.stdout);
	}

	async getDiffCommit(cwd: string, commitHash: string): Promise<GitFileDiff[]> {
		const result = await execGit(['diff', `${commitHash}^`, commitHash], cwd);
		return parseDiff(result.stdout);
	}

	async getDiffBetween(cwd: string, from: string, to: string): Promise<GitFileDiff[]> {
		const result = await execGit(['diff', from, to], cwd);
		return parseDiff(result.stdout);
	}

	// ============================================
	// Branches
	// ============================================

	async getBranches(cwd: string): Promise<GitBranchInfo> {
		const [localResult, remoteResult] = await Promise.all([
			execGit(['branch', '-v', '--no-color'], cwd),
			execGit(['branch', '-r', '-v', '--no-color'], cwd)
		]);

		// Handle empty repo (no commits yet) — branch command returns empty
		if (!localResult.stdout.trim()) {
			// Try to get the initial branch name from HEAD
			const headResult = await execGit(['symbolic-ref', '--short', 'HEAD'], cwd);
			const initialBranch = headResult.exitCode === 0 ? headResult.stdout.trim() : 'main';
			return { current: initialBranch, local: [], remote: [], ahead: 0, behind: 0 };
		}

		const branchInfo = parseBranches(localResult.stdout, remoteResult.stdout);

		// Get ahead/behind for current branch
		if (branchInfo.current) {
			try {
				const abResult = await execGit(
					['rev-list', '--left-right', '--count', `${branchInfo.current}...@{upstream}`],
					cwd
				);
				if (abResult.exitCode === 0) {
					const { ahead, behind } = parseAheadBehind(abResult.stdout);
					branchInfo.ahead = ahead;
					branchInfo.behind = behind;

					// Update the current branch entry too
					const currentBranch = branchInfo.local.find(b => b.isCurrent);
					if (currentBranch) {
						currentBranch.ahead = ahead;
						currentBranch.behind = behind;
					}
				}
			} catch {
				// No upstream configured
			}
		}

		return branchInfo;
	}

	async createBranch(cwd: string, name: string, startPoint?: string): Promise<void> {
		const args = ['checkout', '-b', name];
		if (startPoint) args.push(startPoint);
		const result = await execGit(args, cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git checkout -b failed: ${result.stderr}`);
		}
	}

	async switchBranch(cwd: string, name: string): Promise<void> {
		const result = await execGit(['checkout', name], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git checkout failed: ${result.stderr}`);
		}
	}

	async deleteBranch(cwd: string, name: string, force = false): Promise<void> {
		const flag = force ? '-D' : '-d';
		const result = await execGit(['branch', flag, name], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git branch ${flag} failed: ${result.stderr}`);
		}
	}

	async renameBranch(cwd: string, oldName: string, newName: string): Promise<void> {
		const result = await execGit(['branch', '-m', oldName, newName], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git branch -m failed: ${result.stderr}`);
		}
	}

	async mergeBranch(cwd: string, branchName: string): Promise<{ success: boolean; message: string }> {
		const result = await execGit(['merge', branchName], cwd);
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
			`--format=${format}`,
			`--max-count=${limit + 1}`, // +1 to check if there are more
			`--skip=${skip}`
		];

		if (branch) args.push(branch);

		const result = await execGit(args, cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git log failed: ${result.stderr}`);
		}

		const commits = parseLog(result.stdout);
		const hasMore = commits.length > limit;
		if (hasMore) commits.pop(); // Remove the extra one

		// Get total count
		const countResult = await execGit(['rev-list', '--count', branch || 'HEAD'], cwd);
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
		const result = await execGit(['fetch', remote, '--prune'], cwd, 60000);
		if (result.exitCode !== 0) {
			throw new Error(`git fetch failed: ${result.stderr}`);
		}
		return result.stderr || result.stdout; // git fetch outputs to stderr
	}

	async pull(cwd: string, remote = 'origin', branch?: string): Promise<{ success: boolean; message: string }> {
		const args = ['pull', remote];
		if (branch) args.push(branch);
		const result = await execGit(args, cwd, 60000);
		return {
			success: result.exitCode === 0,
			message: result.exitCode === 0 ? result.stdout : result.stderr
		};
	}

	async push(cwd: string, remote = 'origin', branch?: string, force = false): Promise<{ success: boolean; message: string }> {
		const args = ['push', remote];
		if (branch) args.push(branch);
		if (force) args.push('--force-with-lease');
		// Set upstream if needed
		args.push('-u');
		const result = await execGit(args, cwd, 60000);
		return {
			success: result.exitCode === 0,
			message: result.exitCode === 0 ? (result.stderr || result.stdout) : result.stderr
		};
	}

	async addRemote(cwd: string, name: string, url: string): Promise<void> {
		const result = await execGit(['remote', 'add', name, url], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git remote add failed: ${result.stderr}`);
		}
	}

	async removeRemote(cwd: string, name: string): Promise<void> {
		const result = await execGit(['remote', 'remove', name], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git remote remove failed: ${result.stderr}`);
		}
	}

	// ============================================
	// Stash
	// ============================================

	async stashList(cwd: string): Promise<GitStashEntry[]> {
		const result = await execGit(['stash', 'list'], cwd);
		return parseStashList(result.stdout);
	}

	async stashSave(cwd: string, message?: string): Promise<void> {
		const args = ['stash', 'push'];
		if (message) args.push('-m', message);
		const result = await execGit(args, cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git stash failed: ${result.stderr}`);
		}
	}

	async stashPop(cwd: string, index = 0): Promise<void> {
		const result = await execGit(['stash', 'pop', `stash@{${index}}`], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git stash pop failed: ${result.stderr}`);
		}
	}

	async stashDrop(cwd: string, index = 0): Promise<void> {
		const result = await execGit(['stash', 'drop', `stash@{${index}}`], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git stash drop failed: ${result.stderr}`);
		}
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
		const args = ['tag'];
		if (message) {
			args.push('-a', name, '-m', message);
		} else {
			args.push(name);
		}
		if (commitHash) args.push(commitHash);
		const result = await execGit(args, cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git tag failed: ${result.stderr}`);
		}
	}

	async deleteTag(cwd: string, name: string): Promise<void> {
		const result = await execGit(['tag', '-d', name], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git tag -d failed: ${result.stderr}`);
		}
	}

	async pushTag(cwd: string, name: string, remote = 'origin'): Promise<{ success: boolean; message: string }> {
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

	async abortMerge(cwd: string): Promise<void> {
		const result = await execGit(['merge', '--abort'], cwd);
		if (result.exitCode !== 0) {
			throw new Error(`git merge --abort failed: ${result.stderr}`);
		}
	}
}

// Singleton
export const gitService = new GitService();
