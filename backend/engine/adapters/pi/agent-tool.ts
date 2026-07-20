/**
 * Subagent dispatch tool for Pi.
 *
 * Pi has no native Agent/Task primitive, so the synthetic "Available Subagents"
 * preamble (materialized into AGENTS.md) is informational only — the model can
 * describe subagents but can't invoke them. This custom `Agent` tool closes that
 * gap: calling it spawns a fresh sub-session with the subagent's system prompt,
 * runs the delegated prompt to completion, and returns the final text as the
 * tool result. Sub-activity does not stream to the main UI (it runs inside the
 * tool), but the delegation actually happens.
 */

import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

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

const AGENT_PARAMS = Type.Object({
	subagentType: Type.String(),
	prompt: Type.String(),
	description: Type.Optional(Type.String()),
});

export function createAgentDispatchTool(bindings: AgentDispatchBindings): ToolDefinition {
	const catalog = bindings.subagents.map(s => `- ${s.slug}: ${s.name} — ${s.description}`).join('\n');
	return {
		name: 'Agent',
		label: 'Agent',
		description:
			'Delegate a self-contained subtask to a specialized subagent. Pass the subagent slug as `subagentType` and the task as `prompt`. Available subagents:\n' + catalog,
		parameters: AGENT_PARAMS,
		execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
			const p = params as { subagentType?: string; prompt?: string };
			const match = bindings.subagents.find(s => s.slug === p.subagentType || s.name === p.subagentType);
			if (!match) {
				const names = bindings.subagents.map(s => s.slug).join(', ') || '(none configured)';
				return { content: [{ type: 'text' as const, text: `No subagent named "${p.subagentType}". Available: ${names}` }], details: {} };
			}
			try {
				const text = await bindings.run(match, p.prompt ?? '', _toolCallId, signal);
				return { content: [{ type: 'text' as const, text: text.trim() || '(subagent produced no output)' }], details: {} };
			} catch (error) {
				return { content: [{ type: 'text' as const, text: `Subagent "${match.slug}" failed: ${error instanceof Error ? error.message : String(error)}` }], details: {} };
			}
		},
	} as ToolDefinition;
}
