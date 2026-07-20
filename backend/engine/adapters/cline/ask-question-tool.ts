/**
 * AskUserQuestion custom tool for Cline.
 *
 * Cline's built-in `ask_question` drives its own UI and has no headless answer
 * path, so we disable it (`enableAskQuestion: false`) and register our own
 * canonical `AskUserQuestion` tool that BLOCKS until the user answers through the
 * chat UI — the same contract Claude's `canUseTool` provides, modelled as a
 * blocking tool because the stateless `Agent` loop resolves a tool call by its
 * returned promise.
 *
 * The tool's `execute` returns a promise the engine resolves via
 * `resolveUserAnswer(toolCallId, answers)`. The converter renders the tool_use
 * block (name `AskUserQuestion`) so the frontend shows the dialog; the resolved
 * tool result carries the formatted answers.
 */

import { createTool } from '@cline/sdk';
import type { AgentTool, AgentToolContext } from '@cline/sdk';
import type { AskUserQuestion } from '$shared/types/unified';

export interface PendingAsk {
	questions: AskUserQuestion[];
	resolve: (text: string) => void;
}

export interface AskToolBindings {
	register: (toolCallId: string, entry: PendingAsk) => void;
	unregister: (toolCallId: string) => void;
}

/** Format the user's answers in the shared OpenCode/Qwen/Pi wording. */
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

const ASK_INPUT_SCHEMA = {
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
} as const;

export function createAskUserQuestionTool(bindings: AskToolBindings): AgentTool {
	return createTool({
		name: 'AskUserQuestion',
		description:
			'Ask the user one or more multiple-choice questions when you need a decision only they can make. Blocks until the user answers in the UI.',
		inputSchema: ASK_INPUT_SCHEMA,
		async execute(input: { questions?: AskUserQuestion[] }, context: AgentToolContext) {
			const questions = (input?.questions ?? []) as AskUserQuestion[];
			const toolCallId = context.toolCallId ?? '';
			const signal = context.signal;
			return new Promise<string>((resolve) => {
				if (!toolCallId || signal?.aborted) {
					resolve('User did not answer the question.');
					return;
				}
				const onAbort = () => {
					bindings.unregister(toolCallId);
					resolve('User did not answer the question.');
				};
				signal?.addEventListener('abort', onAbort, { once: true });
				bindings.register(toolCallId, {
					questions,
					resolve: (text) => {
						signal?.removeEventListener('abort', onAbort);
						resolve(text);
					},
				});
			});
		},
	}) as AgentTool;
}
