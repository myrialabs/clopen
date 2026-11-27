/**
 * Other chats — of this project or of any other — and single messages.
 *
 * A chat is attached as the transcript of its active branch: what was asked,
 * answered and done, in the form the engine handoff already uses. A message
 * is attached as its own text, for "do what this said".
 */

import type { ChatSession } from '$shared/types/database/schema';
import type { MentionCandidate } from '$shared/types/mentions';
import { buildContextDocument } from '$shared/utils/context-document';
import { loadMessage } from '$shared/utils/message-formatter';
import { messageQueries, projectQueries, sessionQueries } from '$backend/database/queries';
import { extractMessageText } from '$backend/snapshot/helpers';
import { renderBranchTranscript } from '$backend/chat/engine-handoff';
import { ago, rank, wants } from '../shared';
import { refString, type MentionContext, type MentionSource } from '../types';

const HERE = 'chats';
const EVERYWHERE = 'chats-all';

function titleOf(session: ChatSession): string {
	// Titles are cut from the first message and keep its line breaks.
	return (session.title || session.head_title || '').replace(/\s+/g, ' ').trim() || 'Untitled chat';
}

function lastActive(session: ChatSession): string {
	return session.last_message_at || session.started_at;
}

function sessionRow(session: ChatSession, projectName: string | null): MentionCandidate {
	const messages = session.user_count ?? 0;
	return {
		key: `chat-session:${session.id}`,
		kind: 'chat-session',
		group: projectName ? 'Chats in other projects' : 'Chats',
		label: titleOf(session),
		detail: [projectName, `${messages} ${messages === 1 ? 'message' : 'messages'}`, ago(lastActive(session))].filter(Boolean).join(' · '),
		icon: 'lucide:messages-square',
		ref: { sessionId: session.id }
	};
}

/** Chats of this project that have something in them, latest first, without the one being written in. */
function projectChats(ctx: MentionContext): ChatSession[] {
	return sessionQueries
		.getByProjectId(ctx.projectId)
		.filter((session) => session.id !== ctx.chatSessionId && (session.message_count ?? 0) > 0)
		.sort((a, b) => lastActive(b).localeCompare(lastActive(a)));
}

/** Chats of the other listed projects: matched by content when searching, latest otherwise. */
function otherChats(ctx: MentionContext, query: string, limit: number): MentionCandidate[] {
	const names = new Map(projectQueries.getListed().map((project) => [project.id, project.name]));
	const sessions = query.trim()
		? sessionQueries.searchGlobal(query, limit * 2)
		: sessionQueries.getAll().filter((session) => names.has(session.project_id)).sort((a, b) => lastActive(b).localeCompare(lastActive(a))).slice(0, limit * 2);
	return sessions
		.filter((session) => session.project_id !== ctx.projectId && names.has(session.project_id) && (session.message_count ?? 0) > 0)
		.slice(0, limit)
		.map((session) => sessionRow(session, names.get(session.project_id) ?? null));
}

export const chatsSource: MentionSource = {
	kinds: ['chat-session', 'chat-message'],

	categories: () => [
		{ id: HERE, label: 'Chats', detail: 'Other chats in this project', icon: 'lucide:messages-square', group: 'Chats' },
		{ id: EVERYWHERE, label: 'Chats in other projects', detail: 'Search every project’s chats', icon: 'lucide:messages-square', group: 'Chats' }
	],

	async list(ctx, request) {
		if (wants(request.category, HERE) === 'own') {
			return rank(projectChats(ctx).map((session) => sessionRow(session, null)), request.query, (row) => [row.label], request.limit);
		}
		if (wants(request.category, EVERYWHERE) === 'own') return otherChats(ctx, request.query, request.limit);
		if (request.category) return [];
		if (!request.query.trim()) return [];
		const here = rank(projectChats(ctx).map((session) => sessionRow(session, null)), request.query, (row) => [row.label], 3);
		return [...here, ...otherChats(ctx, request.query, 2)];
	},

	async capture(_ctx, kind, ref) {
		if (kind === 'chat-message') {
			const row = messageQueries.getById(refString(ref, 'messageId'));
			if (!row) throw new Error('That message is gone');
			const message = loadMessage(row);
			const session = sessionQueries.getById(row.session_id);
			const text = extractMessageText(message).trim();
			const role = message.type === 'user' ? 'User' : 'Assistant';
			return {
				documents: [buildContextDocument({
					kind,
					label: `${role} message in "${session ? titleOf(session) : 'a chat'}"`,
					detail: text.split('\n')[0].slice(0, 80),
					facts: [['From', role], ['Sent', row.created_at], ['Chat', session ? titleOf(session) : null]],
					sections: [{ title: 'Message', body: text || '(no text)' }]
				})]
			};
		}

		const session = sessionQueries.getById(refString(ref, 'sessionId'));
		if (!session || !projectQueries.isListed(session.project_id)) throw new Error('That chat is gone');
		const transcript = renderBranchTranscript(session.id);
		if (!transcript) throw new Error('That chat has nothing in it yet');
		const project = projectQueries.getById(session.project_id);
		return {
			documents: [buildContextDocument({
				kind,
				label: titleOf(session),
				detail: `${transcript.turns} turns`,
				facts: [
					['Project', project ? `${project.name} (${project.path})` : null],
					['Engine', session.model_name ? `${session.engine} · ${session.model_name}` : session.engine],
					['Started', session.started_at],
					['Last message', session.last_message_at]
				],
				sections: [{ title: 'Transcript', body: transcript.text }]
			})]
		};
	}
};
