/**
 * Cards — when Clopen needs the owner, it asks right where the owner is.
 *
 * A card is an open Inbox row with a `card` type in its data: a question, an
 * approval, a "connect this service" link, or a field for a secret. Raising one
 * shows it at once in Clopen's chat (and in "Needs you"), on every linked
 * chat app, and as a push notification; the owner answers in place. There is
 * no Inbox to go and check.
 *
 * Recipes wait on cards: `ask` and `approve` steps await `waitForCard()`, which
 * resolves the moment the owner answers anywhere. A waiter lives in memory; a
 * card answered after a restart reaches the assistant instead.
 */

import { inboxQueries } from '$backend/database/queries';
import type { InboxItem } from '$shared/types/assistant';
import { debug } from '$shared/utils/logger';
import { raiseInboxItem, resolveInboxItem } from './inbox';
import { toInboxItem } from './mappers';

export type CardKind = 'ask' | 'approve' | 'connect' | 'secret';

export interface CardField {
	/** Where the value goes: an MCP server's env var or header, or a named secret. */
	name: string;
	label: string;
	secret: boolean;
}

export interface CardRefs {
	missionId?: string | null;
	jobId?: string | null;
	sessionId?: string | null;
	projectId?: string | null;
}

type Answer = { kind: 'answer'; text: string } | { kind: 'approved'; approved: boolean } | { kind: 'done' } | { kind: 'cancelled' };

const waiters = new Map<string, (answer: Answer) => void>();

export function raiseCard(input: {
	card: CardKind;
	title: string;
	body?: string;
	options?: string[];
	url?: string;
	fields?: CardField[];
	target?: Record<string, unknown>;
	refs?: CardRefs;
}): InboxItem {
	const kind = input.card === 'approve' ? 'approval' : 'question';
	const { title, body } = shape(input.title, input.body ?? '');
	return raiseInboxItem({
		kind,
		title,
		body,
		data: {
			card: input.card,
			...(input.options?.length ? { options: input.options } : {}),
			...(input.url ? { url: input.url } : {}),
			...(input.fields?.length ? { fields: input.fields } : {}),
			...(input.target ? { target: input.target } : {})
		},
		...input.refs
	});
}

/**
 * A card reads like a message: escaped quotes a model left in (`\\"ok\\"`) are
 * undone, and a long question gets a short title with the rest as its body.
 */
/**
 * A card's title is one plain line — never a report pasted into it ("Publish
 * this launch? ## Handoff report **What I did**…"). The first line or
 * sentence is the title; everything after it, with markdown taken out, is
 * the body.
 */
function shape(rawTitle: string, rawBody: string): { title: string; body: string } {
	const clean = (text: string) => text.replace(/\\"/g, '"').replace(/\\n/g, '\n').trim();
	const plain = (text: string) =>
		text
			.replace(/^#{1,6}\s*/gm, '')
			.replace(/\*\*([^*]+)\*\*/g, '$1')
			.replace(/`([^`]+)`/g, '$1')
			.replace(/^\s*[-*•]\s+/gm, '• ')
			.trim();
	const text = clean(rawTitle);
	const [firstLine, ...moreLines] = text.split('\n');
	let title = plain(firstLine);
	let rest = moreLines.join('\n');
	if (title.length > 140) {
		const cut = title.search(/[.?!:](\s|$)/);
		const head = cut >= 8 && cut < 140 ? title.slice(0, cut + 1) : `${title.slice(0, 120).replace(/\s+\S*$/, '')}…`;
		rest = [title.slice(head.endsWith('…') ? head.length - 1 : head.length).trim(), rest].filter(Boolean).join('\n');
		title = head;
	}
	const body = [plain(rest), plain(clean(rawBody))].filter(Boolean).join('\n\n');
	return { title, body };
}

/** Wait for the owner to settle a card. */
export function waitForCard(itemId: string, signal?: AbortSignal): Promise<Answer> {
	return new Promise((resolve) => {
		waiters.set(itemId, resolve);
		signal?.addEventListener('abort', () => {
			if (waiters.delete(itemId)) {
				resolveInboxItem(itemId, 'dismissed', { by: 'clopen', note: 'No longer needed' });
				resolve({ kind: 'cancelled' });
			}
		});
	});
}

/** True when something is waiting on this card (so an answer goes there, not to the assistant). */
export function isAwaited(itemId: string): boolean {
	return waiters.has(itemId);
}

function settle(itemId: string, answer: Answer, resolution: Record<string, unknown>): boolean {
	const row = inboxQueries.getById(itemId);
	if (!row || row.status !== 'open') return false;
	resolveInboxItem(itemId, 'resolved', resolution);
	const waiter = waiters.get(itemId);
	waiters.delete(itemId);
	try {
		waiter?.(answer);
	} catch (error) {
		debug.warn('assistant', 'A card waiter failed:', error);
	}
	return Boolean(waiter);
}

/** The owner answered a question card. Returns whether a recipe was waiting on it. */
export function answerCard(itemId: string, text: string, by: 'owner' | 'chat' = 'owner'): boolean {
	return settle(itemId, { kind: 'answer', text }, { reply: text, by });
}

/** The owner approved or declined an approval card that a recipe is waiting on. */
export function decideCard(itemId: string, approved: boolean, source: 'web' | 'telegram' | null = 'web'): boolean {
	const row = inboxQueries.getById(itemId);
	const waited = settle(itemId, { kind: 'approved', approved }, { approved, by: 'owner' });
	if (row?.status === 'open' && source && (waited || row.data.includes('"connector-approval"'))) noteCardAnswer(toInboxItem(row), `${approved ? '✅' : '✖'} ${row.title}`, source);
	// A third-party connector the owner was asked about: connect it now, or tell the asker it was declined.
	if (row?.status === 'open' && row.data.includes('"connector-approval"')) {
		void import('./connect').then(({ onConnectorDecision }) => onConnectorDecision(toInboxItem(row), approved)).catch((error) => debug.warn('assistant', 'Acting on a connector decision failed:', error));
		return true;
	}
	return waited;
}

/** A connect/secret card finished (the service is connected, the secret stored). */
export function completeCard(itemId: string, note: string): void {
	settle(itemId, { kind: 'done' }, { note, by: 'owner' });
}

/** Open cards for one connect/secret target (e.g. an MCP server), newest first. */
export function openCardsFor(match: (data: Record<string, unknown>, item: InboxItem) => boolean): InboxItem[] {
	return inboxQueries
		.list({ status: 'open', limit: 200 })
		.map(toInboxItem)
		.filter((item) => typeof item.data.card === 'string' && match(item.data, item));
}

/** Cancel everything a run was waiting for. */
export function cancelCards(itemIds: string[]): void {
	for (const id of itemIds) {
		const waiter = waiters.get(id);
		waiters.delete(id);
		if (inboxQueries.getById(id)?.status === 'open') resolveInboxItem(id, 'dismissed', { by: 'clopen', note: 'No longer needed' });
		waiter?.({ kind: 'cancelled' });
	}
}

// ── Answering from anywhere (web field, chat reply) ─────────────────────────

/** Emoji answers mean the same in every language; words are left to a model. */
const YES = /^(👍|✅|👌|🙆)/u;
const NO = /^(👎|❌|✖|🙅)/u;

export interface CardReply {
	/** A short line to show back when there is something to say; empty when a 👍 is enough. */
	text: string;
	/** The card was settled. */
	done: boolean;
}

/**
 * The owner answered a card with text — from a chat reply or the web. Routes
 * it to whatever is waiting (a recipe step, an approval, a key field) or, when
 * nothing is, to the chat that asked.
 */
/**
 * Cards answered by a message that already has its own turn: what follows
 * from the answer (a declined connector, a reply nobody waited for) is a
 * note for that turn — never a second turn answering the same message.
 */
const answeredInTurn = new Set<string>();

export function wasAnsweredInTurn(itemId: string): boolean {
	return answeredInTurn.delete(itemId);
}

/**
 * What the owner answered a card with, shown in the chat as their own words —
 * on the web and in Telegram — so an answer never just vanishes. A password
 * shows as dots; a login shows its name.
 */
export function noteCardAnswer(item: InboxItem, line: string, source: 'web' | 'telegram'): void {
	void import('./timeline')
		.then(async ({ recordOwnerLine }) => {
			const sessionId = recordOwnerLine({ id: `card:${item.id}`, sessionId: item.sessionId, text: line, source });
			if (source === 'web' && sessionId) {
				const [{ mirrorOwnerMessage }, { chatOfSession }] = await Promise.all([import('$backend/chat-apps/outbound'), import('./chats')]);
				await mirrorOwnerMessage(chatOfSession(sessionId), line, { attachments: 0, fromLinkId: null });
			}
		})
		.catch((error) => debug.warn('assistant', 'Showing a card answer failed:', error));
}

/** How a filled secret card reads in the chat: names shown, secrets as dots. */
export function maskedCardLine(item: InboxItem, values: Record<string, string>): string {
	const fields = Array.isArray(item.data.fields) ? (item.data.fields as CardField[]) : [];
	const parts = fields.map((field) => (field.secret ? '••••••' : (values[field.name] ?? '').trim())).filter(Boolean);
	return `🔒 ${item.title}${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
}

export async function answerCardWithText(itemId: string, text: string, options: { inTurn?: boolean; source?: 'web' | 'telegram' } = {}): Promise<CardReply> {
	if (options.inTurn) answeredInTurn.add(itemId);
	const row = inboxQueries.getById(itemId);
	if (!row || row.status !== 'open') return { text: '', done: true };
	const item = toInboxItem(row);
	const card = String(item.data.card ?? '');
	// A message with its own turn is already in the chat; anything else is shown as the owner's words.
	const source = options.inTurn ? null : (options.source ?? 'web');

	if (item.kind === 'approval') {
		let approved: boolean | null = YES.test(text.trim()) ? true : NO.test(text.trim()) ? false : null;
		if (approved === null) {
			const { classify } = await import('./think');
			approved = (await classify('Is this reply agreeing (yes) or refusing (no)?', ['yes', 'no'], text).catch(() => null)) === 'yes';
		}
		if (decideCard(item.id, approved, source)) return { text: '', done: true };
		if (source) noteCardAnswer(item, `${approved ? '✅' : '✖'} ${item.title}`, source);
		const { settleApproval } = await import('$backend/control/agent');
		await settleApproval(item.id, approved);
		return { text: '', done: true };
	}
	if (card === 'secret') {
		const fields = Array.isArray(item.data.fields) ? (item.data.fields as CardField[]) : [];
		const values: Record<string, string> = {};
		const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
		if (fields.length <= 1) values[fields[0]?.name ?? 'value'] = text.trim();
		else {
			for (const line of lines) {
				const match = /^\s*([^=:]+?)\s*[=:]\s*(.+)$/.exec(line);
				const field = match && fields.find((entry) => entry.name.endsWith(match[1].trim()) || entry.label === match[1].trim());
				if (field && match) values[field.name] = match[2].trim();
			}
			// "email, then password" on their own lines, in the card's order.
			if (Object.keys(values).length === 0 && lines.length >= fields.length) fields.forEach((field, index) => (values[field.name] = lines[index]));
		}
		const { fillSecretCard } = await import('./connect');
		const result = await fillSecretCard(item, values, source);
		return { text: result.startsWith('Saved') ? '' : result, done: true };
	}
	if (card === 'connect') return { text: typeof item.data.url === 'string' ? item.data.url : '', done: false };
	if (source) noteCardAnswer(item, text.trim(), source);
	if (answerCard(item.id, text)) return { text: '', done: true };
	if (options.inTurn) {
		resolveInboxItem(item.id, 'resolved', { reply: text, by: 'owner' });
		return { text: '', done: true };
	}
	await forwardReply(item, text);
	return { text: '', done: true };
}

/**
 * Before Clopen answers a message in its chat: does the message answer a
 * question that is waiting on the owner — "ok" to the CV defaults, "yes" to
 * an approval? Then it goes to that question, so the work it belongs to goes
 * on instead of a new task starting. And does it call something off — "never
 * mind, send it to Notion instead" while a Threads sign-in card waits? Then
 * those cards close, here and in the chat apps. A model judges both (no word
 * lists). Returns a note for Clopen's brief.
 */
export async function routeReplyToOpenCard(sessionId: string, text: string): Promise<string | null> {
	if (!text.trim() || text.startsWith('[Clopen')) return null;
	const { missionQueries } = await import('$backend/database/queries');
	const { chatOfSession, sessionsOfChat } = await import('./chats');
	const sessions = new Set([sessionId, ...sessionsOfChat(chatOfSession(sessionId))]);
	const missionIds = new Set(missionQueries.listOpen().filter((mission) => mission.assistant_session_id && sessions.has(mission.assistant_session_id)).map((mission) => mission.id));
	const open = inboxQueries
		.list({ status: 'open', limit: 100 })
		.map(toInboxItem)
		.filter((item) => (typeof item.data.card === 'string' || item.kind === 'approval') && ((item.sessionId && sessions.has(item.sessionId)) || (item.missionId && missionIds.has(item.missionId))));
	if (!open.length) return null;
	const { think } = await import('./think');
	const pick = await think<{ answers: number; dropped: number[] }>(
		[
			'The owner just wrote a message. These things are waiting on them (questions, approvals, sign-ins, keys).',
			'"answers": the number of the question or approval the message answers, or 0. Sign-ins and keys are never answered by a message.',
			'"dropped": the numbers of the items the message calls off — the owner no longer wants what they were for (they changed their mind, chose something else, or said to forget it). Empty when nothing is called off.',
			`Message: ${text.slice(0, 1000)}`,
			'',
			...open.map((item, index) => `${index + 1}. [${item.data.card ?? item.kind}] ${item.title}${item.body ? ` — ${item.body.slice(0, 300)}` : ''}`)
		].join('\n'),
		{
			type: 'object',
			additionalProperties: false,
			properties: { answers: { type: 'integer' }, dropped: { type: 'array', items: { type: 'integer' } } },
			required: ['answers', 'dropped']
		}
	).catch(() => ({ answers: 0, dropped: [] as number[] }));
	const dropped = (pick.dropped ?? []).map((index) => open[index - 1]).filter((item): item is InboxItem => Boolean(item) && item !== open[pick.answers - 1]);
	if (dropped.length) cancelCards(dropped.map((item) => item.id));
	const item = open[pick.answers - 1];
	const isQuestion = item && (item.data.card === 'ask' || item.data.card === 'approve' || item.kind === 'approval');
	if (!item || !isQuestion) {
		return dropped.length ? `[Clopen · the owner's message called off: ${dropped.map((entry) => `"${entry.title.slice(0, 80)}"`).join(', ')} — those cards are closed.]` : null;
	}
	await answerCardWithText(item.id, text, { inTurn: true });
	return `[Clopen · the owner's message above answered the waiting question "${item.title.slice(0, 160)}" and was passed on; that work continues. Reply in a few words; do not start anything new for it.]`;
}

/** Nothing is waiting on this card any more: hand the owner's reply to the chat that asked. */
export async function forwardReply(item: InboxItem, reply: string): Promise<string> {
	const { askAssistant } = await import('./ask');
	const prompt = [
		`[Clopen · owner reply] The owner answered "${item.title}":`,
		reply,
		'',
		item.sessionId
			? `It concerns session ${item.sessionId}${item.missionId ? ` of task ${item.missionId}` : ''}. If an agent there is waiting on a question, answer it with task.answer; otherwise carry the reply to where it belongs.`
			: 'Act on it.'
	].join('\n');
	const { sessionQueries } = await import('$backend/database/queries');
	const asker = item.sessionId ? sessionQueries.getById(item.sessionId) : null;
	const { sessionId } = await askAssistant(prompt, {
		title: `Reply: ${item.title}`,
		sessionId: asker && (await import('./manager-policy')).isAssistantProjectId(asker.project_id) ? asker.id : null
	});
	resolveInboxItem(item.id, 'resolved', { reply, sessionId });
	return sessionId;
}
