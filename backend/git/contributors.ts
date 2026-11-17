/**
 * Contributors of a repository: who authored the most recent commits, how many
 * each, and when they were last active.
 *
 * Computed here rather than in the panel. The panel used to download the last
 * 500 commits in full (~166 KB on this repository) on every git change just to
 * count authors; now it receives the counts, and a contributor's own commits
 * only when that contributor is expanded. Both read the same window through the
 * same `getLog`, so the numbers are exactly what the panel computed before.
 */

import type { GitCommit } from '$shared/types/git';

/** How many recent commits the Contributors view covers. */
export const CONTRIBUTOR_WINDOW = 500;

export interface ContributorSummary {
	/** Grouping key: lowercased email when present, else author name. */
	key: string;
	name: string;
	email: string;
	count: number;
	/** ISO date of this contributor's most recent commit. */
	lastDate: string;
}

/** The grouping key for one commit — one person may commit under several names. */
export function contributorKey(commit: Pick<GitCommit, 'author' | 'authorEmail'>): string {
	return (commit.authorEmail || commit.author).toLowerCase().trim();
}

/** Group commits by author, most commits first (ties keep first-seen order). */
export function aggregateContributors(commits: GitCommit[]): ContributorSummary[] {
	const map = new Map<string, ContributorSummary>();
	for (const commit of commits) {
		const key = contributorKey(commit);
		const existing = map.get(key);
		if (existing) {
			existing.count++;
			if (commit.date > existing.lastDate) existing.lastDate = commit.date;
		} else {
			map.set(key, { key, name: commit.author.trim(), email: commit.authorEmail, count: 1, lastDate: commit.date });
		}
	}
	return [...map.values()].sort((a, b) => b.count - a.count);
}
