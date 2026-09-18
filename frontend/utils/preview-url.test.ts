import { describe, expect, test } from 'bun:test';
import { sameTabTarget } from './preview-url';

describe('matching a tab slot to the tab the backend opened', () => {
	test('sees through the spelling the two ends use', () => {
		// What the user typed, against what the navigation settled on.
		expect(sameTabTarget('localhost:3000', 'http://localhost:3000/')).toBe(true);
		expect(sameTabTarget('http://localhost:3000', 'http://localhost:3000')).toBe(true);
		expect(sameTabTarget('HTTP://LocalHost:3000/', 'http://localhost:3000')).toBe(true);
		expect(sameTabTarget('https://example.com/', 'http://example.com')).toBe(true);
	});

	test('follows a redirect deeper into the same site', () => {
		expect(sameTabTarget('localhost:5173', 'http://localhost:5173/login')).toBe(true);
		expect(sameTabTarget('http://localhost:5173/app', 'http://localhost:5173/app/dashboard')).toBe(
			true
		);
	});

	test('keeps two dev servers apart', () => {
		// The failure this function exists to avoid is folding one tab into
		// another, so a near-miss has to read as a miss.
		expect(sameTabTarget('localhost:3000', 'http://localhost:3001/')).toBe(false);
		expect(sameTabTarget('localhost:3000', 'http://localhost:30000/')).toBe(false);
		expect(sameTabTarget('localhost:3000', 'http://127.0.0.1:3000/')).toBe(false);
		expect(sameTabTarget('example.com', 'http://notexample.com/')).toBe(false);
	});

	test('treats a blank address as matching nothing', () => {
		expect(sameTabTarget('', 'http://localhost:3000/')).toBe(false);
		expect(sameTabTarget('localhost:3000', '')).toBe(false);
		expect(sameTabTarget('   ', '   ')).toBe(false);
	});
});
