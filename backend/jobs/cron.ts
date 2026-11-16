/**
 * A small five-field cron evaluator, in the server's local time.
 *
 *   minute hour day-of-month month day-of-week
 *
 * Each field takes `*`, a number, a range `a-b`, a list `a,b,c`, and a step
 * `x/n` (on `*` or a range). Day-of-week is 0–6 with Sunday = 0 (7 is also
 * Sunday). Macros: @hourly, @daily, @weekly, @monthly, @yearly.
 *
 * Day-of-month and day-of-week follow cron's rule: when both are restricted,
 * a day matches if EITHER matches.
 *
 * Written here rather than pulled in: the whole surface is these few rules, and
 * a scheduler that decides when an agent spends money should have no behaviour
 * hidden in a dependency.
 */

export interface CronSpec {
	minutes: Set<number>;
	hours: Set<number>;
	days: Set<number>;
	months: Set<number>;
	weekdays: Set<number>;
	dayRestricted: boolean;
	weekdayRestricted: boolean;
}

const MACROS: Record<string, string> = {
	'@hourly': '0 * * * *',
	'@daily': '0 0 * * *',
	'@midnight': '0 0 * * *',
	'@weekly': '0 0 * * 0',
	'@monthly': '0 0 1 * *',
	'@yearly': '0 0 1 1 *',
	'@annually': '0 0 1 1 *'
};

function parseField(field: string, min: number, max: number, name: string): Set<number> {
	const values = new Set<number>();
	for (const part of field.split(',')) {
		const [rangePart, stepPart] = part.split('/');
		const step = stepPart === undefined ? 1 : Number(stepPart);
		if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in ${name}: "${part}"`);
		let start: number;
		let end: number;
		if (rangePart === '*') {
			start = min;
			end = max;
		} else if (rangePart.includes('-')) {
			const [a, b] = rangePart.split('-').map(Number);
			start = a;
			end = b;
		} else {
			start = Number(rangePart);
			end = stepPart === undefined ? start : max;
		}
		if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
			throw new Error(`Invalid ${name}: "${part}" (allowed ${min}-${max})`);
		}
		for (let value = start; value <= end; value += step) values.add(value);
	}
	return values;
}

export function parseCron(expression: string): CronSpec {
	const trimmed = expression.trim();
	const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
	const fields = expanded.split(/\s+/);
	if (fields.length !== 5) throw new Error(`A schedule needs five fields (minute hour day month weekday), got "${expression}"`);
	const [minute, hour, day, month, weekday] = fields;
	const weekdays = parseField(weekday, 0, 7, 'weekday');
	if (weekdays.has(7)) {
		weekdays.delete(7);
		weekdays.add(0);
	}
	return {
		minutes: parseField(minute, 0, 59, 'minute'),
		hours: parseField(hour, 0, 23, 'hour'),
		days: parseField(day, 1, 31, 'day of month'),
		months: parseField(month, 1, 12, 'month'),
		weekdays,
		dayRestricted: day !== '*',
		weekdayRestricted: weekday !== '*'
	};
}

export function isValidCron(expression: string): boolean {
	try {
		parseCron(expression);
		return true;
	} catch {
		return false;
	}
}

function dayMatches(spec: CronSpec, date: Date): boolean {
	const dom = spec.days.has(date.getDate());
	const dow = spec.weekdays.has(date.getDay());
	if (spec.dayRestricted && spec.weekdayRestricted) return dom || dow;
	if (spec.dayRestricted) return dom;
	if (spec.weekdayRestricted) return dow;
	return true;
}

/** The first matching minute strictly after `from`, or null if none within ~4 years. */
export function nextCronRun(expression: string, from: Date = new Date()): Date | null {
	const spec = parseCron(expression);
	const date = new Date(from.getTime());
	date.setSeconds(0, 0);
	date.setMinutes(date.getMinutes() + 1);
	const limit = from.getTime() + 4 * 366 * 24 * 60 * 60 * 1000;

	while (date.getTime() <= limit) {
		if (!spec.months.has(date.getMonth() + 1)) {
			date.setMonth(date.getMonth() + 1, 1);
			date.setHours(0, 0, 0, 0);
			continue;
		}
		if (!dayMatches(spec, date)) {
			date.setDate(date.getDate() + 1);
			date.setHours(0, 0, 0, 0);
			continue;
		}
		if (!spec.hours.has(date.getHours())) {
			date.setHours(date.getHours() + 1, 0, 0, 0);
			continue;
		}
		if (!spec.minutes.has(date.getMinutes())) {
			date.setMinutes(date.getMinutes() + 1, 0, 0);
			continue;
		}
		return date;
	}
	return null;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A short human reading of the common shapes; the raw expression otherwise. */
export function describeCron(expression: string): string {
	const trimmed = expression.trim();
	const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
	const fields = expanded.split(/\s+/);
	if (fields.length !== 5) return expression;
	const [minute, hour, day, month, weekday] = fields;
	const pad = (value: string) => value.padStart(2, '0');
	const isNumber = (value: string) => /^\d+$/.test(value);
	if (minute === '*' && hour === '*' && day === '*' && month === '*' && weekday === '*') return 'Every minute';
	const everyMinutes = /^\*\/(\d+)$/.exec(minute);
	if (everyMinutes && hour === '*' && day === '*' && month === '*' && weekday === '*') return `Every ${everyMinutes[1]} minutes`;
	if (isNumber(minute) && hour === '*' && day === '*' && month === '*' && weekday === '*') return `Every hour at :${pad(minute)}`;
	const everyHours = /^\*\/(\d+)$/.exec(hour);
	if (isNumber(minute) && everyHours && day === '*' && month === '*' && weekday === '*') return `Every ${everyHours[1]} hours at :${pad(minute)}`;
	if (isNumber(minute) && isNumber(hour)) {
		const time = `${pad(hour)}:${pad(minute)}`;
		if (day === '*' && month === '*' && weekday === '*') return `Every day at ${time}`;
		if (day === '*' && month === '*' && weekday === '1-5') return `Weekdays at ${time}`;
		if (day === '*' && month === '*' && isNumber(weekday)) return `Every ${WEEKDAY_NAMES[Number(weekday) % 7]} at ${time}`;
		if (isNumber(day) && month === '*' && weekday === '*') return `Day ${day} of every month at ${time}`;
	}
	return expression;
}
