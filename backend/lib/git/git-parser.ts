/**
 * Git Output Parser
 * Parses git CLI output into structured data
 */

import type {
	GitFileChange,
	GitStatus,
	GitBranch,
	GitBranchInfo,
	GitFileDiff,
	GitDiffHunk,
	GitDiffLine,
	GitCommit,
	GitRemote,
	GitStashEntry,
	GitConflictMarker
} from '$shared/types/git';

/**
 * Unescape git backslash sequences (octal escapes, \n, \t, \\, \").
 * Used for paths that were inside git quotes.
 */
function unescapeGitPath(p: string): string {
	return p
		.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(parseInt(octal, 8)))
		.replace(/\\n/g, '\n')
		.replace(/\\t/g, '\t')
		.replace(/\\\\/g, '\\')
		.replace(/\\"/g, '"');
}

/**
 * Unquote a git path that may be wrapped in double quotes.
 * Git quotes paths containing spaces, non-ASCII chars, etc.
 * e.g. `"public-2/myrialabs (1).jpeg"` → `public-2/myrialabs (1).jpeg`
 */
function unquoteGitPath(p: string): string {
	if (p.startsWith('"') && p.endsWith('"')) {
		return unescapeGitPath(p.slice(1, -1));
	}
	return p;
}

/**
 * Parse `git status --porcelain=v1` output
 */
export function parseStatus(output: string): GitStatus {
	const staged: GitFileChange[] = [];
	const unstaged: GitFileChange[] = [];
	const untracked: GitFileChange[] = [];
	const conflicted: GitFileChange[] = [];

	const lines = output.split('\n').filter(Boolean);

	for (const line of lines) {
		const indexStatus = line[0];
		const workingStatus = line[1];
		let path = line.substring(3);
		let oldPath: string | undefined;

		// Handle renames: "R  old -> new" (paths may be individually quoted)
		const renameMatch = path.match(/^(.+?) -> (.+)$/);
		if (renameMatch) {
			oldPath = unquoteGitPath(renameMatch[1]);
			path = unquoteGitPath(renameMatch[2]);
		} else {
			path = unquoteGitPath(path);
		}

		const change: GitFileChange = { path, indexStatus, workingStatus, oldPath };

		// Conflict detection (both modified, etc.)
		if (
			(indexStatus === 'U' || workingStatus === 'U') ||
			(indexStatus === 'A' && workingStatus === 'A') ||
			(indexStatus === 'D' && workingStatus === 'D')
		) {
			conflicted.push(change);
			continue;
		}

		// Untracked
		if (indexStatus === '?' && workingStatus === '?') {
			untracked.push(change);
			continue;
		}

		// Staged changes (index status is not space or ?)
		if (indexStatus !== ' ' && indexStatus !== '?') {
			staged.push(change);
		}

		// Unstaged changes (working tree status is not space)
		if (workingStatus !== ' ' && workingStatus !== '?') {
			unstaged.push(change);
		}
	}

	return { staged, unstaged, untracked, conflicted };
}

/**
 * Parse `git branch -a -v --format` output
 */
export function parseBranches(localOutput: string, remoteOutput: string): GitBranchInfo {
	const local: GitBranch[] = [];
	const remote: GitBranch[] = [];
	let current = '';

	// Parse local branches
	const localLines = localOutput.split('\n').filter(Boolean);
	for (const line of localLines) {
		// Format: "* main abc1234 commit message" or "  dev abc1234 commit message"
		const isCurrent = line.startsWith('*');
		const trimmed = line.replace(/^\*?\s+/, '');
		const parts = trimmed.split(/\s+/);
		const name = parts[0];
		const lastCommit = parts[1] || '';

		if (isCurrent) current = name;

		local.push({
			name,
			isCurrent,
			isRemote: false,
			ahead: 0,
			behind: 0,
			lastCommit
		});
	}

	// Parse remote branches
	const remoteLines = remoteOutput.split('\n').filter(Boolean);
	for (const line of remoteLines) {
		const trimmed = line.trim();
		if (trimmed.includes('->')) continue; // Skip HEAD pointers
		const parts = trimmed.split(/\s+/);
		const name = parts[0];
		const lastCommit = parts[1] || '';

		remote.push({
			name,
			isCurrent: false,
			isRemote: true,
			ahead: 0,
			behind: 0,
			lastCommit
		});
	}

	return { current, local, remote, ahead: 0, behind: 0 };
}

/**
 * Parse `git rev-list --left-right --count` output for ahead/behind
 */
export function parseAheadBehind(output: string): { ahead: number; behind: number } {
	const trimmed = output.trim();
	if (!trimmed) return { ahead: 0, behind: 0 };

	const parts = trimmed.split(/\s+/);
	return {
		ahead: parseInt(parts[0]) || 0,
		behind: parseInt(parts[1]) || 0
	};
}

/**
 * Parse unified diff output into structured data
 */
export function parseDiff(output: string): GitFileDiff[] {
	const files: GitFileDiff[] = [];
	if (!output.trim()) return files;

	const diffSections = output.split(/^diff --git /m).filter(Boolean);

	for (const section of diffSections) {
		const lines = section.split('\n');
		const headerLine = lines[0]; // a/file b/file (may be quoted)

		// Parse file paths — handle both quoted and unquoted forms
		// Quoted: "a/path with spaces" "b/path with spaces"
		// Unquoted: a/file b/file
		let oldPath: string;
		let newPath: string;
		const isQuoted = headerLine.startsWith('"');
		const quotedMatch = headerLine.match(/^"?a\/(.+?)"?\s+"?b\/(.+?)"?\s*$/);
		if (quotedMatch) {
			// Unescape octal sequences if the header was quoted
			oldPath = isQuoted ? unescapeGitPath(quotedMatch[1]) : quotedMatch[1];
			newPath = isQuoted ? unescapeGitPath(quotedMatch[2]) : quotedMatch[2];
		} else {
			const pathMatch = headerLine.match(/a\/(.+?) b\/(.+)/);
			if (!pathMatch) continue;
			oldPath = pathMatch[1];
			newPath = pathMatch[2];
		}

		// Detect binary
		const isBinary = section.includes('Binary files');
		if (isBinary) {
			files.push({ oldPath, newPath, status: 'M', hunks: [], isBinary: true });
			continue;
		}

		// Detect status from diff header
		let status = 'M';
		if (section.includes('new file mode')) status = 'A';
		else if (section.includes('deleted file mode')) status = 'D';
		else if (section.includes('rename from')) status = 'R';

		// Parse hunks
		const hunks: GitDiffHunk[] = [];
		let currentHunk: GitDiffHunk | null = null;
		let oldLineNum = 0;
		let newLineNum = 0;

		for (const line of lines) {
			// Hunk header: @@ -oldStart,oldLines +newStart,newLines @@ optional context
			const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
			if (hunkMatch) {
				if (currentHunk) hunks.push(currentHunk);

				const oldStart = parseInt(hunkMatch[1]);
				const oldLines = parseInt(hunkMatch[2] ?? '1');
				const newStart = parseInt(hunkMatch[3]);
				const newLines = parseInt(hunkMatch[4] ?? '1');
				const header = hunkMatch[5]?.trim() || '';

				currentHunk = { oldStart, oldLines, newStart, newLines, header, lines: [] };
				oldLineNum = oldStart;
				newLineNum = newStart;
				continue;
			}

			if (!currentHunk) continue;

			if (line.startsWith('+')) {
				currentHunk.lines.push({
					type: 'add',
					content: line.substring(1),
					newLineNumber: newLineNum++
				});
			} else if (line.startsWith('-')) {
				currentHunk.lines.push({
					type: 'delete',
					content: line.substring(1),
					oldLineNumber: oldLineNum++
				});
			} else if (line.startsWith(' ') || line === '') {
				currentHunk.lines.push({
					type: 'context',
					content: line.substring(1),
					oldLineNumber: oldLineNum++,
					newLineNumber: newLineNum++
				});
			} else if (line.startsWith('\\')) {
				// "\ No newline at end of file"
				currentHunk.lines.push({
					type: 'header',
					content: line
				});
			}
		}

		if (currentHunk) hunks.push(currentHunk);

		files.push({ oldPath, newPath, status, hunks, isBinary: false });
	}

	return files;
}

/**
 * Parse `git log --format` output
 */
export function parseLog(output: string): GitCommit[] {
	const commits: GitCommit[] = [];
	if (!output.trim()) return commits;

	// Format: hash|shortHash|author|email|date|parents|refs\nsubject\0
	const SEPARATOR = '|||';
	const entries = output.split('\0').map(e => e.trim()).filter(Boolean);

	for (const entry of entries) {
		const firstNewline = entry.indexOf('\n');
		const headerLine = firstNewline >= 0 ? entry.substring(0, firstNewline) : entry;
		const message = firstNewline >= 0 ? entry.substring(firstNewline + 1).trim() : '';

		const parts = headerLine.split(SEPARATOR);
		if (parts.length < 6) continue;

		commits.push({
			hash: parts[0],
			hashShort: parts[1],
			author: parts[2],
			authorEmail: parts[3],
			date: parts[4],
			parents: parts[5] ? parts[5].split(' ').filter(Boolean) : [],
			refs: parts[6] ? parts[6].split(', ').filter(Boolean) : [],
			message
		});
	}

	return commits;
}

/**
 * Parse `git remote -v` output
 */
export function parseRemotes(output: string): GitRemote[] {
	const remoteMap = new Map<string, GitRemote>();
	const lines = output.split('\n').filter(Boolean);

	for (const line of lines) {
		const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
		if (!match) continue;

		const [, name, url, type] = match;
		if (!remoteMap.has(name)) {
			remoteMap.set(name, { name, fetchUrl: '', pushUrl: '' });
		}

		const remote = remoteMap.get(name)!;
		if (type === 'fetch') remote.fetchUrl = url;
		else remote.pushUrl = url;
	}

	return Array.from(remoteMap.values());
}

/**
 * Parse `git stash list` output
 */
export function parseStashList(output: string): GitStashEntry[] {
	const entries: GitStashEntry[] = [];
	const lines = output.split('\n').filter(Boolean);

	for (const line of lines) {
		const match = line.match(/^stash@\{(\d+)\}:\s*(.+)$/);
		if (match) {
			entries.push({
				index: parseInt(match[1]),
				message: match[2],
				date: ''
			});
		}
	}

	return entries;
}

/**
 * Parse conflict markers from file content
 */
export function parseConflictMarkers(content: string): GitConflictMarker[] {
	const markers: GitConflictMarker[] = [];
	const lines = content.split('\n');

	let i = 0;
	while (i < lines.length) {
		if (lines[i].startsWith('<<<<<<<')) {
			const ourStart = i;
			let baseStart: number | undefined;
			let separatorIndex = -1;
			let theirEnd = -1;

			// Find the rest of the conflict
			let j = i + 1;
			while (j < lines.length) {
				if (lines[j].startsWith('|||||||')) {
					baseStart = j;
				} else if (lines[j].startsWith('=======')) {
					separatorIndex = j;
				} else if (lines[j].startsWith('>>>>>>>')) {
					theirEnd = j;
					break;
				}
				j++;
			}

			if (separatorIndex >= 0 && theirEnd >= 0) {
				const ourContentStart = ourStart + 1;
				const ourContentEnd = baseStart !== undefined ? baseStart : separatorIndex;
				const theirContentStart = separatorIndex + 1;

				const marker: GitConflictMarker = {
					ourStart,
					ourEnd: separatorIndex,
					theirStart: separatorIndex,
					theirEnd,
					ourContent: lines.slice(ourContentStart, ourContentEnd).join('\n'),
					theirContent: lines.slice(theirContentStart, theirEnd).join('\n')
				};

				if (baseStart !== undefined) {
					marker.baseStart = baseStart;
					marker.baseContent = lines.slice(baseStart + 1, separatorIndex).join('\n');
				}

				markers.push(marker);
				i = theirEnd + 1;
				continue;
			}
		}
		i++;
	}

	return markers;
}
