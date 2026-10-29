import type { ToolResult, UserMessage } from '$shared/types/unified';

/**
 * The answers a user gave to an AskUserQuestion.
 *
 * The source of truth is `ToolResult.answers`: the stream manager attaches
 * exactly what the user submitted to the tool_result the engine sends back
 * (see `attachSubmittedAnswers`), so the UI never depends on how an engine
 * words its result for the model.
 *
 * Results saved before that field existed only carry the engine's prose, so
 * those fall back to `parseAskUserQuestionAnswers`. That history is frozen —
 * every new result carries `answers` — so the closings it knows never need to
 * grow when an engine rewords its output.
 */
export function readAskUserQuestionAnswers(
	result: Pick<ToolResult, 'content' | 'answers'>,
	questions: readonly { question: string }[]
): Record<string, string> {
	return result.answers ?? parseAskUserQuestionAnswers(result.content, questions);
}

/**
 * Stamp the answers the user submitted onto the matching tool_results of an
 * engine's user message, consuming them from `submitted`. Matching is by
 * tool_use id, the same id the UI answered with and pairs the result by.
 * Error results are left alone: the question was rejected, not answered.
 */
export function attachSubmittedAnswers(
	message: UserMessage,
	submitted: Map<string, Record<string, string>>
): void {
	if (submitted.size === 0) return;
	for (const block of message.content) {
		if (block.type !== 'tool_result') continue;
		const answers = submitted.get(block.toolUseId);
		if (!answers) continue;
		submitted.delete(block.toolUseId);
		if (!block.isError) block.answers = answers;
	}
}

/**
 * Legacy fallback: recover answers from a tool_result's prose.
 *
 * Two shapes reach the UI:
 *   - JSON `{"answers": {<question>: <answer>}}` (Copilot, rewritten by its converter)
 *   - Prose `<preamble> "Q1"="A1", "Q2"="A2".<closing>`
 *
 * The prose is never escaped, so an answer may itself contain `"`, `". ` or
 * anything else. Two facts keep the split exact anyway: every question text is
 * known, so an answer ends right before `", "<a later question>"=`; and the
 * closing each engine appended is fixed text anchored at the end of the result,
 * so the last answer ends where that closing starts. Closings not listed here
 * fall back to the last `"` that is followed by a sentence break.
 *
 * Ambiguous by construction (the engine output is identical either way): an
 * answer that literally contains `", "<a later question>"=`.
 */

/** Closings engines appended after the answer list, each anchored to the end of the result. */
const KNOWN_CLOSINGS: readonly RegExp[] = [
	// OpenCode and Clopen's own adapters (Cline, Cursor, Pi, Qwen)
	/\. You can now continue with the user's answers in mind\.\s*$/,
	// Claude Code — every answer matched an offered option
	/\. You can now continue with these answers in mind\.\s*$/,
	// Claude Code — at least one free-text answer
	/\. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say\.\s*$/,
	// Claude Code — the user asked for follow-up questions, optionally with a note
	/\.(?: They also wrote: "[\s\S]*"\.)? Call \S+ again with follow-up questions that build on these answers \(do not repeat these\); do not start the task yet\.\s*$/
];

export function parseAskUserQuestionAnswers(
	content: string,
	questions: readonly { question: string }[]
): Record<string, string> {
	const fromJson = parseJsonAnswers(content);
	if (fromJson) return fromJson;

	// Where each question's answer opens, in question order.
	const starts: { question: string; markerStart: number; answerStart: number }[] = [];
	let cursor = 0;
	for (const { question } of questions) {
		const marker = `"${question}"="`;
		const markerStart = content.indexOf(marker, cursor);
		if (markerStart === -1) continue;
		const answerStart = markerStart + marker.length;
		starts.push({ question, markerStart, answerStart });
		cursor = answerStart;
	}

	const answers: Record<string, string> = {};
	for (let i = 0; i < starts.length; i++) {
		const { question, answerStart } = starts[i];
		const answerEnd = i < starts.length - 1
			? findNextAnswerBoundary(content, answerStart, starts.slice(i + 1).map((s) => s.question))
			: findLastAnswerEnd(content, answerStart);
		answers[question] = content.slice(answerStart, answerEnd);
	}
	return answers;
}

function parseJsonAnswers(content: string): Record<string, string> | null {
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch {
		return null;
	}
	const answers = (json as { answers?: unknown } | null)?.answers;
	if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;

	const result: Record<string, string> = {};
	for (const [question, value] of Object.entries(answers)) {
		if (value === null || value === undefined) continue;
		result[question] = Array.isArray(value) ? value.map(String).join(', ') : String(value);
	}
	return result;
}

/** The earliest `", "<later question>"=` after this answer, i.e. its closing quote. */
function findNextAnswerBoundary(content: string, answerStart: number, laterQuestions: string[]): number {
	let boundary = -1;
	for (const question of laterQuestions) {
		const idx = content.indexOf(`", "${question}"=`, answerStart);
		if (idx !== -1 && (boundary === -1 || idx < boundary)) boundary = idx;
	}
	return boundary === -1 ? findLastAnswerEnd(content, answerStart) : boundary;
}

/** Index of the last answer's closing quote. */
function findLastAnswerEnd(content: string, answerStart: number): number {
	const tail = content.slice(answerStart);
	for (const closing of KNOWN_CLOSINGS) {
		const match = closing.exec(tail);
		if (match) return closingQuoteBefore(content, answerStart, answerStart + match.index);
	}

	const trimmed = content.trimEnd();
	if (trimmed.endsWith('".')) return closingQuoteBefore(content, answerStart, trimmed.length - 1);
	if (trimmed.endsWith('"')) return closingQuoteBefore(content, answerStart, trimmed.length);

	// Unknown closing: it is joined by `". `, and the last such join wins so an
	// answer that itself contains `". ` stays whole.
	const sentenceJoin = content.lastIndexOf('". ');
	if (sentenceJoin >= answerStart) return sentenceJoin;
	const lastQuote = content.lastIndexOf('"');
	return lastQuote >= answerStart ? lastQuote : content.length;
}

/** `listEnd` sits just past the closing quote; step back over it when present. */
function closingQuoteBefore(content: string, answerStart: number, listEnd: number): number {
	return listEnd > answerStart && content[listEnd - 1] === '"' ? listEnd - 1 : listEnd;
}
