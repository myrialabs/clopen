/**
 * Reading SQLite timestamps as the UTC they actually are.
 *
 * `CURRENT_TIMESTAMP` writes `YYYY-MM-DD HH:MM:SS` in UTC, with no zone marker.
 * Handed to `Date.parse`, that string is not ISO-8601, so V8 falls back to its
 * legacy parser and interprets it as LOCAL time. On a machine at UTC+7 every row
 * therefore reads as seven hours in the future: `Date.now() - parsed` is
 * negative, every age is understated by the offset, and the `Math.max(0, …)`
 * that guards against a negative age hides the whole thing — a memory written
 * this morning simply looks brand new all day.
 *
 * Nothing crashes, which is why it survived: retrieval's recency term stays
 * pinned at its maximum for the length of the offset, and consolidation's
 * "at least seven days old" gate silently means seven days and seven hours.
 * Appending the zone is the entire fix.
 */

/** Milliseconds since the epoch for a SQLite `datetime` value, or NaN. */
export function parseSqliteTime(value: string | null | undefined): number {
	if (!value) return Number.NaN;
	// Already carries a zone or a `T` separator (an ISO value from elsewhere).
	if (value.includes('T') || value.endsWith('Z')) return Date.parse(value);
	return Date.parse(`${value.replace(' ', 'T')}Z`);
}

/** Age of a SQLite timestamp in days, never negative, 0 when unparseable. */
export function ageInDays(value: string | null | undefined): number {
	const parsed = parseSqliteTime(value);
	if (Number.isNaN(parsed)) return 0;
	return Math.max(0, (Date.now() - parsed) / 86_400_000);
}
