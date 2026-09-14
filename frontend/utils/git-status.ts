import type { GitFileChange, GitStatus } from '$shared/types/git';

/**
 * Shared git status utilities: label and colour mapping, plus the lookup maps
 * the file tree and the AI-change marker read.
 * Used by FileChangeItem, DiffViewer, GitPanel tab bar, and the git-status store.
 *
 * Status codes (from git status --porcelain=v1):
 *   M = Modified, A = Added, D = Deleted, R = Renamed,
 *   C = Copied, U = Unmerged, ? = Untracked, T = Type changed
 */

/** Maps a raw git status code to a single-letter display label */
export function getGitStatusLabel(status: string): string {
	switch (status) {
		case '?': return 'U';
		case 'A': return 'A';
		case 'D': return 'D';
		case 'M': return 'M';
		case 'R': return 'R';
		case 'C': return 'C';
		case 'U': return 'U';
		case 'T': return 'T';
		default: return status || '';
	}
}

/** Maps a raw git status code to a Tailwind text color class */
export function getGitStatusColor(status: string): string {
	switch (status) {
		case '?': return 'text-emerald-500';
		case 'A': return 'text-emerald-500';
		case 'D': return 'text-red-500';
		case 'M': return 'text-amber-500';
		case 'R': return 'text-blue-500';
		case 'C': return 'text-teal-500';
		case 'U': return 'text-orange-500';
		case 'T': return 'text-violet-500';
		default: return 'text-slate-500';
	}
}

/** Maps a raw git status code to a full-word label (for badges/headers) */
export function getGitStatusBadgeLabel(status: string): string {
	switch (status) {
		case '?': return 'Untracked';
		case 'A': return 'Added';
		case 'D': return 'Deleted';
		case 'M': return 'Modified';
		case 'R': return 'Renamed';
		case 'C': return 'Copied';
		case 'U': return 'Unmerged';
		case 'T': return 'Type Changed';
		default: return status || '';
	}
}

/** Maps a raw git status code to Tailwind badge bg+text color classes */
export function getGitStatusBadgeColor(status: string): string {
	switch (status) {
		case '?': return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400';
		case 'A': return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400';
		case 'D': return 'bg-red-500/15 text-red-600 dark:text-red-400';
		case 'M': return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
		case 'R': return 'bg-blue-500/15 text-blue-600 dark:text-blue-400';
		case 'C': return 'bg-teal-500/15 text-teal-600 dark:text-teal-400';
		case 'U': return 'bg-orange-500/15 text-orange-600 dark:text-orange-400';
		case 'T': return 'bg-violet-500/15 text-violet-600 dark:text-violet-400';
		default: return 'bg-slate-500/15 text-slate-600 dark:text-slate-400';
	}
}

/**
 * Aggregation priority — the highest-priority status visible determines
 * a folder's color. Conflicts and untracked files surface above plain mods.
 */
const FOLDER_STATUS_PRIORITY: Record<string, number> = {
	U: 100,
	'?': 80,
	M: 70,
	D: 60,
	A: 50,
	R: 40,
	C: 30,
	T: 20
};

/**
 * Pick the most meaningful single status code for a change entry.
 * Prefers working-tree status, falls back to index status. Untracked is `?`.
 */
function pickStatusCode(change: GitFileChange): string {
	const w = (change.workingStatus || '').trim();
	const i = (change.indexStatus || '').trim();
	if (w && w !== ' ') return w;
	if (i && i !== ' ') return i;
	return '';
}

export function buildGitStatusMaps(
	status: GitStatus,
	projectPath: string
): { map: Map<string, string>; folderMap: Map<string, string>; unstagedSet: Set<string> } {
	const map = new Map<string, string>();
	const folderMap = new Map<string, string>();
	const unstagedSet = new Set<string>();
	const sep = projectPath.includes('\\') ? '\\' : '/';

	const upsertFolder = (folderPath: string, code: string) => {
		const existing = folderMap.get(folderPath);
		const newRank = FOLDER_STATUS_PRIORITY[code] ?? 0;
		const oldRank = existing ? (FOLDER_STATUS_PRIORITY[existing] ?? 0) : -1;
		if (newRank > oldRank) folderMap.set(folderPath, code);
	};

	const collect = (entries: GitFileChange[], working: boolean) => {
		for (const change of entries) {
			const code = pickStatusCode(change);
			if (!code) continue;
			const rel = sep === '\\' ? change.path.replace(/\//g, '\\') : change.path;
			const absolute = `${projectPath}${sep}${rel}`;
			map.set(absolute, code);
			if (working) unstagedSet.add(absolute);

			// Walk all ancestors up to (excluding) project root and aggregate
			let cursor = absolute;
			while (true) {
				const idx = cursor.lastIndexOf(sep);
				if (idx <= 0) break;
				cursor = cursor.slice(0, idx);
				if (cursor === projectPath || cursor.length < projectPath.length) break;
				upsertFolder(cursor, code);
			}
		}
	};

	// A conflicted file is unresolved in the working tree by definition, and a
	// partially staged file appears in both lists — which is why membership is
	// added per list rather than decided once per file.
	collect(status.conflicted, true);
	collect(status.staged, false);
	collect(status.unstaged, true);
	collect(status.untracked, true);

	return { map, folderMap, unstagedSet };
}
