import { describe, expect, test } from 'bun:test';
import { foregroundFor } from './page-colors';

describe('foregroundFor', () => {
	test('dark ink on a light page, light ink on a dark one', () => {
		expect(foregroundFor('#ffffff')).toBe('#111113');
		expect(foregroundFor('#fff')).toBe('#111113');
		expect(foregroundFor('#202124')).toBe('#fff');
		expect(foregroundFor('rgb(232, 113, 38)')).toBe('#fff');
		expect(foregroundFor('rgba(250, 250, 250, 0.9)')).toBe('#111113');
	});

	test('a page with no colours yet is treated as the default white canvas', () => {
		expect(foregroundFor(null)).toBe('#111113');
		expect(foregroundFor('not a colour')).toBe('#111113');
	});
});
