/**
 * When a model fails, Clopen carries on with another one.
 *
 * Free models in particular hit rate limits, run out of quota or disappear.
 * Usage showed whole chats that ended after one message with no answer. When
 * a turn in Clopen's own chat (or a crew/flow step) fails that way, the same
 * message is sent again once on a fallback model — the free default when the
 * failing one was something else, otherwise the owner's Background model — and
 * the owner is told in one line.
 */

import { sessionQueries, projectQueries } from '$backend/database/queries';
import { streamManager } from '$backend/chat/stream-manager';
import { lastTurnAnswer, userMessageText } from '$backend/chat/turn-answer';
import { isAssistantProject } from '$shared/utils/assistant-project';
import { debug } from '$shared/utils/logger';
import type { ModelChoice } from '$backend/control/workspace';
import { freeAssistantModel, getModelChoice } from './model';
import { sendPromptAsOwner } from './prompt';

const MODEL_TROUBLE = /\b(429|rate.?limit|quota|insufficient|credit|overloaded|capacity|unavailable|not (?:found|available|supported)|no such model|model.*(?:does not exist|deprecated)|503|502|timed? ?out)\b/i;

/** Retried prompts, so a fallback that fails too is not retried forever. */
const retried = new Set<string>();

export function isModelTrouble(error: string | null | undefined): boolean {
	return Boolean(error && MODEL_TROUBLE.test(error));
}

/** A different model to try: the free default, or the Background model. */
export async function fallbackModel(current: { engine?: string; model_id?: string } | null): Promise<ModelChoice | null> {
	const candidates = [await freeAssistantModel(), getModelChoice('background'), getModelChoice('assistant')].filter(Boolean) as ModelChoice[];
	return candidates.find((model) => model.modelId !== current?.model_id) ?? null;
}

export function initModelFallback(): void {
	streamManager.on('stream:lifecycle', (event: { status: 'completed' | 'error' | 'cancelled'; projectId?: string; chatSessionId?: string; reason?: string }) => {
		if (event.status !== 'error' || !event.chatSessionId || !event.projectId) return;
		void (async () => {
			const project = projectQueries.getById(event.projectId!);
			const session = sessionQueries.getById(event.chatSessionId!);
			if (!project || !session || !isAssistantProject(project)) return;
			const answer = lastTurnAnswer(session.id);
			if (!isModelTrouble(answer.error ?? event.reason) || !answer.userMessageId || retried.has(answer.userMessageId)) return;
			const text = userMessageText(answer.userMessageId);
			const model = await fallbackModel(session);
			if (!text || !model) return;
			retried.add(answer.userMessageId);
			sessionQueries.updateEngineModel(session.id, model.engine, model.provider, model.modelId, model.modelName);
			sessionQueries.updateAccount(session.id, null, null);
			debug.log('assistant', `Model trouble in ${session.id}; retrying on ${model.engine}/${model.modelId}`);
			const sent = await sendPromptAsOwner({
				project,
				session: sessionQueries.getById(session.id),
				text: `[Clopen · ${session.model_name ?? session.model_id ?? 'The model'} was unavailable, so this runs on ${model.modelName}. Mention that in a few words.]\n\n${text}`,
				synthetic: true
			});
			retried.add(sent.promptMessageId);
		})().catch((error) => debug.warn('assistant', 'Falling back to another model failed:', error));
	});
}
