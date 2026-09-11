/**
 * The unit boundaries.
 *
 * The bug this replaced reported an hour-old item as "1 minute ago", which is
 * the kind of wrong that looks plausible: the number is right and only the unit
 * is off, so it survives a glance and is caught only by comparing against the
 * provider's own timestamp.
 */

import { describe, it, expect } from 'bun:test';

import { relativeTime } from './relative-time';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

describe('relativeTime', () => {
	it('names the right unit at each boundary', () => {
		expect(relativeTime(ago(60 * 60), NOW)).toBe('1 hour ago');
		expect(relativeTime(ago(9 * 60), NOW)).toBe('9 minutes ago');
		expect(relativeTime(ago(2 * 86400), NOW)).toBe('2 days ago');
		expect(relativeTime(ago(3 * 604800), NOW)).toBe('3 weeks ago');
		expect(relativeTime(ago(400 * 86400), NOW)).toBe('1 year ago');
	});

	it('does not round up into the next unit', () => {
		// 59 minutes is still minutes, and 23 hours is still hours.
		expect(relativeTime(ago(59 * 60), NOW)).toBe('59 minutes ago');
		expect(relativeTime(ago(23 * 3600), NOW)).toBe('23 hours ago');
	});

	it('singularises', () => {
		expect(relativeTime(ago(90), NOW)).toBe('1 minute ago');
		expect(relativeTime(ago(86400), NOW)).toBe('1 day ago');
	});

	it('says "just now" rather than a negative count', () => {
		expect(relativeTime(ago(5), NOW)).toBe('just now');
		// A provider clock a little ahead of ours.
		expect(relativeTime(ago(-30), NOW)).toBe('just now');
	});

	it('returns empty for an unparseable timestamp', () => {
		expect(relativeTime('not a date', NOW)).toBe('');
	});
});
