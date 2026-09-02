import { describe, expect, test } from 'bun:test';
import { bestFuzzyScore, fuzzyMatch } from './fuzzy';

/** Command-palette entries the scorer has to keep reachable. */
const DARK_MODE = ['Toggle Dark Mode', 'Switch between light and dark themes', 'theme', 'dark'];
const NEW_SESSION = ['New Chat Session', 'Start a fresh session', 'chat', 'session', 'new'];

describe('fuzzyMatch', () => {
	test('scores a contiguous substring far above a scattered subsequence', () => {
		const substring = fuzzyMatch('dark', 'Toggle Dark Mode');
		const subsequence = fuzzyMatch('dkm', 'Toggle Dark Mode');
		expect(substring!.score).toBeGreaterThan(100);
		expect(subsequence!.score).toBeGreaterThan(0);
		expect(subsequence!.score).toBeLessThan(substring!.score);
	});

	test('rewards a match at a word boundary over one mid-word', () => {
		const atBoundary = fuzzyMatch('mode', 'Dark Mode')!.score;
		const midWord = fuzzyMatch('ode', 'Dark Mode')!.score;
		expect(atBoundary).toBeGreaterThan(midWord);
	});

	test('returns null when a query character is missing or out of order', () => {
		expect(fuzzyMatch('xyz', 'Toggle Dark Mode')).toBeNull();
		expect(fuzzyMatch('edom', 'Dark Mode')).toBeNull();
	});

	test('reports the matched positions in order', () => {
		expect(fuzzyMatch('dm', 'Dark Mode')!.positions).toEqual([0, 5]);
	});
});

describe('bestFuzzyScore', () => {
	test('takes the strongest candidate, not the first', () => {
		expect(bestFuzzyScore('session', NEW_SESSION)).toBe(
			Math.max(...NEW_SESSION.map((t) => fuzzyMatch('session', t)?.score ?? 0))
		);
	});

	test('returns 0 for an empty query and for a non-match', () => {
		expect(bestFuzzyScore('   ', DARK_MODE)).toBe(0);
		expect(bestFuzzyScore('zzz', DARK_MODE)).toBe(0);
	});

	test('ignores null and undefined candidates', () => {
		expect(bestFuzzyScore('dark', [undefined, null, 'Toggle Dark Mode'])).toBeGreaterThan(0);
	});

	/**
	 * Short initialisms score in the low twenties, so any global score floor
	 * (a `>= 50` cutoff, say) silently turns the palette into `String.includes`
	 * and drops every abbreviation and typo. Weak matches on one long candidate
	 * are the caller's problem to filter, not this function's.
	 */
	test('keeps initialisms and typos reachable', () => {
		expect(bestFuzzyScore('dm', DARK_MODE)).toBeGreaterThan(0);
		expect(bestFuzzyScore('ncs', NEW_SESSION)).toBeGreaterThan(0);
		expect(bestFuzzyScore('setings', ['Open Settings'])).toBeGreaterThan(0);
		expect(bestFuzzyScore('containr', ['Containers'])).toBeGreaterThan(0);
	});
});
