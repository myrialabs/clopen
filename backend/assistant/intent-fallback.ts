/**
 * Intent mode — for models that cannot call tools reliably.
 *
 * The brief tells Clopen's model: if a tool keeps failing, write the steps in
 * a ```clopen block holding JSON — `[{ "action": "flow.create", "args": {…} }]`
 * (or a single step). When a turn in Clopen's chat ends with such a block,
 * Clopen runs it through the same control surface (same risk rules, same
 * audit) and hands the result back to the chat in one follow-up turn, so the
 * model can tell the owner what happened. A model that writes JSON but stumbles
 * over tool-calling protocols still gets the work done.
 */

import { projectQueries } from '$backend/database/queries';
import { streamManager } from '$backend/chat/stream-manager';
import { lastTurnAnswer, userMessageText } from '$backend/chat/turn-answer';
import { runAgentBatch } from '$backend/control/agent';
import { isAssistantProject } from '$shared/utils/assistant-project';
import { debug } from '$shared/utils/logger';
import { sendPromptAsOwner } from './prompt';

const FENCE = /```clopen\s*\n([\s\S]*?)```/g;
const RESULT_MARK = '[Clopen · ran your steps]';

export function extractIntentSteps(text: string): Array<{ action: string; args?: Record<string, unknown>; as?: string }> {
	const steps: Array<{ action: string; args?: Record<string, unknown>; as?: string }> = [];
	for (const match of text.matchAll(FENCE)) {
		try {
			const parsed = JSON.parse(match[1].trim()) as unknown;
			const list = Array.isArray(parsed) ? parsed : [parsed];
			for (const item of list) {
				if (item && typeof item === 'object' && typeof (item as { action?: unknown }).action === 'string') {
					steps.push(item as { action: string; args?: Record<string, unknown> });
				}
			}
		} catch {
			// Not JSON: ignore the block.
		}
	}
	return steps.slice(0, 20);
}

export function initIntentFallback(): void {
	streamManager.on('stream:lifecycle', (event: { status: 'completed' | 'error' | 'cancelled'; projectId?: string; chatSessionId?: string }) => {
		if (event.status !== 'completed' || !event.chatSessionId || !event.projectId) return;
		void (async () => {
			const project = projectQueries.getById(event.projectId!);
			if (!project || !isAssistantProject(project)) return;
			const answer = lastTurnAnswer(event.chatSessionId!);
			const steps = extractIntentSteps(answer.text);
			if (!steps.length) return;
			// Never answer our own follow-up with another round.
			const asked = answer.userMessageId ? userMessageText(answer.userMessageId) : null;
			if (asked?.startsWith(RESULT_MARK)) return;
			const reports = await runAgentBatch({ sessionId: event.chatSessionId!, projectId: event.projectId! }, steps, 'continue');
			const summary = reports.map((report) => `- ${report.action}: ${report.status} — ${report.text.split('\n')[0].slice(0, 300)}`).join('\n');
			const { sessionQueries } = await import('$backend/database/queries');
			const session = sessionQueries.getById(event.chatSessionId!);
			if (!session) return;
			await sendPromptAsOwner({
				project,
				session,
				text: `${RESULT_MARK}\n${summary}\n\nTell the owner the outcome in one short sentence.`,
				synthetic: true
			});
		})().catch((error) => debug.warn('assistant', 'Running intent steps failed:', error));
	});
}
