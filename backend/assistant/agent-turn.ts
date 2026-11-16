/**
 * One turn of an agent, awaited — the `do` step of a recipe.
 *
 * Sends a prompt the way the owner would (through the chat composer, so the
 * turn is visible, stoppable and restorable like any other) and resolves when
 * THAT turn ends — matched by its prompt id, so a turn that was queued behind
 * another resolves with its own answer, not the one ahead of it. The cost the
 * engine reported for the turn is collected on the way.
 */

import { streamManager } from '$backend/chat/stream-manager';
import { lastTurnAnswer } from '$backend/chat/turn-answer';
import type { ChatSession, Project } from '$shared/types/database/schema';
import type { StreamEvent } from '$shared/types/unified';
import { debug } from '$shared/utils/logger';
import { sendPromptAsOwner, type ModelChoice } from './prompt';
import { fallbackModel, isModelTrouble } from './fallback';

export interface TurnResult {
	sessionId: string;
	status: 'completed' | 'error' | 'cancelled';
	text: string;
	error: string | null;
	costUsd: number;
}

interface Waiter {
	promptMessageId: string;
	resolve: (result: TurnResult) => void;
	costUsd: number;
}

const waiters = new Map<string, Waiter[]>();
let wired = false;

function wire(): void {
	if (wired) return;
	wired = true;
	streamManager.on('stream:message', (payload: { event: StreamEvent; chatSessionId: string }) => {
		const event = payload.event as unknown as { type?: string; totalCostUsd?: number };
		if (event?.type !== 'result' || typeof event.totalCostUsd !== 'number') return;
		const list = waiters.get(payload.chatSessionId);
		if (list?.[0]) list[0].costUsd += event.totalCostUsd;
	});
	streamManager.on('stream:lifecycle', (event: { status: 'completed' | 'error' | 'cancelled'; chatSessionId?: string; reason?: string }) => {
		if (!event.chatSessionId) return;
		const list = waiters.get(event.chatSessionId);
		if (!list?.length) return;
		try {
			const answer = lastTurnAnswer(event.chatSessionId);
			const index = list.findIndex((waiter) => waiter.promptMessageId === answer.userMessageId);
			// The turn that ended is not one we wait for (an earlier queued turn): keep waiting.
			if (index < 0 && event.status === 'completed') return;
			const waiter = list.splice(index < 0 ? 0 : index, 1)[0];
			if (!list.length) waiters.delete(event.chatSessionId);
			waiter.resolve({
				sessionId: event.chatSessionId,
				status: event.status,
				text: answer.text,
				error: event.status === 'error' ? answer.error ?? event.reason ?? 'The turn failed.' : event.status === 'cancelled' ? 'Stopped.' : null,
				costUsd: waiter.costUsd
			});
		} catch (error) {
			debug.warn('assistant', 'Settling an awaited turn failed:', error);
		}
	});
}

/** Send `text` and wait for the agent's answer — once more on another model if this one is unavailable. */
export async function runAgentTurn(input: {
	project: Project;
	session: ChatSession | null;
	text: string;
	title: string;
	model?: ModelChoice | null;
	origin: 'task' | 'flow' | 'system';
	onSession?: (sessionId: string) => void;
}): Promise<TurnResult> {
	const first = await sendAndWait(input);
	if (first.status !== 'error' || !isModelTrouble(first.error)) return first;
	const { sessionQueries } = await import('$backend/database/queries');
	const session = sessionQueries.getById(first.sessionId);
	const model = await fallbackModel(session);
	if (!session || !model) return first;
	sessionQueries.updateEngineModel(session.id, model.engine, model.provider, model.modelId, model.modelName);
	sessionQueries.updateAccount(session.id, null, null);
	const second = await sendAndWait({ ...input, session: sessionQueries.getById(session.id), model: null });
	return { ...second, costUsd: second.costUsd + first.costUsd };
}

async function sendAndWait(input: {
	project: Project;
	session: ChatSession | null;
	text: string;
	title: string;
	model?: ModelChoice | null;
	origin: 'task' | 'flow' | 'system';
	onSession?: (sessionId: string) => void;
}): Promise<TurnResult> {
	wire();
	const sent = await sendPromptAsOwner({
		project: input.project,
		session: input.session,
		text: input.text,
		model: input.model,
		title: input.title,
		origin: input.origin
	});
	input.onSession?.(sent.session.id);
	return new Promise<TurnResult>((resolve) => {
		const list = waiters.get(sent.session.id) ?? [];
		list.push({ promptMessageId: sent.promptMessageId, resolve, costUsd: 0 });
		waiters.set(sent.session.id, list);
	});
}

/** Stop waiting on everything for a session (it was deleted). */
export function abandonTurns(sessionId: string): void {
	for (const waiter of waiters.get(sessionId) ?? []) {
		waiter.resolve({ sessionId, status: 'cancelled', text: '', error: 'The chat was removed.', costUsd: waiter.costUsd });
	}
	waiters.delete(sessionId);
}
