/**
 * The Inbox — the one place the owner is asked for anything.
 *
 * Raising an item stores it, tells every open device, and — for the kinds that
 * are worth interrupting someone for — sends a push notification and a message
 * to every paired chat. What the assistant merely learned is stored and shown,
 * never pushed: a notification that needs no action is noise.
 */

import { inboxQueries, type InboxItemRow } from '$backend/database/queries';
import { getOwner } from '$backend/auth/auth-service';
import { sendPushToUser } from '$backend/push/sender';
import type { InboxItem, InboxKind } from '$shared/types/assistant';
import { debug } from '$shared/utils/logger';
import { notifyAssistantChanged } from './events';
import { toInboxItem } from './mappers';

/** Kinds that interrupt: they need an answer, or report something finished or stuck. */
const INTERRUPTING: ReadonlySet<InboxKind> = new Set(['question', 'approval', 'stalled', 'report']);

/** A mark before the title where the kind changes what the owner should do; reports go plain. */
const KIND_MARK: Partial<Record<InboxKind, string>> = {
	question: '❓ ',
	approval: '🛡️ ',
	stalled: '⚠️ '
};

export interface RaiseInput {
	kind: InboxKind;
	title: string;
	body?: string;
	data?: Record<string, unknown>;
	missionId?: string | null;
	jobId?: string | null;
	sessionId?: string | null;
	projectId?: string | null;
	/** Skip if an open item with the same dedupe key exists. */
	dedupe?: string;
	/** Do not send it to chat apps (the caller delivers it itself, with files). */
	skipChats?: boolean;
}

export function raiseInboxItem(input: RaiseInput): InboxItem {
	if (input.dedupe) {
		const existing = inboxQueries.findOpen(input.kind, { dedupe: input.dedupe });
		if (existing) return toInboxItem(existing);
	}
	const row = inboxQueries.create({
		kind: input.kind,
		title: input.title,
		body: input.body,
		data: { ...(input.data ?? {}), ...(input.dedupe ? { dedupe: input.dedupe } : {}) },
		missionId: input.missionId,
		jobId: input.jobId,
		sessionId: input.sessionId,
		projectId: input.projectId
	});
	notifyAssistantChanged('inbox', row.id);
	if (INTERRUPTING.has(row.kind)) void deliver(row, input.skipChats === true);
	return toInboxItem(row);
}

export function resolveInboxItem(
	id: string,
	status: 'resolved' | 'dismissed',
	resolution: Record<string, unknown> | null = null
): InboxItem | null {
	const row = inboxQueries.resolve(id, status, resolution);
	if (!row) return null;
	notifyAssistantChanged('inbox', id);
	const item = toInboxItem(row);
	// Its message in the owner's chats stops offering buttons that lead nowhere now.
	if (typeof item.data.card === 'string') {
		void import('$backend/chat-apps')
			.then(({ settleCardMessages }) => settleCardMessages(item))
			.catch((error) => debug.warn('assistant', 'Settling a card in chats failed:', error));
	}
	return item;
}

async function deliver(row: InboxItemRow, skipChats: boolean): Promise<void> {
	const mark = KIND_MARK[row.kind] ?? '';
	const owner = (() => {
		try {
			return getOwner();
		} catch {
			return null;
		}
	})();
	if (owner) {
		try {
			await sendPushToUser(owner.id, {
				title: `${mark}${row.title}`,
				body: row.body.slice(0, 300) || row.title,
				tag: `inbox-${row.id}`,
				url: '/#inbox'
			});
		} catch (error) {
			debug.warn('assistant', 'Pushing an inbox item failed:', error);
		}
	}
	if (skipChats) return;
	try {
		// Loaded on use: the chat-app layer imports the control catalog, which
		// imports this module's neighbours — a static import would be a cycle.
		const { broadcastToChats, announceCard } = await import('$backend/chat-apps');
		const item = toInboxItem(row);
		if (typeof item.data.card === 'string') {
			await announceCard(item);
			return;
		}
		const body = row.body.trim();
		const { chatOfItem } = await import('./timeline');
		await broadcastToChats(`**${mark}${row.title}**${body ? `\n\n${body.slice(0, 3000)}` : ''}`, { fromSessionId: row.session_id, chatId: chatOfItem(item) });
	} catch (error) {
		debug.warn('assistant', 'Sending an inbox item to chats failed:', error);
	}
}
