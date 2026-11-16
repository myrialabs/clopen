/**
 * One of Clopen's chats, many sessions underneath.
 *
 * The owner decides what is a separate conversation — Main, or a chat they
 * opened for something else. Clopen never splits one on its own any more:
 * guessing "a new topic" from the words broke replies like "no, send it to
 * Notion instead" off from what they answered, and a message sent while
 * Clopen was busy went to a parallel session that knew nothing of the work
 * it was about. A message sent while Clopen works now waits its turn in the
 * same chat (the composer queues it).
 *
 * The one move left is quiet: when a session has grown past what is worth
 * carrying, a fresh one continues the same chat. It never starts blank — it
 * carries a context capsule (the last exchanges, the tasks under way, the
 * recent journal) on its first turn; anything older is one `chat.history`
 * call away.
 */

import { messageQueries, missionQueries, sessionQueries, projectQueries } from '$backend/database/queries';
import { isAssistantProject } from '$shared/utils/assistant-project';
import type { ChatSession, Project } from '$shared/types/database/schema';
import type { UnifiedMessage } from '$shared/types/unified';
import { createSession, modelOf } from '$backend/control/workspace';
import { debug } from '$shared/utils/logger';
import { recentJournalDigest } from './journal';
import { toMission } from './mappers';

/** Messages past which a session hands over to a fresh one. */
export const LONG_SESSION_MESSAGES = 120;

export type RouteReason = 'continue' | 'long' | 'new-topic' | 'fresh';

export interface RouteDecision {
	sessionId: string;
	changed: boolean;
	reason: RouteReason;
}

interface Exchange {
	role: 'owner' | 'clopen';
	text: string;
	at: string;
}

/** Sessions the assistant asked to close for routing (`chat.new-topic`). */
const closedForRouting = new Set<string>();

/** Context capsules waiting for their session's first turn. */
const pendingCapsules = new Map<string, string>();

function textOf(message: UnifiedMessage): string {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return '';
	return content
		.filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
		.map((block: any) => block.text as string)
		.join('\n')
		.trim();
}

/** The last owner/Clopen exchanges of a session, text only, newest last. */
export function recentExchanges(sessionId: string, max = 8): Exchange[] {
	const head = sessionQueries.getHead(sessionId);
	if (!head) return [];
	const path = messageQueries.getPathToRoot(head).slice(-200);
	const out: Exchange[] = [];
	for (const row of path) {
		try {
			const message = JSON.parse(row.data) as UnifiedMessage;
			if (message.type === 'user') {
				if ((message as { parent?: { toolUseId?: string | null } }).parent?.toolUseId) continue;
				const text = textOf(message);
				if (text && !text.startsWith('[Clopen ·')) out.push({ role: 'owner', text, at: row.created_at });
			} else if (message.type === 'assistant') {
				const text = textOf(message);
				if (text) {
					const last = out[out.length - 1];
					if (last?.role === 'clopen') last.text = text;
					else out.push({ role: 'clopen', text, at: row.created_at });
				}
			}
		} catch {
			// Unreadable rows are skipped.
		}
	}
	return out.slice(-max);
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What a fresh session needs to pick up where the conversation is. */
export function buildCapsule(fromSessionId: string | null, reason: RouteReason): string {
	const lines: string[] = ['<clopen-context>'];
	if (fromSessionId) {
		const exchanges = recentExchanges(fromSessionId, reason === 'new-topic' ? 4 : 8);
		if (exchanges.length) {
			lines.push(
				reason === 'long'
						? `This continues a long chat (${fromSessionId}). Its latest exchanges:`
						: `Earlier in this conversation (chat ${fromSessionId}):`
			);
			for (const exchange of exchanges) lines.push(`${exchange.role === 'owner' ? 'Owner' : 'Clopen'}: ${clip(exchange.text, 400)}`);
		}
	}
	const open = missionQueries.listOpen().map(toMission);
	if (open.length) {
		lines.push('Tasks under way:');
		for (const mission of open.slice(0, 6)) lines.push(`- ${mission.id} "${mission.title}" · ${mission.status}`);
	}
	const digest = recentJournalDigest(48, 12);
	if (digest) lines.push('Recently:', digest);
	lines.push('Older chats are available through the chat.history action — use it only when the owner refers to something not shown here.');
	lines.push('</clopen-context>');
	return lines.join('\n');
}

export function setPendingCapsule(sessionId: string, capsule: string): void {
	pendingCapsules.set(sessionId, capsule);
}

/** The capsule a session's first turn carries, once. */
export function takePendingCapsule(sessionId: string): string | null {
	const capsule = pendingCapsules.get(sessionId) ?? null;
	pendingCapsules.delete(sessionId);
	return capsule;
}

export function closeForRouting(sessionId: string): void {
	closedForRouting.add(sessionId);
}

function startFresh(project: Project, from: ChatSession | null, reason: RouteReason): RouteDecision {
	const model = from ? modelOf(from) : null;
	if (!model) {
		// No model to copy: let the caller create the session the usual way.
		return { sessionId: from?.id ?? '', changed: false, reason: 'continue' };
	}
	const created = createSession(project, model);
	setPendingCapsule(created.id, buildCapsule(from?.id ?? null, reason));
	return { sessionId: created.id, changed: true, reason };
}

/**
 * Decide which session a message to Clopen goes to. Only for the owner's own
 * messages in Clopen's chat — system prompts (task reports, automation runs)
 * target their session explicitly and never pass through here.
 */
export function routeAssistantMessage(input: { sessionId: string | null; text: string }): RouteDecision {
	const session = input.sessionId ? sessionQueries.getById(input.sessionId) : null;
	const project = session ? projectQueries.getById(session.project_id) : null;
	if (!session || !project || !isAssistantProject(project)) {
		return { sessionId: input.sessionId ?? '', changed: false, reason: 'fresh' };
	}
	try {
		if (closedForRouting.has(session.id)) {
			closedForRouting.delete(session.id);
			return startFresh(project, session, 'new-topic');
		}
		if ((session.message_count ?? 0) >= LONG_SESSION_MESSAGES) return startFresh(project, session, 'long');
	} catch (error) {
		debug.warn('assistant', 'Routing a message failed; continuing in the same chat:', error);
	}
	return { sessionId: session.id, changed: false, reason: 'continue' };
}
