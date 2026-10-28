/**
 * Chat Composer State
 *
 * Everything about the message box that outlives a page load, per chat session:
 *
 * - The draft: text and attachments typed in a session wait on any device.
 * - Edit mode: which message is being edited, restored with the session.
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
import { registerComposer } from '../../chat-apps';

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
}

interface QueuedMessage {
	id: string;
	createdAt: string;
	text: string;
	attachmentCount: number;
	request: StreamRequest;
}

/** chatSessionId → its draft. */
const drafts = new Map<string, Draft>();
/** chatSessionId → the message being edited. */
const edits = new Map<string, EditState>();
/** chatSessionId → messages waiting for the current turn to finish, in order. */
const queues = new Map<string, QueuedMessage[]>();
/** Sessions whose next queued message is being started right now. */
const draining = new Set<string>();

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

function queueView(chatSessionId: string) {
	return (queues.get(chatSessionId) ?? []).map((item) => ({
		id: item.id,
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

/**
 * Send a message the way the composer does: start it now if the session is
 * idle and nothing is queued ahead of it, otherwise queue it behind the turn.
 * Shared by `chat:queue-add` and anything server-side that sends on the
 * owner's behalf — a reply from a chat app arrives with no tab open at all.
 */
export async function submitPrompt(input: {
	request: StreamRequest;
}): Promise<{ outcome: 'started' | 'queued'; queueId: string }> {
	const { chatSessionId, projectId } = input.request;
	const item: QueuedMessage = {
		id: crypto.randomUUID(),
		createdAt: new Date().toISOString(),
		text: promptText(input.request.prompt),
		attachmentCount: promptAttachmentCount(input.request.prompt),
		request: input.request
	};

	if (!isSessionBusy(chatSessionId, projectId) && !queues.get(chatSessionId)?.length) {
		await startQueued(item);
		return { outcome: 'started', queueId: item.id };
	}

	const queue = queues.get(chatSessionId) ?? [];
	queue.push(item);
	queues.set(chatSessionId, queue);
	broadcastQueue(chatSessionId);
	return { outcome: 'queued', queueId: item.id };
}

/**
 * Replace the content of a message still waiting in the queue — editing it
 * before it ran. Returns false when it already started (or was dropped).
 */
export function replaceQueuedPrompt(chatSessionId: string, queueId: string, content: unknown[]): boolean {
	const item = queues.get(chatSessionId)?.find((entry) => entry.id === queueId);
	if (!item) return false;
	item.request = { ...item.request, prompt: { ...item.request.prompt, content } as StreamRequest['prompt'] };
	item.text = promptText(item.request.prompt);
	item.attachmentCount = promptAttachmentCount(item.request.prompt);
	broadcastQueue(chatSessionId);
	return true;
}

registerComposer({ submit: submitPrompt, replaceQueued: replaceQueuedPrompt });

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
	drafts.delete(chatSessionId);
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

const queueItemSchema = t.Object({
	id: t.String(),
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
			queue: t.Array(queueItemSchema)
		})
	}, ({ data }) => {
		requireSessionAccess(data.chatSessionId);
		const draft = drafts.get(data.chatSessionId);
		const edit = edits.get(data.chatSessionId);
		return {
			draft: draft ?? { text: '', attachments: [], textRevision: 0, attachmentsRevision: 0 },
			edit: edit ? { messageId: edit.messageId, messageTimestamp: edit.messageTimestamp } : null,
			queue: queueView(data.chatSessionId)
		};
	})

	// Save the draft. Omitted fields are left as they are, so typing
	// sends text only and attachments travel only when they change. A part is
	// only replaced by a write newer than the one it holds.
	.on('chat:draft-save', {
		data: t.Object({
			chatSessionId: t.String(),
			revision: t.Number(),
			text: t.Optional(t.String()),
			attachments: t.Optional(t.Array(attachmentSchema))
		})
	}, ({ data }) => {
		requireSessionAccess(data.chatSessionId);
		const draft = drafts.get(data.chatSessionId) ?? { text: '', attachments: [], textRevision: 0, attachmentsRevision: 0 };
		if (data.text !== undefined && data.revision > draft.textRevision) {
			draft.text = data.text;
			draft.textRevision = data.revision;
		}
		if (data.attachments !== undefined && data.revision > draft.attachmentsRevision) {
			draft.attachments = data.attachments;
			draft.attachmentsRevision = data.revision;
		}
		drafts.set(data.chatSessionId, draft);
	})

	// Enter (messageId) or leave (null) edit mode.
	.on('chat:edit-mode', {
		data: t.Object({
			chatSessionId: t.String(),
			messageId: t.Union([t.String(), t.Null()]),
			messageTimestamp: t.Union([t.String(), t.Null()])
		})
	}, ({ data }) => {
		requireSessionAccess(data.chatSessionId);

		if (data.messageId) {
			const message = messageQueries.getById(data.messageId);
			if (!message || message.session_id !== data.chatSessionId) {
				throw new Error('Message not found in this chat session');
			}
			edits.set(data.chatSessionId, {
				messageId: data.messageId,
				messageTimestamp: data.messageTimestamp
			});
		} else {
			edits.delete(data.chatSessionId);
		}
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
	}, ({ data }) => {
		requireSessionAccess(data.chatSessionId);
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
			profileId: t.Optional(t.Union([t.Number(), t.Null()])),
			reasoningEffort: t.Optional(t.Union([t.String(), t.Null()]))
		})
	}, async ({ data, conn }) => {
		requireSessionAccess(data.chatSessionId);
		const userId = ws.getUserId(conn);
		const projectId = ws.getProjectId(conn);

		await submitPrompt({
			request: {
				projectPath: data.projectPath,
				projectId,
				chatSessionId: data.chatSessionId,
				prompt: data.prompt,
				engine: data.engine,
				profileId: data.profileId,
				reasoningEffort: data.reasoningEffort,
				requestedByUserId: userId
			}
		});
	})

	// Drop a queued message.
	.on('chat:queue-remove', {
		data: t.Object({
			chatSessionId: t.String(),
			id: t.String()
		})
	}, ({ data }) => {
		requireSessionAccess(data.chatSessionId);
		const queue = queues.get(data.chatSessionId);
		const index = queue?.findIndex((item) => item.id === data.id) ?? -1;
		if (!queue || index === -1) return;
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
	}, ({ data }) => {
		requireSessionAccess(data.chatSessionId);
		const queue = queues.get(data.chatSessionId);
		const index = queue?.findIndex((item) => item.id === data.id) ?? -1;
		if (!queue || index === -1) return null;
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
		requireSessionAccess(data.chatSessionId);
		const projectId = ws.getProjectId(conn);
		const queue = queues.get(data.chatSessionId);
		const index = queue?.findIndex((item) => item.id === data.id) ?? -1;
		if (!queue || index === -1) return;

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

	.emit('chat:queue', t.Object({
		chatSessionId: t.String(),
		items: t.Array(queueItemSchema)
	}));
