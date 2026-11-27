import { describe, expect, test } from 'bun:test';

import { compareVersions, isNewerVersion, stripVersionPrefix } from './semver';

describe('compareVersions', () => {
	test('orders numerically, not as text', () => {
		expect(compareVersions('0.4.10', '0.4.9')).toBeGreaterThan(0);
		expect(compareVersions('0.4.9', '0.10.0')).toBeLessThan(0);
		expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
	});

	test('treats a v prefix and missing parts as equal', () => {
		expect(compareVersions('v0.4.50', '0.4.50')).toBe(0);
		expect(compareVersions('0.5', '0.5.0')).toBe(0);
	});

	test('ignores pre-release and build suffixes', () => {
		expect(compareVersions('0.4.50-beta.1', '0.4.50')).toBe(0);
	});
});

describe('isNewerVersion', () => {
	test('is true only for a strictly newer candidate', () => {
		expect(isNewerVersion('0.4.49', '0.4.50')).toBe(true);
		expect(isNewerVersion('0.4.50', '0.4.50')).toBe(false);
		expect(isNewerVersion('0.4.50', '0.4.49')).toBe(false);
	});
});

test('stripVersionPrefix', () => {
	expect(stripVersionPrefix('v0.4.50')).toBe('0.4.50');
	expect(stripVersionPrefix('0.4.50')).toBe('0.4.50');
});
