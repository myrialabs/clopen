import { describe, expect, test } from 'bun:test';
import type { ToolResult, UserMessage } from '$shared/types/unified';
import { attachSubmittedAnswers, parseAskUserQuestionAnswers, readAskUserQuestionAnswers } from './ask-user-question';

type Answers = Record<string, string>;
type Question = { question: string };

/*
 * Byte-for-byte replicas of what each engine sends back. Kept in sync with
 * the engines' own templates so the parser is exercised on real output.
 */

// Claude Code: answered pairs only (empty answers are omitted), several closings.
const claude = {
	answered: (qs: Question[], a: Answers) =>
		`Your questions have been answered: ${claudePairs(qs, a)}. You can now continue with these answers in mind.`,
	freeText: (qs: Question[], a: Answers) =>
		`The user answered: ${claudePairs(qs, a)}. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.`,
	followUp: (qs: Question[], a: Answers) =>
		`The user wants to discuss this further before you proceed. So far they answered: ${claudePairs(qs, a)}. Call AskUserQuestion again with follow-up questions that build on these answers (do not repeat these); do not start the task yet.`,
	followUpWithNote: (qs: Question[], a: Answers) =>
		`The user wants to discuss this further before you proceed. So far they answered: ${claudePairs(qs, a)}. They also wrote: "Ask about "auth". Then billing.". Call AskUserQuestion again with follow-up questions that build on these answers (do not repeat these); do not start the task yet.`,
	afk: (qs: Question[], a: Answers) =>
		`The user did not respond within 5 minutes.\n\nBefore going idle the user had selected: ${claudePairs(qs, a)}.`
};
function claudePairs(qs: Question[], a: Answers): string {
	return qs.filter(({ question }) => a[question]).map(({ question }) => `"${question}"="${a[question]}"`).join(', ');
}

// OpenCode: every question, unanswered ones as "Unanswered".
const opencode = (qs: Question[], a: Answers) =>
	`User has answered your questions: ${qs.map(({ question }) => `"${question}"="${a[question] || 'Unanswered'}"`).join(', ')}. You can now continue with the user's answers in mind.`;

// Clopen's own adapters (Cline, Cursor, Pi, Qwen): every submitted answer.
const clopen = (qs: Question[], a: Answers) =>
	`User has answered your questions: ${qs.map(({ question }) => `"${question}"="${a[question]}"`).join(', ')}. You can now continue with the user's answers in mind.`;

// An engine this parser has never heard of, with a quote-free closing.
const unknownEngine = (qs: Question[], a: Answers) =>
	`Answers: ${claudePairs(qs, a)}. Proceed with care.`;

const FORMATTERS = {
	'claude/answered': claude.answered,
	'claude/free-text': claude.freeText,
	'claude/follow-up': claude.followUp,
	'claude/follow-up with note': claude.followUpWithNote,
	'claude/afk': claude.afk,
	opencode,
	'clopen adapters': clopen,
	'unknown engine': unknownEngine
};

const WEIRD_ANSWERS: string[] = [
	'Yes',
	'Do everything at once',
	'Option A, Option B',
	'Say "hi"',
	'"quoted from the start',
	'ends with a quote"',
	'"fully quoted"',
	'Say "hi". Then stop',
	'Ends with a sentence.',
	'Ends with "x".',
	'...',
	'"."',
	'". ',
	'a"="b',
	'"Which scope?"="Some"',
	'=',
	'"',
	'""',
	'x", y',
	'. You can now continue with the user\'s answers in mind.',
	'. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.',
	'. Call AskUserQuestion again with follow-up questions that build on these answers (do not repeat these); do not start the task yet.',
	'They also wrote: "x". Call me',
	'Line one\nLine two\n\nLine four',
	'Windows\r\nline',
	'\ttabbed\t',
	'  padded  ',
	'kerjakan semuanya sekaligus tanpa stop',
	'日本語の回答、そして中文',
	'שלום עולם',
	'emoji 🚀👍🏽 family 👨‍👩‍👧',
	'zero​width',
	'back\\slash \\" escaped',
	'$& $1 $$ replacement tokens',
	'<script>alert(1)</script>',
	'**markdown** `code` [link](http://x)',
	'{"answers":{"Which scope?":"hijack"}}',
	'null',
	'Unanswered',
	'x'.repeat(10_000)
];

const QUESTION_SETS: Question[][] = [
	[{ question: 'Which scope?' }],
	[{ question: 'Which scope?' }, { question: 'Which approach?' }],
	[{ question: 'Use "strict" mode?' }, { question: 'Name = value?' }, { question: 'Deploy 🚀?' }],
	// One question text contained in another
	[{ question: 'Name?' }, { question: 'Project Name?' }],
	// Indonesian, as in the original report
	[{ question: 'Bagaimana saya boleh melanjutkan?' }, { question: 'Sambil menunggu akun, bagian mana yang saya kerjakan dulu?' }]
];

/** An answer containing `", "<a later question>"=` is the one shape engine output cannot disambiguate. */
function isInherentlyAmbiguous(qs: Question[], answers: Answers): boolean {
	return qs.some(({ question }, i) => qs.slice(i + 1).some((later) => answers[question]?.includes(`", "${later.question}"=`)));
}

describe('parseAskUserQuestionAnswers — every engine × weird answers', () => {
	for (const [engine, format] of Object.entries(FORMATTERS)) {
		test(engine, () => {
			const failures: string[] = [];
			for (const qs of QUESTION_SETS) {
				for (let w = 0; w < WEIRD_ANSWERS.length; w++) {
					// Rotate the weird answers across positions so each one is
					// tested as the first, a middle and the last answer.
					const answers: Answers = {};
					qs.forEach(({ question }, i) => {
						answers[question] = WEIRD_ANSWERS[(w + i) % WEIRD_ANSWERS.length];
					});
					if (isInherentlyAmbiguous(qs, answers)) continue;

					const content = format(qs, answers);
					const parsed = parseAskUserQuestionAnswers(content, qs);
					for (const { question } of qs) {
						const expected = answers[question];
						if (parsed[question] !== expected) {
							failures.push(`${JSON.stringify(question)}: expected ${JSON.stringify(expected).slice(0, 80)}, got ${JSON.stringify(parsed[question]).slice(0, 80)}`);
						}
					}
				}
			}
			expect(failures).toEqual([]);
		});
	}
});

describe('parseAskUserQuestionAnswers', () => {
	const qs = [{ question: 'Which scope?' }, { question: 'Which approach?' }];

	test('drops the Claude Code closing from the reported answer', () => {
		const content = claude.freeText(qs, { 'Which scope?': 'Some', 'Which approach?': 'kerjakan semuanya sekaligus tanpa stop' });
		expect(parseAskUserQuestionAnswers(content, qs)).toEqual({
			'Which scope?': 'Some',
			'Which approach?': 'kerjakan semuanya sekaligus tanpa stop'
		});
	});

	test('skips a question Claude omitted because it was left empty', () => {
		const three = [...qs, { question: 'Which name?' }];
		const content = claude.answered(three, { 'Which scope?': 'Some', 'Which approach?': '', 'Which name?': 'Foo' });
		expect(parseAskUserQuestionAnswers(content, three)).toEqual({ 'Which scope?': 'Some', 'Which name?': 'Foo' });
	});

	test('reports OpenCode\'s own placeholder for an unanswered question verbatim', () => {
		const content = opencode(qs, { 'Which scope?': 'Some' });
		expect(parseAskUserQuestionAnswers(content, qs)).toEqual({ 'Which scope?': 'Some', 'Which approach?': 'Unanswered' });
	});

	test('an unknown closing that itself quotes is indistinguishable from the answer', () => {
		// Documents the limit of the fallback: without knowing the closing,
		// `"Bold". Go, "now".` reads the same as an answer ending in `". Go, "now`.
		const content = '"Which scope?"="Bold". Go, "now".';
		expect(parseAskUserQuestionAnswers(content, qs)).toEqual({ 'Which scope?': 'Bold". Go, "now' });
	});

	test('handles a result with no closing at all', () => {
		expect(parseAskUserQuestionAnswers('"Which scope?"="Some"', qs)).toEqual({ 'Which scope?': 'Some' });
		expect(parseAskUserQuestionAnswers('"Which scope?"="Some".', qs)).toEqual({ 'Which scope?': 'Some' });
		expect(parseAskUserQuestionAnswers('"Which scope?"="Some"  \n', qs)).toEqual({ 'Which scope?': 'Some' });
	});

	test('reads the JSON answers shape, coercing non-string values', () => {
		expect(parseAskUserQuestionAnswers('{"answers":{"Which scope?":"Some"}}', qs)).toEqual({ 'Which scope?': 'Some' });
		expect(parseAskUserQuestionAnswers('{"answers":{"Which scope?":["A","B"],"Which approach?":3}}', qs))
			.toEqual({ 'Which scope?': 'A, B', 'Which approach?': '3' });
		expect(parseAskUserQuestionAnswers('{"answers":{"Which scope?":null}}', qs)).toEqual({});
	});

	test('ignores JSON that is not an answers object', () => {
		expect(parseAskUserQuestionAnswers('{"answers":["Some"]}', qs)).toEqual({});
		expect(parseAskUserQuestionAnswers('null', qs)).toEqual({});
		expect(parseAskUserQuestionAnswers('"Which scope?"', qs)).toEqual({});
	});

	test('returns nothing for results without answers', () => {
		expect(parseAskUserQuestionAnswers('Error: questions is required', qs)).toEqual({});
		expect(parseAskUserQuestionAnswers('The user did not answer the questions.', qs)).toEqual({});
		expect(parseAskUserQuestionAnswers('The user responded: just do it', qs)).toEqual({});
		expect(parseAskUserQuestionAnswers('', qs)).toEqual({});
		expect(parseAskUserQuestionAnswers('"Which scope?"="Some"', [])).toEqual({});
	});

	test('does not hang on very large results', () => {
		const huge = 'a'.repeat(1_000_000);
		const started = performance.now();
		expect(parseAskUserQuestionAnswers(claude.freeText(qs, { 'Which scope?': huge }), qs)).toEqual({ 'Which scope?': huge });
		expect(parseAskUserQuestionAnswers(`"Which scope?"="${huge}`, qs)).toEqual({ 'Which scope?': huge });
		expect(performance.now() - started).toBeLessThan(1000);
	});
});

function toolResult(toolUseId: string, content: string, isError = false): ToolResult {
	return { type: 'tool_result', toolUseId, content, isError };
}

function userMessage(...content: UserMessage['content']): UserMessage {
	return { type: 'user', content, synthetic: false } as UserMessage;
}

describe('attachSubmittedAnswers → readAskUserQuestionAnswers (every engine × weird answers)', () => {
	for (const [engine, format] of Object.entries(FORMATTERS)) {
		test(engine, () => {
			const failures: string[] = [];
			for (const qs of QUESTION_SETS) {
				for (let w = 0; w < WEIRD_ANSWERS.length; w++) {
					const answers: Answers = {};
					qs.forEach(({ question }, i) => {
						answers[question] = WEIRD_ANSWERS[(w + i) % WEIRD_ANSWERS.length];
					});
					// No ambiguity carve-out: the structured path never reads the prose.
					const message = userMessage(toolResult('call-1', format(qs, answers)));
					attachSubmittedAnswers(message, new Map([['call-1', { ...answers }]]));

					// Round-trip as the DB and the WS do, then read as the UI does.
					const stored = JSON.parse(JSON.stringify(message)) as UserMessage;
					const block = stored.content[0] as ToolResult;
					const read = readAskUserQuestionAnswers(block, qs);
					if (JSON.stringify(read) !== JSON.stringify(answers)) {
						failures.push(`${JSON.stringify(answers).slice(0, 120)} → ${JSON.stringify(read).slice(0, 120)}`);
					}
				}
			}
			expect(failures).toEqual([]);
		});
	}
});

describe('attachSubmittedAnswers', () => {
	const answers = { 'Which scope?': 'Some' };

	test('attaches only to the matching tool_result and consumes the entry', () => {
		const submitted = new Map([['call-1', answers]]);
		const other = toolResult('call-2', 'unrelated');
		const match = toolResult('call-1', 'engine prose');
		const message = userMessage({ type: 'text', text: 'hi' }, other, match);

		attachSubmittedAnswers(message, submitted);

		expect(match.answers).toEqual(answers);
		expect(match.content).toBe('engine prose');
		expect(other.answers).toBeUndefined();
		expect(submitted.size).toBe(0);
	});

	test('leaves an error result unanswered but still consumes the entry', () => {
		const submitted = new Map([['call-1', answers]]);
		const rejected = toolResult('call-1', 'Error: questions is required', true);

		attachSubmittedAnswers(userMessage(rejected), submitted);

		expect(rejected.answers).toBeUndefined();
		expect(submitted.size).toBe(0);
	});

	test('keeps answers for a question whose result has not arrived yet', () => {
		const submitted = new Map([['call-1', answers], ['call-9', { 'Later?': 'Yes' }]]);
		attachSubmittedAnswers(userMessage(toolResult('call-1', 'x')), submitted);
		expect([...submitted.keys()]).toEqual(['call-9']);
	});

	test('attaches each of several questions answered in one message', () => {
		const a = toolResult('call-1', 'x');
		const b = toolResult('call-2', 'y');
		attachSubmittedAnswers(userMessage(a, b), new Map([['call-1', { Q1: 'A' }], ['call-2', { Q2: 'B' }]]));
		expect(a.answers).toEqual({ Q1: 'A' });
		expect(b.answers).toEqual({ Q2: 'B' });
	});

	test('does nothing without submitted answers', () => {
		const block = toolResult('call-1', 'x');
		attachSubmittedAnswers(userMessage(block), new Map());
		expect(block.answers).toBeUndefined();
	});

	test('treats tool_use ids as opaque strings', () => {
		const ids = ['toolu_01AbC', 'call_9f8e', 'copilot-ask-user-6b1f', '', ' ', 'id with "quotes" and 🚀', '__proto__', 'constructor'];
		for (const id of ids) {
			const block = toolResult(id, 'x');
			attachSubmittedAnswers(userMessage(block), new Map([[id, { Q: id }]]));
			expect(block.answers).toEqual({ Q: id });
		}
	});
});

describe('readAskUserQuestionAnswers', () => {
	const qs = [{ question: 'Which scope?' }, { question: 'Which approach?' }];

	test('prefers attached answers over anything the prose says', () => {
		const content = claude.freeText(qs, { 'Which scope?': 'From prose' });
		expect(readAskUserQuestionAnswers({ content, answers: { 'Which scope?': 'Submitted' } }, qs))
			.toEqual({ 'Which scope?': 'Submitted' });
	});

	test('falls back to the prose for results saved before answers were attached', () => {
		const content = claude.freeText(qs, { 'Which scope?': 'Some', 'Which approach?': 'kerjakan semuanya sekaligus tanpa stop' });
		expect(readAskUserQuestionAnswers({ content }, qs)).toEqual({
			'Which scope?': 'Some',
			'Which approach?': 'kerjakan semuanya sekaligus tanpa stop'
		});
	});

	test('keeps attached answers verbatim, including empty and question-keyed oddities', () => {
		const attached = { 'Which scope?': '', 'Which approach?': '", "Which scope?"="spoof', 'Not asked?': 'extra' };
		expect(readAskUserQuestionAnswers({ content: '', answers: attached }, qs)).toEqual(attached);
	});
});
