import { describe, expect, test } from 'bun:test';
import { _test } from './usage';

describe('Claude Code Usage Probe Parser Helpers', () => {
	test('stripAnsi removes escape codes', () => {
		const raw = '\x1B[1mCurrent session:\x1B[0m \x1B[32m45% left\x1B[0m';
		expect(_test.stripAnsi(raw)).toBe('Current session: 45% left');
	});

	test('percentFromLine handles used and left strings', () => {
		expect(_test.percentFromLine('  45% left')).toBe(45);
		expect(_test.percentFromLine('  20% used')).toBe(80);
		expect(_test.percentFromLine('  0% used')).toBe(100);
		expect(_test.percentFromLine('  100% used')).toBe(0);
		expect(_test.percentFromLine('no percent here')).toBeNull();
	});

	test('extractPercent finds percentages in windows', () => {
		const text = `
			Some header text
			Current session:
			----------------
			  45% left
			Other stuff
		`;
		expect(_test.extractPercent('Current session', text)).toBe(45);
		expect(_test.extractPercent('Non existent', text)).toBeNull();
	});

	test('extractReset extracts reset text', () => {
		const text = `
			Current session:
			  45% left
			  Resets in 2h 15m
		`;
		expect(_test.extractReset('Current session', text)).toBe('Resets in 2h 15m');
	});

	test('deduplicateResetText removes duplicate repeats', () => {
		const raw = 'Resets 4:59pm (America/New_York)Resets 4:59pm (America/New_York)';
		expect(_test.deduplicateResetText(raw)).toBe('Resets 4:59pm (America/New_York)');
	});

	test('parseResetDate handles relative reset durations', () => {
		const dateStr = _test.parseResetDate('in 2h 15m');
		expect(dateStr).not.toBeNull();
		if (dateStr) {
			const parsed = new Date(dateStr);
			const diffMs = parsed.getTime() - Date.now();
			// should be roughly 2h 15m (8100 seconds)
			expect(diffMs / 1000).toBeGreaterThan(8000);
			expect(diffMs / 1000).toBeLessThan(8200);
		}
	});

	test('parseResetDate handles absolute dates', () => {
		// Test date parsing for relative stability
		const year = new Date().getFullYear();
		const dateStr = _test.parseResetDate(`Dec 25, ${year}, 4:59pm`);
		expect(dateStr).not.toBeNull();
		if (dateStr) {
			const parsed = new Date(dateStr);
			expect(parsed.getUTCMonth()).toBe(11); // December (0-indexed)
			expect(parsed.getUTCDate()).toBe(25);
		}
	});
});
