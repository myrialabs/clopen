/**
 * The wording and the button protocol — the two things a phone sees.
 *
 * The answer shape matters most: the engine receives exactly what the web UI's
 * form produces, so it cannot tell (and must not care) which side answered.
 * And cards are runs, not Markdown: a project or session name full of
 * asterisks is shown as typed.
 */

import { describe, it, expect } from 'bun:test';
import type { TextRun } from '@myrialabs/chatkit';
import type { AskUserQuestion } from '$shared/types/unified';
import type { ChannelCard } from './platforms';
import { excerptMarkdown } from '$backend/chat/turn-answer';
import {
	answerFromSelection,
	answerRuns,
	confirmCard,
	decodeButtonData,
	describeToolUse,
	encodeButtonData,
	failedRuns,
	stoppedRuns,
	formatDuration,
	headerLine,
	menuCard,
	progressCard,
	questionAnsweredCard,
	questionCard,
	questionClosedCard,
	type QuestionPayload
} from './messages';

const text = (runs: TextRun[]) => runs.map((run) => run.text).join('');
const cardText = (card: ChannelCard) => text(card.runs);

const single: AskUserQuestion = {
	question: 'Which database should the migration target?',
	header: 'Database',
	multiSelect: false,
	options: [
		{ label: 'Postgres', description: 'The production engine' },
		{ label: 'SQLite', description: 'The local fallback' }
	]
};

const multi: AskUserQuestion = {
	...single,
	question: 'Which environments?',
	multiSelect: true,
	options: [
		{ label: 'Staging', description: '' },
		{ label: 'Production', description: '' },
		{ label: 'Preview', description: '' }
	]
};

function payload(question: AskUserQuestion, extra: Partial<QuestionPayload> = {}): QuestionPayload {
	return { question, index: 0, total: 1, context: { projectName: 'shop', sessionTitle: 'Migrate orders' }, selected: [], ...extra };
}

function buttonData(card: ChannelCard): string[] {
	return (card.buttons ?? []).flat().flatMap((button) => ('data' in button ? [button.data] : []));
}

describe('button data', () => {
	it('round-trips every action', () => {
		expect(decodeButtonData(encodeButtonData('AbC123xyZ9', { type: 'option', index: 2 }))).toEqual({ rowId: 'AbC123xyZ9', action: { type: 'option', index: 2 } });
		expect(decodeButtonData(encodeButtonData('AbC123xyZ9', { type: 'submit' }))?.action).toEqual({ type: 'submit' });
		expect(decodeButtonData(encodeButtonData('AbC123xyZ9', { type: 'other' }))?.action).toEqual({ type: 'other' });
		expect(decodeButtonData(encodeButtonData('AbC123xyZ9', { type: 'confirm' }))?.action).toEqual({ type: 'confirm' });
		expect(decodeButtonData(encodeButtonData('AbC123xyZ9', { type: 'cancel' }))?.action).toEqual({ type: 'cancel' });
	});

	it('rejects anything that is not one of ours', () => {
		for (const data of ['', 'a:1', 'AbC123xyZ9', 'AbC123xyZ9:x', 'AbC123xyZ9:1:2', '../../etc:1', 'AbC123xyZ9:-1']) {
			expect(decodeButtonData(data)).toBeNull();
		}
	});

	it('stays inside a Telegram button even for a long option list', () => {
		const many: AskUserQuestion = { ...single, options: Array.from({ length: 120 }, (_, i) => ({ label: `Option ${i}`, description: '' })) };
		for (const data of buttonData(questionCard('AbC123xyZ9', payload(many)))) {
			expect(new TextEncoder().encode(data).byteLength).toBeLessThanOrEqual(64);
		}
	});
});

describe('answers', () => {
	it('match the web form: labels joined by a comma, a custom answer winning on single-select', () => {
		expect(answerFromSelection(single, [1])).toBe('SQLite');
		expect(answerFromSelection(single, [], 'MySQL please')).toBe('MySQL please');
		expect(answerFromSelection(single, [0], 'MySQL please')).toBe('MySQL please');
		expect(answerFromSelection(multi, [2, 0])).toBe('Staging, Preview');
		expect(answerFromSelection(multi, [0], 'QA')).toBe('Staging, QA');
		expect(answerFromSelection(multi, [])).toBe('');
	});

	it('ignores an option index that does not exist', () => {
		expect(answerFromSelection(single, [7, 0])).toBe('Postgres');
	});
});

describe('header', () => {
	it('leads with the project, then the session', () => {
		expect(text(headerLine({ projectName: 'shop', sessionTitle: 'Migrate orders' }))).toBe('📁 shop · Migrate orders');
		expect(headerLine({ projectName: 'shop', sessionTitle: 'x' })[1]).toMatchObject({ text: 'shop', bold: true });
	});

	it('shows names as typed — never parsed as Markdown', () => {
		const runs = headerLine({ projectName: '**not bold**', sessionTitle: '_raw_' });
		expect(text(runs)).toBe('📁 **not bold** · _raw_');
	});

	it('keeps a long title to one line', () => {
		expect(text(headerLine({ projectName: 'p', sessionTitle: 'x'.repeat(300) })).length).toBeLessThan(80);
	});
});

describe('question cards', () => {
	it('a single-select question is one button per option, then Other to type an answer, no submit', () => {
		const card = questionCard('AbC123xyZ9', payload(single));
		expect(cardText(card)).toContain('Which database should the migration target?');
		expect(cardText(card)).toContain('📁 shop · Migrate orders');
		expect(cardText(card)).toContain('1. Postgres: The production engine');
		expect(buttonData(card)).toEqual(['AbC123xyZ9:0', 'AbC123xyZ9:1', 'AbC123xyZ9:o']);
		expect((card.buttons ?? []).flat().at(-1)?.label).toBe('✏️ Other…');
	});

	it('a multi-select question is checkboxes, an Other box, and Submit counting both', () => {
		const card = questionCard('AbC123xyZ9', payload(multi, { selected: [1] }));
		expect((card.buttons ?? []).flat().map((button) => button.label)).toEqual(['⬜ Staging', '☑️ Production', '⬜ Preview', '⬜ Other…', 'Submit (1)']);
		expect(buttonData(card).at(-1)).toBe('AbC123xyZ9:s');

		const withOther = questionCard('AbC123xyZ9', payload(multi, { selected: [1], custom: 'Canary' }));
		expect((withOther.buttons ?? []).flat().map((button) => button.label).slice(-2)).toEqual(['☑️ Other: Canary', 'Submit (2)']);
	});

	it('says when it is waiting for a typed answer', () => {
		const card = questionCard('AbC123xyZ9', payload(single), { typing: true });
		expect(cardText(card)).toContain('Type your answer');
		expect((card.buttons ?? []).flat().at(-1)?.label).toBe('✏️ Other (typing…)');
	});

	it('counts sibling questions and offers a way back into Clopen when there is one', () => {
		const card = questionCard('AbC123xyZ9', payload(single, { index: 1, total: 3, openUrl: 'https://x.trycloudflare.com/#session/p/s' }));
		expect(cardText(card)).toContain('(2 of 3)');
		expect((card.buttons ?? []).flat().some((button) => 'url' in button)).toBe(true);
	});

	it('settled cards keep the question but lose every option button', () => {
		for (const card of [
			questionAnsweredCard(payload(single), 'SQLite', 1),
			questionClosedCard(payload(single), 'answered-elsewhere'),
			questionClosedCard(payload(single), 'run-ended')
		]) {
			expect(cardText(card)).toContain('Which database');
			expect(buttonData(card)).toEqual([]);
		}
		expect(cardText(questionAnsweredCard(payload(single), 'SQLite', 1))).toContain('1 more question to go');
	});
});

describe('turn output', () => {
	it('an answer is formatted Markdown, not literal asterisks', () => {
		const runs = answerRuns({ markdown: 'Done — **3 files** changed:\n\n```ts\nconst a = 1;\n```', context: {}, showHeader: false });
		expect(text(runs)).toBe('Done — 3 files changed:\n\nconst a = 1;');
		expect(runs.find((run) => run.bold)?.text).toBe('3 files');
		expect(runs.find((run) => run.pre)).toMatchObject({ language: 'ts' });
	});

	it('an answer carries the header only when asked to', () => {
		expect(text(answerRuns({ markdown: 'hi', context: { projectName: 'shop' }, showHeader: true }))).toBe('📁 shop\n\nhi');
		expect(text(answerRuns({ markdown: 'hi', context: { projectName: 'shop' }, showHeader: false }))).toBe('hi');
	});

	it('an excerpt never ends inside a code block', () => {
		const long = `Intro\n\n\`\`\`ts\n${'line\n'.repeat(400)}\`\`\``;
		const excerpt = excerptMarkdown(long, 300);
		expect((excerpt.match(/```/g) ?? []).length % 2).toBe(0);
	});

	it('the progress line names what the turn is doing', () => {
		expect(cardText(progressCard({ elapsedMs: 65_000, activity: 'Edit src/app.ts', steps: 3 }))).toBe('⏳ Working · 1m 5s · 3 steps\nEdit src/app.ts');
		expect(describeToolUse('Bash', { command: 'bun test\nmore' })).toBe('Bash bun test');
		expect(describeToolUse('TodoWrite', {})).toBe('TodoWrite');
	});

	it('formats durations at every scale', () => {
		expect(formatDuration(4_000)).toBe('4s');
		expect(formatDuration(61_000)).toBe('1m 1s');
		expect(formatDuration(3_725_000)).toBe('1h 2m');
	});
});

describe('menus and confirmations', () => {
	it('a menu is one button per item, marking the current one', () => {
		const card = menuCard('AbC123xyZ9', [{ text: 'Pick' }], [{ label: 'Home' }, { label: 'shop', current: true }]);
		expect((card.buttons ?? []).flat().map((button) => button.label)).toEqual(['Home', '✓ shop']);
		expect(buttonData(card)).toEqual(['AbC123xyZ9:0', 'AbC123xyZ9:1']);
		expect(cardText(card)).toContain('2. shop ✓');
	});

	it('a long menu lists its items only as buttons', () => {
		const items = Array.from({ length: 30 }, (_, i) => ({ label: `model-${i}` }));
		const card = menuCard('AbC123xyZ9', [{ text: 'Models' }], items);
		expect(cardText(card)).toBe('Models');
		expect(card.buttons).toHaveLength(30);
	});

	it('a confirmation has a go and a cancel', () => {
		expect(buttonData(confirmCard('AbC123xyZ9', { title: 't', detail: 'd', confirmLabel: 'Go' }))).toEqual(['AbC123xyZ9:y', 'AbC123xyZ9:n']);
	});
});

describe('a turn that did not finish', () => {
	const text = (runs: TextRun[]) => runs.map((run) => run.text).join('');

	it('shows what it said before failing, then the failure — never as a finished answer', () => {
		const out = text(failedRuns({ context: {}, showHeader: false, reason: 'rate limited', partial: 'Half of the work' }));
		expect(out.indexOf('Half of the work')).toBeLessThan(out.indexOf('failed before it finished'));
		expect(out).toContain('rate limited');
		expect(text(failedRuns({ context: {}, showHeader: false }))).toContain('The run failed.');
	});

	it('marks a stopped answer as stopped', () => {
		expect(text(stoppedRuns({ context: {}, showHeader: false, partial: 'So far' }))).toMatch(/So far[\s\S]*Stopped/);
	});
});
