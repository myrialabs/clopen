/**
 * AskUserQuestion custom tool for Pi.
 *
 * Pi's native `ask_question` tool has no headless answer path (it drives the
 * TUI). We exclude it and register our own canonical `AskUserQuestion` tool that
 * BLOCKS until the user answers through the chat UI — the same contract Claude's
 * `canUseTool` provides, but modelled as a tool because Pi's block hook can't
 * hold the model waiting.
 *
 * The tool's `execute` returns a promise the engine resolves via
 * `resolveUserAnswer(toolCallId, answers)`. The converter renders the tool_use
 * block (name `AskUserQuestion`) so the frontend shows the dialog; the resolved
 * tool result carries the formatted answers.
 */

import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AskUserQuestion } from '$shared/types/unified';

export interface PendingAsk {
	questions: AskUserQuestion[];
	resolve: (result: AgentToolResult<unknown>) => void;
}

export interface AskToolBindings {
	register: (toolCallId: string, entry: PendingAsk) => void;
	unregister: (toolCallId: string) => void;
}

/** Format the user's answers in the shared OpenCode/Qwen wording. */
export function formatAnswers(questions: AskUserQuestion[], answers: Record<string, string>): string {
	const pairs: string[] = [];
	for (const [key, value] of Object.entries(answers)) {
		const idx = Number.parseInt(key, 10);
		const q = Number.isFinite(idx) ? questions[idx] : undefined;
		const label = q?.question ?? q?.header ?? key;
		pairs.push(`"${label}"="${value}"`);
	}
	if (pairs.length === 0) return 'User did not provide any answers.';
	return `User has answered your questions: ${pairs.join(', ')}. You can now continue with the user's answers in mind.`;
}

function cancelledResult(): AgentToolResult<unknown> {
	return { content: [{ type: 'text', text: 'User did not answer the question.' }], details: {} };
}

const ASK_PARAMS = Type.Object({
	questions: Type.Array(
		Type.Object({
			question: Type.String(),
			header: Type.String(),
			multiSelect: Type.Boolean(),
			options: Type.Array(
				Type.Object({
					label: Type.String(),
					description: Type.String(),
				}),
			),
		}),
	),
});

export function createAskUserQuestionTool(bindings: AskToolBindings): ToolDefinition {
	return {
		name: 'AskUserQuestion',
		label: 'Ask User Question',
		description:
			'Ask the user one or more multiple-choice questions when you need a decision only they can make. Blocks until the user answers in the UI.',
		parameters: ASK_PARAMS,
		execute: async (toolCallId: string, params: unknown, signal?: AbortSignal) => {
			const questions = ((params as { questions?: AskUserQuestion[] })?.questions ?? []) as AskUserQuestion[];
			return new Promise<AgentToolResult<unknown>>((resolve) => {
				if (signal?.aborted) {
					resolve(cancelledResult());
					return;
				}
				const onAbort = () => {
					bindings.unregister(toolCallId);
					resolve(cancelledResult());
				};
				signal?.addEventListener('abort', onAbort, { once: true });
				bindings.register(toolCallId, {
					questions,
					resolve: (result) => {
						signal?.removeEventListener('abort', onAbort);
						resolve(result);
					},
				});
			});
		},
	} as ToolDefinition;
}
