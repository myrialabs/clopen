/**
 * What the bot says — pure functions from state to card, so the wording can be
 * tested without a bot and stays identical however a message is (re)rendered.
 *
 * Cards are built as formatted RUNS, never as Markdown strings: anything that
 * came from a user or a model (a project name, a session title, a question)
 * is placed into a run as text, so an asterisk in a title is an asterisk and
 * not the start of a bold span. The assistant's own output is the one thing
 * that IS Markdown, and it goes through ChatKit's parser so it arrives as
 * native formatting instead of literal `**`.
 *
 * Titles come from `chatNotificationMessage`, the same source the push
 * notification and the tab toast use, so one event reads the same everywhere.
 */

import { markdownToRuns, type TextRun } from '@myrialabs/chatkit';
import type { AskUserQuestion } from '$shared/types/unified';
import { chatNotificationMessage } from '$shared/constants/notification-messages';

import type { ChannelButton, ChannelCard } from './platforms';

/** Where an event happened, as the chat shows it. */
export interface ChannelContext {
	/** The project's name, or "Home" for a user's Home workspace. */
	projectName?: string;
	sessionTitle?: string;
}

/** A question as it is stored on its row. */
export interface QuestionPayload {
	question: AskUserQuestion;
	/** Position and count within its AskUserQuestion, for "(1 of 2)". */
	index: number;
	total: number;
	context: ChannelContext;
	/** Option indexes ticked so far (multi-select). */
	selected: number[];
	/** A typed answer ("Other"), kept until Submit on a multi-select question. */
	custom?: string;
	/** Set once this question has its answer — the whole tool may still wait on siblings. */
	answer?: string;
	openUrl?: string | null;
}

/** Past this many items a menu lists them only as buttons — the text would scroll for pages. */
const MAX_LISTED_ITEMS = 12;

/** Button labels past this are cut; a long one renders as a wall of ellipsis anyway. */
const MAX_BUTTON_LABEL = 40;

/** Session titles are the first user message; a header must stay one line. */
const MAX_TITLE = 60;

function clip(value: string, max: number): string {
	const trimmed = value.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

// ── Run helpers ─────────────────────────────────────────────────────────────

const plain = (text: string): TextRun => ({ text });
const bold = (text: string): TextRun => ({ text, bold: true });
const italic = (text: string): TextRun => ({ text, italic: true });
const code = (text: string): TextRun => ({ text, code: true });

/** Join blocks of runs with a blank line between them, skipping empty blocks. */
function stack(...blocks: Array<TextRun[] | null | undefined | false>): TextRun[] {
	const out: TextRun[] = [];
	for (const block of blocks) {
		if (!block || block.length === 0) continue;
		if (out.length) out.push(plain('\n\n'));
		out.push(...block);
	}
	return out;
}

/** Join runs line by line. */
function lines(...rows: TextRun[][]): TextRun[] {
	const out: TextRun[] = [];
	rows.filter((row) => row.length).forEach((row, i) => {
		if (i > 0) out.push(plain('\n'));
		out.push(...row);
	});
	return out;
}

export function textCard(text: string, buttons?: ChannelButton[][]): ChannelCard {
	return { runs: [plain(text)], ...(buttons ? { buttons } : {}) };
}

/**
 * `📁 Project · session title` — the project leads, because it is what tells
 * two chats apart at a glance; the title is the first user message and only
 * a hint.
 */
export function headerLine(context: ChannelContext): TextRun[] {
	const project = context.projectName?.trim();
	const title = context.sessionTitle?.trim();
	const out: TextRun[] = [];
	if (project) out.push(plain('📁 '), bold(project));
	if (title) out.push(plain(project ? ' · ' : '💬 '), plain(clip(title, MAX_TITLE)));
	return out;
}

function openButton(url: string | null | undefined): ChannelButton[][] {
	return url ? [[{ label: 'Open in Clopen', url }]] : [];
}

// ── Button data ─────────────────────────────────────────────────────────────
//
// `<rowId>:<action>`, where the action is an index, `s` (submit), `o` (other:
// type your own), `y` or `n`.
// Ten characters of id plus a few of action stays far below Telegram's 64-byte
// ceiling, and nothing else in a button is trusted — the row it names is
// re-checked against the chat that pressed it.

export type ButtonAction =
	| { type: 'option'; index: number }
	| { type: 'submit' }
	| { type: 'other' }
	| { type: 'confirm' }
	| { type: 'cancel' };

const ACTION_CODES = { submit: 's', other: 'o', confirm: 'y', cancel: 'n' } as const;

export function encodeButtonData(rowId: string, action: ButtonAction): string {
	return `${rowId}:${action.type === 'option' ? String(action.index) : ACTION_CODES[action.type]}`;
}

export function decodeButtonData(data: string): { rowId: string; action: ButtonAction } | null {
	const match = /^([A-Za-z0-9]{6,32}):(s|o|y|n|\d{1,3})$/.exec(data);
	if (!match) return null;
	const raw = match[2];
	const named = (Object.entries(ACTION_CODES) as Array<[Exclude<ButtonAction['type'], 'option'>, string]>).find(([, code]) => code === raw);
	const action: ButtonAction = named ? ({ type: named[0] } as ButtonAction) : { type: 'option', index: Number(raw) };
	return { rowId: match[1], action };
}

// ── Questions ───────────────────────────────────────────────────────────────

/** The answer string the engine receives — the exact shape the web UI's form produces. */
export function answerFromSelection(question: AskUserQuestion, selected: number[], custom?: string): string {
	const labels = selected
		.filter((index) => index >= 0 && index < question.options.length)
		.sort((a, b) => a - b)
		.map((index) => question.options[index].label);
	const customText = custom?.trim();
	if (question.multiSelect) return [...labels, ...(customText ? [customText] : [])].join(', ');
	return customText || labels.join(', ');
}

function questionBody(payload: QuestionPayload): TextRun[] {
	const { question, index, total } = payload;
	const counter = total > 1 ? ` (${index + 1} of ${total})` : '';
	const title = [bold(`❓ ${chatNotificationMessage('waiting-input').title}${counter}`)];
	const asked: TextRun[][] = [];
	if (question.header?.trim()) asked.push([bold(question.header.trim())]);
	asked.push([plain(question.question.trim())]);
	const described = question.options.some((option) => option.description?.trim());
	const options = described
		? question.options.map((option, i) => {
				const description = option.description?.trim();
				return description ? [bold(`${i + 1}. ${option.label}`), plain(`: ${description}`)] : [bold(`${i + 1}. ${option.label}`)];
			})
		: [];
	return stack(lines(title, headerLine(payload.context)), lines(...asked), options.length ? lines(...options) : null);
}

/**
 * A question still waiting, laid out like the web form. Single choice: one
 * button per option, and "Other…" to type an answer instead. Several
 * choices: options are checkboxes, "Other…" adds a typed answer to the
 * ticked ones, and Submit sends them together.
 */
export function questionCard(rowId: string, payload: QuestionPayload, options: { typing?: boolean } = {}): ChannelCard {
	const { question, selected } = payload;
	const custom = payload.custom?.trim();
	const hint = options.typing
		? 'Type your answer and send it.'
		: question.multiSelect
			? 'Tick what applies, then Submit.'
			: 'Tap an answer, or Other to type your own.';

	const optionRows: ChannelButton[][] = question.options.map((option, index) => {
		const box = question.multiSelect ? (selected.includes(index) ? '☑️ ' : '⬜ ') : '';
		return [{ label: clip(`${box}${option.label}`, MAX_BUTTON_LABEL), data: encodeButtonData(rowId, { type: 'option', index }) }];
	});
	const otherLabel = question.multiSelect
		? custom ? `☑️ Other: ${custom}` : options.typing ? '✏️ Other (typing…)' : '⬜ Other…'
		: options.typing ? '✏️ Other (typing…)' : '✏️ Other…';
	optionRows.push([{ label: clip(otherLabel, MAX_BUTTON_LABEL), data: encodeButtonData(rowId, { type: 'other' }) }]);
	if (question.multiSelect) {
		const count = selected.length + (custom ? 1 : 0);
		optionRows.push([{ label: count ? `Submit (${count})` : 'Submit', data: encodeButtonData(rowId, { type: 'submit' }) }]);
	}

	return { runs: stack(questionBody(payload), [italic(hint)]), buttons: [...optionRows, ...openButton(payload.openUrl)] };
}

/** A question whose answer is in, but whose siblings in the same tool may not be. */
export function questionAnsweredCard(payload: QuestionPayload, answer: string, pending: number): ChannelCard {
	const tail = pending > 0 ? [italic(`${pending} more question${pending === 1 ? '' : 's'} to go.`)] : null;
	return { runs: stack(questionBody(payload), [plain('✅ '), bold(answer || '(no answer)')], tail), buttons: openButton(payload.openUrl) };
}

/** A question settled somewhere else, or one that will never be answered. */
export function questionClosedCard(payload: QuestionPayload, reason: 'answered-elsewhere' | 'run-ended'): ChannelCard {
	const note = reason === 'answered-elsewhere' ? '✅ Answered in Clopen.' : '⏹ No longer waiting. The run ended.';
	return { runs: stack(questionBody(payload), [italic(note)]), buttons: openButton(payload.openUrl) };
}

// ── Turns ───────────────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The answer to a turn the chat started — the conversation itself. The header
 * is only shown when the reply is not about the session the chat is already
 * in: inside one conversation it would be noise on every message.
 */
export function answerRuns(input: { markdown: string; context: ChannelContext; showHeader: boolean }): TextRun[] {
	const body = markdownToRuns(input.markdown.trim() || '_(no text in this reply)_');
	return input.showHeader ? stack(headerLine(input.context), body) : body;
}

/**
 * A turn that failed. Whatever it said before failing is still shown — it is
 * often most of the work — and the failure follows it, so a partial answer
 * never reads as a finished one.
 */
export function failedRuns(input: { context: ChannelContext; showHeader: boolean; reason?: string | null; partial?: string | null }): TextRun[] {
	const partial = input.partial?.trim();
	return stack(
		input.showHeader ? headerLine(input.context) : null,
		partial ? markdownToRuns(partial) : null,
		[bold(partial ? '⚠️ The run failed before it finished.' : '⚠️ The run failed.'), ...(input.reason ? [plain(` ${clip(input.reason, 300)}`)] : [])],
		[italic('Reply to try again, or /retry.')]
	);
}

/** A turn stopped part-way: what it had said, then that it stopped. */
export function stoppedRuns(input: { context: ChannelContext; showHeader: boolean; partial: string }): TextRun[] {
	return stack(input.showHeader ? headerLine(input.context) : null, markdownToRuns(input.partial.trim()), [italic('⏹ Stopped.')]);
}

/** The live "still working" line, edited in place while a turn the chat started runs. */
export function progressCard(input: { elapsedMs: number; activity: string | null; steps: number }): ChannelCard {
	const steps = input.steps > 0 ? ` · ${input.steps} step${input.steps === 1 ? '' : 's'}` : '';
	return {
		runs: lines([italic(`⏳ Working · ${formatDuration(input.elapsedMs)}${steps}`)], input.activity ? [code(clip(input.activity, 120))] : [])
	};
}

/** One line describing a tool call — what the progress card shows. */
export function describeToolUse(name: string, input: Record<string, unknown> | undefined): string {
	const pick = (...keys: string[]) => {
		for (const key of keys) {
			const value = input?.[key];
			if (typeof value === 'string' && value.trim()) return value.trim().split('\n')[0];
		}
		return null;
	};
	const target = pick('file_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'prompt');
	return target ? `${name} ${target}` : name;
}

// ── Menus, confirmations, status ────────────────────────────────────────────

export interface MenuItem {
	label: string;
	/** A second line of context — a path, a provider. Shown in the text, not on the button. */
	detail?: string;
	current?: boolean;
}

/**
 * A title (already formatted) followed by numbered items, one button each.
 * Items past the list's own length are not shown in the text — the buttons
 * carry them — so a long model list stays readable.
 */
export function menuCard(rowId: string, title: TextRun[], items: MenuItem[]): ChannelCard {
	const listed = items.length <= MAX_LISTED_ITEMS;
	const listing = listed
		? items.map((item, i) => {
				const row: TextRun[] = [bold(`${i + 1}. ${item.label}`)];
				if (item.current) row.push(plain(' ✓'));
				if (item.detail) row.push(plain(` · ${clip(item.detail, 80)}`));
				return row;
			})
		: [];
	return {
		runs: stack(title, listing.length ? lines(...listing) : null),
		buttons: items.map((item, index) => [{ label: clip(`${item.current ? '✓ ' : ''}${item.label}`, MAX_BUTTON_LABEL), data: encodeButtonData(rowId, { type: 'option', index }) }])
	};
}

export function confirmCard(rowId: string, input: { title: string; detail: string; confirmLabel: string }): ChannelCard {
	return {
		runs: stack([bold(input.title)], [plain(input.detail)]),
		buttons: [[
			{ label: input.confirmLabel, data: encodeButtonData(rowId, { type: 'confirm' }) },
			{ label: 'Cancel', data: encodeButtonData(rowId, { type: 'cancel' }) }
		]]
	};
}

/**
 * Commands the chat app owns itself: they are about THIS chat (help,
 * unlinking, going back in its conversation). Everything else comes from
 * the control catalog (`backend/control/`), which is where a new command belongs.
 */
export const CHAT_COMMANDS: { command: string; description: string; hint?: string }[] = [
	{ command: 'help', description: 'What this bot can do' },
	{ command: 'retry', description: 'Ask the last message again' },
	{ command: 'undo', description: 'Undo the last message and its file changes' },
	{ command: 'unlink', description: 'Unlink this chat' }
];

// ── Conversation replies ────────────────────────────────────────────────────

export const REPLIES = {
	paired:
		`Linked to your Clopen. Just type to chat, or send photos and files. You start in Home, with no project selected: /projects switches project, /model picks a model, /help lists everything.\n\nSend /unlink to unlink this chat.`,
	chatOff: 'This chat is switched off in Clopen → Settings → Chat Apps, so it cannot do anything right now.',
	chatOn: '✅ This chat is switched back on.',
	pairingExpired: 'That link has expired or was already used. Open Clopen → Settings → Chat Apps and link Telegram again.',
	notLinked: 'This chat is not linked to Clopen yet. Open Clopen → Settings → Chat Apps and choose "Link Telegram".',
	groupRefused: 'Clopen only links to a private chat with this bot, never to a group.',
	unlinked: 'Unlinked. This chat no longer controls Clopen.',
	helpIntro:
		'Type to chat with the session you are in, including photos, files and albums. Reply to any earlier message to continue from that point. Edit a message you sent to rewrite it, like Edit in Clopen.',
	controlOff: 'Controlling Clopen is switched off for this bot. Turn on "Control Clopen" for it in Settings → Integrations.',
	unknownCommand: (name: string) => `There is no /${name}. /help lists what this bot can do.`,
	sendAsMessage: 'Send it to the session as a message instead?',
	skillNotACommand: (name: string) => `${name.replace(/_/g, '-')} is one of your skills. Run it with /run ${name.replace(/_/g, '-')}, followed by what it needs.`,
	pickReply: 'Several questions are waiting. Reply to the one you are answering (swipe it, or long-press and choose Reply) so it reaches the right session.',
	staleQuestion: 'That question is no longer waiting for an answer.',
	staleAction: 'That is no longer available.',
	noAccess: 'You no longer have access to that project.',
	sessionGone: 'That session no longer exists.',
	answerFailed: 'The session stopped waiting before the answer arrived. Open Clopen to see where it is.',
	noModel: 'No model is picked yet. Use /model to choose one, then send your message again.',
	busyBranch: 'That session is still running. /stop it first, or wait for it to finish, then reply again.',
	busyRestore: 'The session is running. Wait for it to finish (or /stop it) before going back.',
	notEditable: 'Only messages you sent from this chat can be edited here, and only into a session that still exists.',
	nothingToRetry: 'Nothing to retry yet. Send a message first.',
	nothingToUndo: 'Nothing to undo. This session has no message yet.',
	undone: (files: number) => (files > 0 ? `↩️ Went back to before the last message (${files} file${files === 1 ? '' : 's'} restored).` : '↩️ Went back to before the last message.'),
	queuedEdited: '✏️ Updated. Your queued message will run with the new text.',
	editReplaced: 'Replaced by your newer edit.',
	attachmentsDropped: (problems: string[]) => `⚠️ Some files did not come through:\n${problems.map((problem) => `• ${problem}`).join('\n')}`,
	nothingToSend: 'There was nothing in that message to send.',
	otherAdded: '☑️ Added as "Other". Tick anything else, then Submit.',
	answerTakesText: 'A question is answered with text or a tap, so the file was not sent with your answer.',
	cancelled: 'Cancelled. Nothing changed.',
	queued: '🕒 The session is still working. Your message is queued and runs next.',
	branched: (files: number) => (files > 0 ? `↩️ Went back to that point (${files} file${files === 1 ? '' : 's'} restored) and sent your message.` : '↩️ Went back to that point and sent your message.'),
	testMessage: '🔔 Test message from Clopen. This chat is linked and working.'
} as const;
