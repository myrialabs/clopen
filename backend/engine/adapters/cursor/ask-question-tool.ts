/**
 * AskUserQuestion custom tool for Cursor.
 *
 * Cursor exposes in-process callback tools via `local.customTools` (surfaced to
 * the model as the `custom-user-tools` MCP server). We register a canonical
 * `AskUserQuestion` tool whose `execute` BLOCKS until the user answers through the
 * chat UI — the same contract Claude's `canUseTool` / Cline's custom ask tool
 * provide.
 *
 * The Cursor custom-tool context carries no abort signal, so a parked question is
 * released either by `resolveUserAnswer(toolCallId, answers)` (the user answered)
 * or by the engine's `cancel()` sweep over `pendingAsks`.
 */

import type { SDKCustomTool, SDKJsonValue } from '@cursor/sdk';
import type { AskUserQuestion } from '$shared/types/unified';

export interface PendingAsk {
	questions: AskUserQuestion[];
	resolve: (text: string) => void;
}

export interface AskToolBindings {
	register: (toolCallId: string, entry: PendingAsk) => void;
	unregister: (toolCallId: string) => void;
	/**
	 * Surface the AskUserQuestion tool_use into the stream with the COMPLETE
	 * questions. Sourced from `execute`'s args (always fully populated) rather
	 * than the stream's `tool_call` args, which can arrive empty/partial for large
	 * question sets — the bug behind `questions: []` in the UI.
	 */
	emit: (toolCallId: string, questions: AskUserQuestion[]) => void;
}

/** Format the user's answers in the shared OpenCode/Qwen/Pi/Cline wording. */
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

const ASK_INPUT_SCHEMA: Record<string, SDKJsonValue> = {
	type: 'object',
	properties: {
		questions: {
			type: 'array',
			description: 'One or more multiple-choice questions to ask the user.',
			items: {
				type: 'object',
				properties: {
					question: { type: 'string', description: 'The full question text.' },
					header: { type: 'string', description: 'A short (max 12 char) label for the question.' },
					multiSelect: { type: 'boolean', description: 'Whether multiple options may be selected.' },
					options: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								label: { type: 'string' },
								description: { type: 'string' },
							},
							required: ['label', 'description'],
						},
					},
				},
				required: ['question', 'header', 'options'],
			},
		},
	},
	required: ['questions'],
};

export function createAskUserQuestionTool(bindings: AskToolBindings): SDKCustomTool {
	return {
		description:
			'Ask the user one or more multiple-choice questions when you need a decision only they can make. Blocks until the user answers in the UI.',
		inputSchema: ASK_INPUT_SCHEMA,
		execute(args, context) {
			const questions = (Array.isArray(args?.questions) ? args.questions : []) as unknown as AskUserQuestion[];
			const toolCallId = context.toolCallId ?? '';
			return new Promise<string>((resolve) => {
				if (!toolCallId) {
					resolve('User did not answer the question.');
					return;
				}
				// Emit the tool_use with the complete questions from THIS call's args.
				bindings.emit(toolCallId, questions);
				bindings.register(toolCallId, { questions, resolve });
			});
		},
	};
}
