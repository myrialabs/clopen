/**
 * Frequent flows — the ones that run every minute or two tell the owner only
 * what changed, in a line. Which flows count is worked out from the trigger.
 */

import { describe, expect, it } from 'bun:test';
import { intervalMinutes, isFrequent } from './service';

describe('intervalMinutes', () => {
	it('reads a cron schedule as the gap between two runs', () => {
		expect(intervalMinutes('schedule', { cron: '* * * * *' })).toBe(1);
		expect(intervalMinutes('schedule', { cron: '*/2 * * * *' })).toBe(2);
		expect(intervalMinutes('schedule', { cron: '0 * * * *' })).toBe(60);
	});

	it('uses the interval of a watch or a check-in', () => {
		expect(intervalMinutes('watch', { everyMinutes: 3 })).toBe(3);
		expect(intervalMinutes('checkin', { everyMinutes: 30 })).toBe(30);
	});

	it('has none for flows that do not repeat on their own', () => {
		expect(intervalMinutes('once', { at: new Date().toISOString() })).toBeNull();
		expect(intervalMinutes('manual', {})).toBeNull();
	});
});

describe('isFrequent', () => {
	it('is true below five minutes only', () => {
		expect(isFrequent('schedule', { cron: '*/2 * * * *' })).toBe(true);
		expect(isFrequent('schedule', { cron: '*/5 * * * *' })).toBe(false);
		expect(isFrequent('schedule', { cron: '0 7 * * *' })).toBe(false);
		expect(isFrequent('watch', { everyMinutes: 1 })).toBe(true);
	});
});
