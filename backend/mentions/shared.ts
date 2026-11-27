/**
 * Helpers the mention sources share.
 */

import { bestFuzzyScore } from '$shared/utils/fuzzy';
import { execGit } from '$backend/git/git-executor';

/**
 * Keep what matches `query`, best first, at most `limit`. With no query the
 * order given is kept — sources list most recent or most relevant first.
 */
export function rank<T>(items: T[], query: string, texts: (item: T) => Array<string | undefined | null>, limit: number): T[] {
	if (!query.trim()) return items.slice(0, limit);
	return items
		.map((item, order) => ({ item, order, score: bestFuzzyScore(query, texts(item)) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.order - b.order)
		.slice(0, limit)
		.map((entry) => entry.item);
}

/** Whether `category` is the one asked for, or the root is. */
export function wants(category: string | undefined, own: string): 'root' | 'own' | null {
	if (!category) return 'root';
	return category === own ? 'own' : null;
}

/** Resolve within `ms`, or with `fallback`. A slow source must not hold the picker. */
export async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<T>((resolve) => {
				timer = setTimeout(() => resolve(fallback), ms);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** A git command's output, or null when it fails (not a repo, no git, bad ref). */
export async function gitText(args: string[], cwd: string, timeout = 20_000, okExitCodes: number[] = []): Promise<string | null> {
	try {
		const result = await execGit(args, cwd, { timeout, okExitCodes });
		return result.stdout;
	} catch {
		return null;
	}
}

/** "3 minutes ago" for a timestamp, for a row's detail line. */
export function ago(value: string | number | Date | null | undefined): string {
	if (value === null || value === undefined || value === '') return '';
	const time = new Date(value).getTime();
	if (!Number.isFinite(time)) return '';
	const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
	if (seconds < 60) return 'just now';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days} d ago`;
	return new Date(time).toISOString().slice(0, 10);
}

/** Remove terminal escape sequences, leaving the text a person saw. */
export function stripAnsi(text: string): string {
	return (
		text
			// OSC (titles, hyperlinks), ended by BEL or ST.
			.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
			// CSI sequences: colours, cursor moves, erases.
			.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
			// Other two-character escapes.
			.replace(/\u001b[@-Z\\-_]/g, '')
			// Lone control characters except tab and newline.
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
	);
}
