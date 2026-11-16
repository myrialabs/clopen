/**
 * "When" in plain English → a trigger.
 *
 * The owner says when in any language; the AI writing the flow translates it
 * into this small canonical English form (or a cron expression, or an ISO
 * date-time). Keeping the vocabulary fixed and English is what lets every
 * model — cheap or flagship — get a schedule right first time, and the error
 * lists the accepted forms so a wrong guess is corrected in one round.
 *
 *   every minute · every 5 minutes · every 2 hours · hourly · daily
 *   every day at 07:00 · daily at 7:30pm · weekdays at 09:00
 *   every monday at 08:00 · every 1st at 09:00
 *   in 10 minutes · in 2 hours · at 15:48 · today at 15:48 · tomorrow at 07:00
 *   2026-11-09 15:48 · 2026-11-09T15:48:00+07:00
 *   a cron expression: 0 7 * * 1-5
 */

import { describeCron, isValidCron } from './cron';

export type When = { kind: 'cron'; cron: string; text: string } | { kind: 'once'; at: Date; text: string };

export const WHEN_EXAMPLES = 'every 5 minutes · hourly · every day at 07:00 · weekdays at 09:00 · every monday at 08:00 · in 10 minutes · tomorrow at 07:00 · today at 15:48 · 2026-11-09 15:48 · a cron like "0 7 * * *"';

const WEEKDAYS: Record<string, number> = {
	sunday: 0,
	sun: 0,
	monday: 1,
	mon: 1,
	tuesday: 2,
	tue: 2,
	tues: 2,
	wednesday: 3,
	wed: 3,
	thursday: 4,
	thu: 4,
	thurs: 4,
	friday: 5,
	fri: 5,
	saturday: 6,
	sat: 6
};

/** "07:00", "7.30", "7pm", "19:05" → [hour, minute]. */
function parseClock(text: string): [number, number] | null {
	const match = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i.exec(text.trim());
	if (!match) return null;
	let hour = Number(match[1]);
	const minute = Number(match[2] ?? 0);
	const meridiem = match[3]?.toLowerCase();
	if (meridiem === 'pm' && hour < 12) hour += 12;
	if (meridiem === 'am' && hour === 12) hour = 0;
	if (hour > 23 || minute > 59) return null;
	return [hour, minute];
}

function timeZoneName(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
	} catch {
		return 'local time';
	}
}

/** "Thu 15:48 (Asia/Jakarta)" — how a one-off time is said back. */
export function describeAt(at: Date): string {
	const day = at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
	const time = at.toTimeString().slice(0, 5);
	return `${day} ${time} (${timeZoneName()})`;
}

export function describeWhen(when: When): string {
	return when.kind === 'cron' ? `${describeCron(when.cron)} (${timeZoneName()})` : describeAt(when.at);
}

/** Parse a "when"; throws with the accepted forms. `now` is injectable for tests. */
export function parseWhen(input: string, now: Date = new Date()): When {
	const raw = input.trim();
	const text = raw.toLowerCase().replace(/\s+/g, ' ').replace(/[,]/g, '').trim();
	const fail = (): never => {
		throw new Error(`Could not read "${raw}" as a time. Write it in English, one of: ${WHEN_EXAMPLES}.`);
	};
	if (!text) fail();

	if (isValidCron(raw)) return { kind: 'cron', cron: raw, text: raw };

	// Absolute date-time.
	const iso = /^\d{4}-\d{2}-\d{2}(?:[ t]\d{1,2}:\d{2}(?::\d{2})?)?(?:z|[+-]\d{2}:?\d{2})?$/i.test(raw);
	if (iso) {
		const at = new Date(raw.replace(' ', 'T'));
		if (Number.isNaN(at.getTime())) fail();
		return { kind: 'once', at, text: raw };
	}

	// Relative: "in 10 minutes", "in 2 hours", "in 1 day".
	let match = /^in (\d+(?:\.\d+)?) ?(minute|min|m|hour|hr|h|day|d)s?$/.exec(text);
	if (match) {
		const amount = Number(match[1]);
		const unit = match[2][0];
		const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
		return { kind: 'once', at: new Date(now.getTime() + amount * ms), text: raw };
	}

	// "at 15:48", "today at 15:48", "tomorrow at 07:00", "tomorrow 7am".
	match = /^(?:(today|tonight|tomorrow) )?(?:at )?(\d{1,2}(?:[:.]\d{2})? ?(?:am|pm)?)$/.exec(text);
	if (match && (match[1] || /^at /.test(text) || /[:.]|am|pm/.test(match[2]))) {
		const clock = parseClock(match[2]);
		if (!clock) fail();
		const at = new Date(now.getTime());
		at.setSeconds(0, 0);
		at.setHours(clock![0], clock![1]);
		if (match[1] === 'tomorrow') at.setDate(at.getDate() + 1);
		else if (!match[1] && at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
		return { kind: 'once', at, text: raw };
	}

	// Intervals.
	if (/^(every minute|each minute)$/.test(text)) return { kind: 'cron', cron: '* * * * *', text: raw };
	if (/^(hourly|every hour|each hour)$/.test(text)) return { kind: 'cron', cron: '0 * * * *', text: raw };
	if (/^(daily|every day)$/.test(text)) return { kind: 'cron', cron: '0 9 * * *', text: raw };
	match = /^every (\d+) ?(minute|min|m|hour|hr|h)s?$/.exec(text);
	if (match) {
		const amount = Number(match[1]);
		if (match[2][0] === 'm') {
			if (amount < 1 || amount > 59) return amount === 60 ? { kind: 'cron', cron: '0 * * * *', text: raw } : fail();
			return { kind: 'cron', cron: amount === 1 ? '* * * * *' : `*/${amount} * * * *`, text: raw };
		}
		if (amount < 1 || amount > 23) return amount === 24 ? { kind: 'cron', cron: '0 0 * * *', text: raw } : fail();
		return { kind: 'cron', cron: amount === 1 ? '0 * * * *' : `0 */${amount} * * *`, text: raw };
	}

	// "every day at 07:00", "daily at 7pm", "weekdays at 9", "every monday at 08:00",
	// "every monday and thursday at 08:00", "every 1st at 09:00".
	match = /^(?:every |each )?(day|daily|weekday|weekdays|weekend|weekends|[a-z ,]+?|\d{1,2}(?:st|nd|rd|th)?) (?:at )?(\d{1,2}(?:[:.]\d{2})? ?(?:am|pm)?)$/.exec(text);
	if (match) {
		const clock = parseClock(match[2]);
		if (!clock) fail();
		const [hour, minute] = clock!;
		const which = match[1].trim();
		if (which === 'day' || which === 'daily') return { kind: 'cron', cron: `${minute} ${hour} * * *`, text: raw };
		if (which === 'weekday' || which === 'weekdays') return { kind: 'cron', cron: `${minute} ${hour} * * 1-5`, text: raw };
		if (which === 'weekend' || which === 'weekends') return { kind: 'cron', cron: `${minute} ${hour} * * 0,6`, text: raw };
		const dayOfMonth = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(which);
		if (dayOfMonth) {
			const day = Number(dayOfMonth[1]);
			if (day < 1 || day > 31) fail();
			return { kind: 'cron', cron: `${minute} ${hour} ${day} * *`, text: raw };
		}
		const days = which
			.replace(/^on /, '')
			.split(/ and | |,/)
			.map((word) => word.replace(/s$/, ''))
			.filter(Boolean);
		if (days.length && days.every((day) => day in WEEKDAYS || `${day}s` in WEEKDAYS)) {
			const numbers = [...new Set(days.map((day) => WEEKDAYS[day] ?? WEEKDAYS[`${day}s`]))].sort();
			return { kind: 'cron', cron: `${minute} ${hour} * * ${numbers.join(',')}`, text: raw };
		}
	}

	return fail();
}
