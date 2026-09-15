/**
 * The unit boundaries.
 *
 * The bug this replaced reported an hour-old item as "1 minute ago", which is
 * the kind of wrong that looks plausible: the number is right and only the unit
 * is off, so it survives a glance and is caught only by comparing against the
 * provider's own timestamp.
 */

import { describe, it, expect } from 'bun:test';

import { relativeTime, shortRelativeTime } from './relative-time';

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

describe('shortRelativeTime', () => {
	const now = new Date('2026-01-01T12:00:00Z').getTime();
	const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

	it('abbreviates every unit', () => {
		expect(shortRelativeTime(ago(120), now)).toBe('2m ago');
		expect(shortRelativeTime(ago(3 * 3600), now)).toBe('3h ago');
		expect(shortRelativeTime(ago(2 * 86400), now)).toBe('2d ago');
		expect(shortRelativeTime(ago(14 * 86400), now)).toBe('2w ago');
		expect(shortRelativeTime(ago(60 * 86400), now)).toBe('2mo ago');
		expect(shortRelativeTime(ago(400 * 86400), now)).toBe('1y ago');
	});

	it('says "now" rather than a count inside the skew window', () => {
		// Clock skew against a provider would otherwise render as a negative count.
		expect(shortRelativeTime(ago(10), now)).toBe('now');
		expect(shortRelativeTime(ago(-5), now)).toBe('now');
	});

	it('picks the same unit boundaries as the long form', () => {
		// An hour-old item must not read as minutes — the bug the long form had.
		expect(shortRelativeTime(ago(3600), now)).toBe('1h ago');
		expect(shortRelativeTime(ago(3599), now)).toBe('59m ago');
	});
});
