/**
 * The journal — what happened, in order, so Clopen remembers yesterday even in
 * a new chat.
 *
 * Memories hold what was learned (decisions, preferences). The journal holds
 * the chronology: what the owner asked in each chat with Clopen and what came
 * of it, every task started and finished, every automation result. A digest
 * of the last two days rides in the assistant's brief; the rest is searchable
 * through the `journal.search` action.
 */

import { journalQueries, projectQueries, sessionQueries, type JournalEntryRow } from '$backend/database/queries';
import { streamManager } from '$backend/chat/stream-manager';
import { lastTurnAnswer, userMessageText } from '$backend/chat/turn-answer';
import { isAssistantProject } from '$shared/utils/assistant-project';
import { debug } from '$shared/utils/logger';

export type JournalKind = 'chat' | 'task' | 'automation' | 'learned' | 'secret' | 'note';

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function journal(kind: JournalKind, text: string, refs: { sessionId?: string | null; projectId?: string | null; missionId?: string | null; jobId?: string | null } = {}): void {
	try {
		journalQueries.add({ kind, text: clip(text, 600), ...refs });
	} catch (error) {
		debug.warn('assistant', 'Writing the journal failed:', error);
	}
}

function line(entry: JournalEntryRow): string {
	const at = new Date(entry.created_at);
	const stamp = `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${at.toTimeString().slice(0, 5)}`;
	return `- ${stamp} [${entry.kind}] ${entry.text}`;
}

/** The last couple of days, compact enough to ride in every brief. */
export function recentJournalDigest(hours = 48, limit = 25): string {
	const since = new Date(Date.now() - hours * 3600_000).toISOString();
	const entries = journalQueries.since(since, limit);
	return entries.map(line).join('\n');
}

export function formatJournal(entries: JournalEntryRow[]): string {
	return entries.map(line).join('\n');
}

/** Record each finished exchange in Clopen's own chat: what was asked, what came of it. */
export function initJournal(): void {
	streamManager.on('stream:lifecycle', (event: { status: 'completed' | 'error' | 'cancelled'; projectId?: string; chatSessionId?: string }) => {
		try {
			if (!event.chatSessionId || !event.projectId || event.status !== 'completed') return;
			const project = projectQueries.getById(event.projectId);
			if (!project || !isAssistantProject(project)) return;
			const answer = lastTurnAnswer(event.chatSessionId);
			const asked = answer.userMessageId ? userMessageText(answer.userMessageId) : null;
			if (!asked || asked.startsWith('[Clopen')) return;
			const session = sessionQueries.getById(event.chatSessionId);
			journal('chat', `Owner: ${clip(asked, 200)} → ${clip(answer.text || '(acted without a reply)', 260)}`, {
				sessionId: session?.id ?? event.chatSessionId,
				projectId: event.projectId
			});
		} catch (error) {
			debug.warn('assistant', 'Journaling a chat turn failed:', error);
		}
	});
}
