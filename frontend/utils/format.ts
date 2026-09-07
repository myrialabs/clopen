export function formatProvider(provider: string): string {
	return provider
		.split(/[-_]/)
		.map(w => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}

export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
	}
	if (tokens >= 1_000) {
		return `${(tokens / 1_000).toFixed(tokens % 1_000 === 0 ? 0 : 1)}K`;
	}
	return `${tokens}`;
}

export function formatFileSize(bytes: number): string {
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A timestamp as a short relative phrase ("2h ago"), falling back to an
 * absolute date once "days ago" stops being useful.
 *
 * List rows put this next to the content they describe, where the exact second
 * is noise and the full locale string is wide enough to squeeze out the text
 * beside it.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return '';

	const elapsed = now - then;
	// A clock skew between server and browser must not read as "in 3 minutes".
	if (elapsed < MINUTE) return 'just now';
	if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
	if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
	if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;

	const date = new Date(then);
	const sameYear = date.getFullYear() === new Date(now).getFullYear();
	return date.toLocaleDateString(undefined, {
		day: 'numeric',
		month: 'short',
		...(sameYear ? {} : { year: 'numeric' })
	});
}
