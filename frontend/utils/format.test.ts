import { describe, it, expect } from 'bun:test';

import { formatRelativeTime } from './format';

const NOW = new Date('2026-09-07T12:00:00Z').getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('formatRelativeTime', () => {
	it('collapses anything under a minute to "just now"', () => {
		expect(formatRelativeTime(ago(0), NOW)).toBe('just now');
		expect(formatRelativeTime(ago(59_000), NOW)).toBe('just now');
	});

	it('counts down in minutes, hours, then days', () => {
		expect(formatRelativeTime(ago(60_000), NOW)).toBe('1m ago');
		expect(formatRelativeTime(ago(90 * 60_000), NOW)).toBe('1h ago');
		expect(formatRelativeTime(ago(50 * 3_600_000), NOW)).toBe('2d ago');
	});

	it('switches to an absolute date past a week, when "6d ago" stops helping', () => {
		expect(formatRelativeTime(ago(8 * 86_400_000), NOW)).not.toContain('ago');
	});

	it('reads a future timestamp as "just now" rather than a negative age', () => {
		// The server stamps updated_at; a browser clock a few seconds behind must
		// not render "-1m ago".
		expect(formatRelativeTime(new Date(NOW + 30_000).toISOString(), NOW)).toBe('just now');
	});

	it('returns an empty string for an unparseable value instead of "NaN ago"', () => {
		expect(formatRelativeTime('not a date', NOW)).toBe('');
	});
});
