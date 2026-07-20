/**
 * Subagent dispatch tool for Cline.
 *
 * Cline's stateless `Agent` has no native Agent/Task primitive, so the synthetic
 * "Available Subagents" preamble (injected into the system prompt) is
 * informational only — the model can describe subagents but can't invoke them.
 * This custom `Agent` tool closes that gap: calling it spawns a fresh sub-`Agent`
 * with the subagent's system prompt, runs the delegated prompt to completion, and
 * returns the final text as the tool result. Sub-activity does not stream to the
 * main UI (it runs inside the tool), but the delegation actually happens.
 */

import { createTool } from '@cline/sdk';
import type { AgentTool, AgentToolContext } from '@cline/sdk';

export interface SubagentInfo {
	slug: string;
	name: string;
	description: string;
}

export interface AgentDispatchBindings {
	/** Enabled subagents advertised to the model. */
	subagents: SubagentInfo[];
	/**
	 * Run one subagent against a prompt; resolve with its final text output.
	 * `toolCallId` is the parent Agent tool_use id — the runner tags the
	 * subagent's messages with it so they render as sub-activities.
	 */
	run: (subagent: SubagentInfo, prompt: string, toolCallId: string, signal?: AbortSignal) => Promise<string>;
}

const AGENT_INPUT_SCHEMA = {
	type: 'object',
	properties: {
		subagentType: { type: 'string', description: 'The slug of the subagent to delegate to.' },
		prompt: { type: 'string', description: 'The self-contained task for the subagent.' },
		description: { type: 'string', description: 'A short description of the delegated task.' },
	},
	required: ['subagentType', 'prompt'],
} as const;

export function createAgentDispatchTool(bindings: AgentDispatchBindings): AgentTool {
	const catalog = bindings.subagents.map(s => `- ${s.slug}: ${s.name} — ${s.description}`).join('\n');
	return createTool({
		name: 'Agent',
		description:
			'Delegate a self-contained subtask to a specialized subagent. Pass the subagent slug as `subagentType` and the task as `prompt`. Available subagents:\n' + catalog,
		inputSchema: AGENT_INPUT_SCHEMA,
		async execute(input: { subagentType?: string; prompt?: string }, context: AgentToolContext) {
			const match = bindings.subagents.find(s => s.slug === input.subagentType || s.name === input.subagentType);
			if (!match) {
				const names = bindings.subagents.map(s => s.slug).join(', ') || '(none configured)';
				return `No subagent named "${input.subagentType}". Available: ${names}`;
			}
			try {
				const text = await bindings.run(match, input.prompt ?? '', context.toolCallId ?? '', context.signal);
				return text.trim() || '(subagent produced no output)';
			} catch (error) {
				return `Subagent "${match.slug}" failed: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	}) as AgentTool;
}
