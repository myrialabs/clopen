/**
 * Sending a message as the owner, from the server — what the assistant does
 * when it hands work to a project session, and what a job does when it runs.
 *
 * Goes through the chat composer exactly like a message typed in the web UI:
 * started now when the session is idle, queued behind the running turn
 * otherwise. The composer lives in the WebSocket layer, which imports this
 * module's neighbours, so it is handed over at load rather than imported.
 */

import type { ChatSession, Project } from '$shared/types/database/schema';
import type { StreamRequest } from '$shared/types/unified';
import { sessionQueries } from '$backend/database/queries';
import { getOwner } from '$backend/auth/auth-service';
import { accountFor, createSession, modelOf, pickModel, type ModelChoice } from '$backend/control/workspace';

export type PromptSubmitter = (input: { request: StreamRequest }) => Promise<{ outcome: 'started' | 'queued'; queueId: string }>;
export type QueuedReplacer = (chatSessionId: string, queueId: string, content: unknown[]) => boolean;

let submitter: PromptSubmitter | null = null;
let replacer: QueuedReplacer | null = null;

export function registerPromptSubmitter(fn: PromptSubmitter, replace?: QueuedReplacer): void {
	submitter = fn;
	if (replace) replacer = replace;
}

/** Prompts waiting behind a busy turn, by the message id they will be saved under. */
const queued = new Map<string, { sessionId: string; queueId: string; attachments: unknown[] }>();

/** Replace the words of a prompt that is still waiting; false when it already ran (or never waited). */
export async function replaceQueuedPrompt(messageId: string, text: string): Promise<boolean> {
	const entry = queued.get(messageId);
	if (!entry || !replacer) return false;
	const done = replacer(entry.sessionId, entry.queueId, [...entry.attachments, { type: 'text', text }]);
	if (done) return true;
	queued.delete(messageId);
	return false;
}

export interface SentPrompt {
	session: ChatSession;
	outcome: 'started' | 'queued';
	promptMessageId: string;
}

/**
 * Send `text` as the next turn of `session`, or of a new session in `project`.
 * A new session uses `model` when given, else the project's latest model, the
 * owner's picked one, then any they used.
 */
export async function sendPromptAsOwner(input: {
	project: Project;
	session: ChatSession | null;
	text: string;
	model?: ModelChoice | null;
	title?: string;
	synthetic?: boolean;
	/** Who a NEW session belongs to; runs are kept out of the owner's chat history. */
	origin?: 'owner' | 'task' | 'flow' | 'system';
	/** Images or documents sent with the text (base64). */
	attachments?: Array<{ type: 'image' | 'document'; mediaType: string; data: string; title: string }>;
	/** The id the saved message takes — the one its row in Clopen's chat already shows. */
	messageId?: string;
}): Promise<SentPrompt> {
	if (!submitter) throw new Error('Clopen is still starting; try again in a moment.');
	const owner = getOwner();
	if (!owner) throw new Error('Clopen has no owner yet; finish setup first.');
	const text = input.text.trim();
	if (!text && !input.attachments?.length) throw new Error('Nothing to send.');

	let session = input.session;
	if (!session) {
		const model = input.model ?? pickModel(owner.id, input.project.id);
		if (!model) throw new Error('No AI model is set up yet. Connect an agent in Settings → Agents first.');
		session = createSession(input.project, model);
		if (input.title) sessionQueries.updateTitle(session.id, input.title);
		if (input.origin && input.origin !== 'owner') sessionQueries.setOrigin(session.id, input.origin);
	}
	const model = modelOf(session) ?? input.model ?? pickModel(owner.id, input.project.id);
	if (!model) throw new Error('No AI model is set up yet. Connect an agent in Settings → Agents first.');

	const account = accountFor(session, model);
	const engine = {
		type: model.engine,
		provider: model.provider,
		model: { id: model.modelId, name: model.modelName },
		account: account ?? { id: 0, name: '' }
	};
	const promptMessageId = input.messageId ?? crypto.randomUUID();
	const request: StreamRequest = {
		projectPath: input.project.path,
		projectId: input.project.id,
		chatSessionId: session.id,
		prompt: {
			type: 'user',
			createdAt: new Date().toISOString(),
			messageId: promptMessageId,
			sessionId: session.id,
			parent: { messageId: null, sessionId: null, toolUseId: null },
			engine,
			content: [
				...(input.attachments ?? []).map((file) =>
					file.type === 'image'
						? { type: 'image' as const, mediaType: file.mediaType, data: file.data, title: file.title }
						: { type: 'document' as const, mediaType: file.mediaType, data: file.data, title: file.title }
				),
				...(text ? [{ type: 'text' as const, text }] : [])
			],
			synthetic: input.synthetic ?? false
		} as StreamRequest['prompt'],
		engine: engine as StreamRequest['engine'],
		profileId: session.profile_id ?? null,
		reasoningEffort: session.reasoning_effort ?? null,
		requestedByUserId: owner.id
	};

	const { outcome, queueId } = await submitter({ request });
	if (outcome === 'queued') {
		const content = (request.prompt as { content: unknown[] }).content;
		queued.set(promptMessageId, { sessionId: session.id, queueId, attachments: content.filter((block) => (block as { type?: string }).type !== 'text') });
		if (queued.size > 200) queued.delete(queued.keys().next().value!);
	}
	return { session: sessionQueries.getById(session.id) ?? session, outcome, promptMessageId };
}

export type { ModelChoice };
