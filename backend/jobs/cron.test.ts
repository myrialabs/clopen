import { describe, expect, it } from 'bun:test';
import { describeCron, isValidCron, nextCronRun, parseCron } from './cron';

/** Local-time date helper so tests do not depend on the machine's timezone. */
function at(year: number, month: number, day: number, hour = 0, minute = 0): Date {
	return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe('parseCron', () => {
	it('accepts lists, ranges, steps and macros', () => {
		const spec = parseCron('*/15 9-17 1,15 * 1-5');
		expect([...spec.minutes]).toEqual([0, 15, 30, 45]);
		expect(spec.hours.has(9) && spec.hours.has(17) && !spec.hours.has(18)).toBe(true);
		expect([...spec.days]).toEqual([1, 15]);
		expect(isValidCron('@daily')).toBe(true);
	});

	it('treats weekday 7 as Sunday', () => {
		expect(parseCron('0 0 * * 7').weekdays.has(0)).toBe(true);
	});

	it('rejects malformed expressions with a readable error', () => {
		expect(() => parseCron('0 0 * *')).toThrow(/five fields/);
		expect(() => parseCron('60 * * * *')).toThrow(/minute/);
		expect(() => parseCron('*/0 * * * *')).toThrow(/step/);
		expect(isValidCron('5-1 * * * *')).toBe(false);
	});
});

describe('nextCronRun', () => {
	it('finds the next minute strictly after the reference', () => {
		expect(nextCronRun('* * * * *', at(2026, 1, 1, 10, 0))).toEqual(at(2026, 1, 1, 10, 1));
	});

	it('rolls over hours, days and months', () => {
		expect(nextCronRun('30 7 * * *', at(2026, 1, 1, 8, 0))).toEqual(at(2026, 1, 2, 7, 30));
		expect(nextCronRun('0 0 1 * *', at(2026, 1, 31, 12, 0))).toEqual(at(2026, 2, 1, 0, 0));
		expect(nextCronRun('@yearly', at(2026, 6, 1))).toEqual(at(2027, 1, 1, 0, 0));
	});

	it('matches day-of-month OR day-of-week when both are restricted', () => {
		// 2026-03-02 is a Monday; the 15th is a Sunday.
		expect(nextCronRun('0 9 15 * 1', at(2026, 3, 1, 12, 0))).toEqual(at(2026, 3, 2, 9, 0));
	});

	it('skips impossible dates instead of looping forever', () => {
		expect(nextCronRun('0 0 31 2 *', at(2026, 1, 1))).toBeNull();
	});
});

describe('describeCron', () => {
	it('reads the common shapes', () => {
		expect(describeCron('0 7 * * *')).toBe('Every day at 07:00');
		expect(describeCron('*/10 * * * *')).toBe('Every 10 minutes');
		expect(describeCron('30 9 * * 1-5')).toBe('Weekdays at 09:30');
		expect(describeCron('@hourly')).toBe('Every hour at :00');
		expect(describeCron('0 8 * * 1')).toBe('Every Monday at 08:00');
	});
});
