/**
 * Shared git status utilities for label and color mapping.
 * Used by FileChangeItem, DiffViewer, and GitPanel tab bar.
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
