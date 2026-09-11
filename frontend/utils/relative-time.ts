/**
 * "3 days ago".
 *
 * Written as explicit thresholds rather than a divide-and-relabel loop. The
 * loop version this replaced was off by one unit — it divided by 60 and then
 * applied the PREVIOUS unit's name, so an hour-old item read as "1 minute ago"
 * — and the mistake is invisible until you compare against a real timestamp.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function plural(value: number, unit: string): string {
	const rounded = Math.floor(value);
	return `${rounded} ${unit}${rounded === 1 ? '' : 's'} ago`;
}

/** `now` is injectable so the behaviour can be tested without faking the clock. */
export function relativeTime(iso: string, now: number = Date.now()): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return '';

	const seconds = Math.round((now - then) / 1000);
	// Clock skew of a few seconds between this machine and a provider would
	// otherwise render as "in 3 seconds", or as a negative count.
	if (seconds < 45) return 'just now';
	if (seconds < HOUR) return plural(seconds / MINUTE, 'minute');
	if (seconds < DAY) return plural(seconds / HOUR, 'hour');
	if (seconds < WEEK) return plural(seconds / DAY, 'day');
	if (seconds < MONTH) return plural(seconds / WEEK, 'week');
	if (seconds < YEAR) return plural(seconds / MONTH, 'month');
	return plural(seconds / YEAR, 'year');
}
