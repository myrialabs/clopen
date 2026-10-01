/**
 * Chat Composer State
 *
 * Everything about the message box that outlives a page load, per chat session:
 *
 * - Drafts are per USER. Text and attachments typed in a session wait for the
 *   same person on any device, but never land in a collaborator's box — a
 *   shared box let two people overwrite each other keystroke by keystroke.
 * - Edit mode is per user too. Collaborators only learn THAT someone is
 *   editing; they never enter (or cancel, or submit) another person's edit.
 * - The message queue holds what was sent while the AI was still working, and
 *   the server starts the next one when a turn completes — so a queued message
 *   is sent even if every tab that queued it has been closed.
 *
 * All state is in memory, like the rest of the live chat state: a restart
 * drops drafts and the queue, not conversations.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import type { StreamRequest } from '$shared/types/unified';
import { debug } from '$shared/utils/logger';
import { ws } from '$backend/utils/ws';
import { streamManager } from '../../chat/stream-manager';
import { messageQueries } from '../../database/queries';
import { INITIAL_NODE_ID } from '../../snapshot/helpers';
import { requireSessionAccess } from '../access';
import { bridgeStreamToRoom, startChatStream } from './stream';

// ============================================================================
// State
// ============================================================================

interface DraftAttachment {
	id: string;
	fileName: string;
	type: string;
	mediaType: string;
	base64: string;
}

/**
 * A draft carries the revision of each part's latest write. Writes reach the
 * server in an order nobody controls — a save debounced while typing, the
 * clear that follows a send, a composer remounting mid-flight — so an older
 * write must never overwrite a newer one. An emptied draft is kept as a
 * tombstone for the same reason: a late save of the text that was just sent
 * would otherwise bring it back.
 */
interface Draft {
	text: string;
	attachments: DraftAttachment[];
	textRevision: number;
	attachmentsRevision: number;
}

interface EditState {
	messageId: string;
	messageTimestamp: string | null;
	userName: string;
}

interface QueuedMessage {
	id: string;
	userId: string;
	userName: string;
	createdAt: string;
	text: string;
	attachmentCount: number;
	request: StreamRequest;
}

/** Keyed by `draftKey(sessionId, userId)`. */
const drafts = new Map<string, Draft>();
/** chatSessionId → userId → that user's edit. */
const edits = new Map<string, Map<string, EditState>>();
/** chatSessionId → messages waiting for the current turn to finish, in order. */
const queues = new Map<string, QueuedMessage[]>();
/** Sessions whose next queued message is being started right now. */
const draining = new Set<string>();

function draftKey(chatSessionId: string, userId: string): string {
	return `${chatSessionId}\u0000${userId}`;
}

function isSessionBusy(chatSessionId: string, projectId: string): boolean {
	if (draining.has(chatSessionId)) return true;
	return streamManager.getSessionStream(chatSessionId, projectId)?.status === 'active';
}

function promptText(prompt: any): string {
	const content = Array.isArray(prompt?.content) ? prompt.content : [];
	return content
		.filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
		.map((block: any) => block.text as string)
		.join('\n');
}

function promptAttachmentCount(prompt: any): number {
	const content = Array.isArray(prompt?.content) ? prompt.content : [];
	return content.filter((block: any) => block?.type === 'image' || block?.type === 'document').length;
}

function editorsFor(chatSessionId: string, exceptUserId?: string) {
	const sessionEdits = edits.get(chatSessionId);
	if (!sessionEdits) return [];
	return [...sessionEdits.entries()]
		.filter(([userId]) => userId !== exceptUserId)
		.map(([userId, edit]) => ({ userId, userName: edit.userName, messageId: edit.messageId }));
}

function queueView(chatSessionId: string) {
	return (queues.get(chatSessionId) ?? []).map((item) => ({
		id: item.id,
		userId: item.userId,
		userName: item.userName,
		createdAt: item.createdAt,
		text: item.text,
		attachmentCount: item.attachmentCount
	}));
}

function broadcastQueue(chatSessionId: string): void {
	ws.emit.chatSession(chatSessionId, 'chat:queue', {
		chatSessionId,
		items: queueView(chatSessionId)
	});
}

/**
 * Start a queued message as a turn of its own. It gets a fresh timestamp (it
 * was written before the turn it waited on, but belongs after it) and no
 * client-side resume id: by now the branch has moved, so the stream resolves
 * the resume target from HEAD itself.
 */
async function startQueued(item: QueuedMessage): Promise<void> {
	const { chatSessionId } = item.request;
	// Busy from now on: a message queued while this one is still starting must
	// wait behind it, not start alongside it.
	draining.add(chatSessionId);
	try {
		await startPrepared(item);
	} finally {
		draining.delete(chatSessionId);
	}
}

async function startPrepared(item: QueuedMessage): Promise<void> {
	const request: StreamRequest = {
		...item.request,
		prompt: {
			...item.request.prompt,
			createdAt: new Date().toISOString(),
			parent: { messageId: null, sessionId: null, toolUseId: null }
		}
	};
	const streamId = await startChatStream(request);
	if (!streamId) return;
	// No connection owns this stream, so the bridge lives until the turn ends.
	bridgeStreamToRoom(streamId, request.chatSessionId, request.projectId);
}

// ============================================================================
// Lifecycle
// ============================================================================

// A completed turn starts the next queued message. Errors and cancels leave the
// queue in place: the user stopped (or the engine failed) for a reason, and
// what was queued behind it may no longer make sense — they send it on purpose.
streamManager.on('stream:lifecycle', (event: { status: string; streamId: string; projectId?: string; chatSessionId?: string }) => {
	const { status, streamId, chatSessionId } = event;
	if (status !== 'completed' || !chatSessionId) return;
	const queue = queues.get(chatSessionId);
	if (!queue?.length || draining.has(chatSessionId)) return;

	draining.add(chatSessionId);
	void (async () => {
		try {
			// Let the finished turn wind down (snapshot, cleanup) before the next one.
			await streamManager.getStream(streamId)?.streamPromise?.catch(() => {});
			const next = queues.get(chatSessionId)?.shift();
			if (!next) return;
			if (!queues.get(chatSessionId)?.length) queues.delete(chatSessionId);
			broadcastQueue(chatSessionId);
			debug.log('chat', `Starting queued message ${next.id} in session ${chatSessionId}`);
			await startQueued(next);
		} catch (error) {
			debug.error('chat', 'Failed to start queued message:', error);
		} finally {
			draining.delete(chatSessionId);
		}
	})();
});

// Deleting a session drops everything its composer was holding.
streamManager.on('session:cleanup', (chatSessionId: string) => {
	for (const key of drafts.keys()) {
		if (key.startsWith(`${chatSessionId}\u0000`)) drafts.delete(key);
	}
	edits.delete(chatSessionId);
	queues.delete(chatSessionId);
});

// ============================================================================
// Schemas
// ============================================================================

const attachmentSchema = t.Object({
	id: t.String(),
	fileName: t.String(),
	type: t.String(),
	mediaType: t.String(),
	base64: t.String()
});

const engineSchema = t.Object({
	type: t.Union([t.Literal('claude-code'), t.Literal('opencode'), t.Literal('copilot'), t.Literal('codex'), t.Literal('qwen'), t.Literal('pi'), t.Literal('cline'), t.Literal('cursor')]),
	provider: t.String(),
	model: t.Object({ id: t.String(), name: t.String() }),
	account: t.Object({ id: t.Number(), name: t.String() })
});

const editorSchema = t.Object({
	userId: t.String(),
	userName: t.String(),
	messageId: t.String()
});

const queueItemSchema = t.Object({
	id: t.String(),
	userId: t.String(),
	userName: t.String(),
	createdAt: t.String(),
	text: t.String(),
	attachmentCount: t.Number()
});

// ============================================================================
// Router
// ============================================================================

export const composerHandler = createRouter()
	// Everything the composer restores when a session comes on screen.
	.http('chat:composer-state', {
		data: t.Object({
			chatSessionId: t.String()
		}),
		response: t.Object({
			draft: t.Object({
				text: t.String(),
				attachments: t.Array(attachmentSchema),
				textRevision: t.Number(),
				attachmentsRevision: t.Number()
			}),
			edit: t.Union([
				t.Object({ messageId: t.String(), messageTimestamp: t.Union([t.String(), t.Null()]) }),
				t.Null()
			]),
			editors: t.Array(editorSchema),
			queue: t.Array(queueItemSchema)
		})
	}, ({ data, conn }) => {
		requireSessionAccess(conn, data.chatSessionId);
		const userId = ws.getUserId(conn);
		const draft = drafts.get(draftKey(data.chatSessionId, userId));
		const ownEdit = edits.get(data.chatSessionId)?.get(userId);
		return {
			draft: draft ?? { text: '', attachments: [], textRevision: 0, attachmentsRevision: 0 },
			edit: ownEdit ? { messageId: ownEdit.messageId, messageTimestamp: ownEdit.messageTimestamp } : null,
			editors: editorsFor(data.chatSessionId, userId),
			queue: queueView(data.chatSessionId)
		};
	})

	// Save this user's draft. Omitted fields are left as they are, so typing
	// sends text only and attachments travel only when they change. A part is
	// only replaced by a write newer than the one it holds.
	.on('chat:draft-save', {
		data: t.Object({
			chatSessionId: t.String(),
			revision: t.Number(),
			text: t.Optional(t.String()),
			attachments: t.Optional(t.Array(attachmentSchema))
		})
	}, ({ data, conn }) => {
		requireSessionAccess(conn, data.chatSessionId);
		const key = draftKey(data.chatSessionId, ws.getUserId(conn));
		const draft = drafts.get(key) ?? { text: '', attachments: [], textRevision: 0, attachmentsRevision: 0 };
		if (data.text !== undefined && data.revision > draft.textRevision) {
			draft.text = data.text;
			draft.textRevision = data.revision;
		}
		if (data.attachments !== undefined && data.revision > draft.attachmentsRevision) {
			draft.attachments = data.attachments;
			draft.attachmentsRevision = data.revision;
		}
		drafts.set(key, draft);
	})

	// Enter (messageId) or leave (null) edit mode for this user.
	.on('chat:edit-mode', {
		data: t.Object({
			chatSessionId: t.String(),
			messageId: t.Union([t.String(), t.Null()]),
			messageTimestamp: t.Union([t.String(), t.Null()]),
			userName: t.String()
		})
	}, ({ data, conn }) => {
		requireSessionAccess(conn, data.chatSessionId);
		const userId = ws.getUserId(conn);

		if (data.messageId) {
			const message = messageQueries.getById(data.messageId);
			if (!message || message.session_id !== data.chatSessionId) {
				throw new Error('Message not found in this chat session');
			}
			const sessionEdits = edits.get(data.chatSessionId) ?? new Map<string, EditState>();
			sessionEdits.set(userId, {
				messageId: data.messageId,
				messageTimestamp: data.messageTimestamp,
				userName: data.userName
			});
			edits.set(data.chatSessionId, sessionEdits);
		} else {
			const sessionEdits = edits.get(data.chatSessionId);
			sessionEdits?.delete(userId);
			if (sessionEdits && sessionEdits.size === 0) edits.delete(data.chatSessionId);
		}

		ws.emit.chatSession(data.chatSessionId, 'chat:edit-presence', {
			chatSessionId: data.chatSessionId,
			userId,
			userName: data.userName,
			messageId: data.messageId
		});
	})

	// Where submitting an edit rewinds to: the edited message's parent. Resolved
	// here from the database, never carried by the client — a client that lost
	// it (refresh, another device) used to fall back to the very beginning of
	// the session and revert every change the chat had made.
	.http('chat:edit-target', {
		data: t.Object({
			chatSessionId: t.String(),
			messageId: t.String()
		}),
		response: t.Object({
			targetId: t.String()
		})
	}, ({ data, conn }) => {
		requireSessionAccess(conn, data.chatSessionId);
		const message = messageQueries.getById(data.messageId);
		if (!message || message.session_id !== data.chatSessionId) {
			throw new Error('The message being edited no longer exists in this chat session');
		}
		return { targetId: message.parent_message_id || INITIAL_NODE_ID };
	})

	// Send a message while the AI is working: it waits for the turn to finish.
	// If the session went idle in the meantime it simply starts now.
	.on('chat:queue-add', {
		data: t.Object({
			chatSessionId: t.String(),
			projectPath: t.String(),
			prompt: t.Any(),
			engine: engineSchema,
			sender: t.Object({ id: t.String(), name: t.String() }),
			profileId: t.Optional(t.Union([t.Number(), t.Null()])),
			reasoningEffort: t.Optional(t.Union([t.String(), t.Null()]))
		})
	}, async ({ data, conn }) => {
		requireSessionAccess(conn, data.chatSessionId);
		const userId = ws.getUserId(conn);
		const projectId = ws.getProjectId(conn);

		const item: QueuedMessage = {
			id: crypto.randomUUID(),
			userId,
			userName: data.sender.name,
			createdAt: new Date().toISOString(),
			text: promptText(data.prompt),
			attachmentCount: promptAttachmentCount(data.prompt),
			request: {
				projectPath: data.projectPath,
				projectId,
				chatSessionId: data.chatSessionId,
				prompt: data.prompt,
				engine: data.engine,
				sender: data.sender,
				profileId: data.profileId,
				reasoningEffort: data.reasoningEffort,
				requestedByUserId: userId
			}
		};

		if (!isSessionBusy(data.chatSessionId, projectId) && !queues.get(data.chatSessionId)?.length) {
			await startQueued(item);
			return;
		}

		const queue = queues.get(data.chatSessionId) ?? [];
		queue.push(item);
		queues.set(data.chatSessionId, queue);
		broadcastQueue(data.chatSessionId);
	})

	// Drop a queued message. Only its author can.
	.on('chat:queue-remove', {
		data: t.Object({
			chatSessionId: t.String(),
			id: t.String()
		})
	}, ({ data, conn }) => {
		requireSessionAccess(conn, data.chatSessionId);
		const userId = ws.getUserId(conn);
		const queue = queues.get(data.chatSessionId);
		const index = queue?.findIndex((item) => item.id === data.id) ?? -1;
		if (!queue || index === -1) return;
		if (queue[index].userId !== userId) throw new Error('Only the author can remove a queued message');
		queue.splice(index, 1);
		if (queue.length === 0) queues.delete(data.chatSessionId);
		broadcastQueue(data.chatSessionId);
	})

	// Take a queued message back into the composer to change it. Returns its
	// content so nothing has to be retyped.
	.http('chat:queue-take', {
		data: t.Object({
			chatSessionId: t.String(),
			id: t.String()
		}),
		response: t.Union([
			t.Object({
				text: t.String(),
				attachments: t.Array(t.Object({
					type: t.String(),
					mediaType: t.String(),
					data: t.String(),
					fileName: t.String()
				}))
			}),
			t.Null()
		])
	}, ({ data, conn }) => {
		requireSessionAccess(conn, data.chatSessionId);
		const userId = ws.getUserId(conn);
		const queue = queues.get(data.chatSessionId);
		const index = queue?.findIndex((item) => item.id === data.id) ?? -1;
		if (!queue || index === -1) return null;
		if (queue[index].userId !== userId) throw new Error('Only the author can edit a queued message');
		const [item] = queue.splice(index, 1);
		if (queue.length === 0) queues.delete(data.chatSessionId);
		broadcastQueue(data.chatSessionId);

		const content = Array.isArray((item.request.prompt as any)?.content) ? (item.request.prompt as any).content : [];
		const attachments = content
			.filter((block: any) => (block?.type === 'image' || block?.type === 'document') && typeof block.data === 'string')
			.map((block: any, i: number) => ({
				type: block.type === 'image' ? 'image' : (block.mediaType === 'application/pdf' ? 'pdf' : 'document'),
				mediaType: block.mediaType || 'application/octet-stream',
				data: block.data as string,
				fileName: block.title || `attachment-${i + 1}`
			}));
		return { text: item.text, attachments };
	})

	// Send a queued message now. While a turn runs that means "next"; when the
	// session is idle (the queue was paused by a cancel or an error) it starts.
	.on('chat:queue-send-now', {
		data: t.Object({
			chatSessionId: t.String(),
			id: t.String()
		})
	}, async ({ data, conn }) => {
		requireSessionAccess(conn, data.chatSessionId);
		const userId = ws.getUserId(conn);
		const projectId = ws.getProjectId(conn);
		const queue = queues.get(data.chatSessionId);
		const index = queue?.findIndex((item) => item.id === data.id) ?? -1;
		if (!queue || index === -1) return;
		if (queue[index].userId !== userId) throw new Error('Only the author can send a queued message');

		const [item] = queue.splice(index, 1);
		if (isSessionBusy(data.chatSessionId, projectId)) {
			queue.unshift(item);
			broadcastQueue(data.chatSessionId);
			return;
		}
		if (queue.length === 0) queues.delete(data.chatSessionId);
		broadcastQueue(data.chatSessionId);
		await startQueued(item);
	})

	.emit('chat:edit-presence', t.Object({
		chatSessionId: t.String(),
		userId: t.String(),
		userName: t.String(),
		messageId: t.Union([t.String(), t.Null()])
	}))

	.emit('chat:queue', t.Object({
		chatSessionId: t.String(),
		items: t.Array(queueItemSchema)
	}));
