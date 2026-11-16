/**
 * Clopen is the owner's assistant by construction, never a project worker.
 *
 * Usage showed that when the agent in Clopen's chat can write files, it does —
 * the coding agent's own system prompt wins over the brief, and "build me a
 * web app" ends up as files in Clopen's data folder instead of a project. So
 * in that chat the engine's own file-writing, shell and sub-agent tools are
 * withheld, per engine, through the same runtime permission check every
 * adapter already applies, and the `control` server registers no action that
 * changes a project. What stays: reading, browsing, connected services, and
 * `terminal.run` confined to Clopen's scratch folder for one-off jobs.
 * Project work goes through `delegate`, whose crews build and test it.
 */

import { projectQueries } from '$backend/database/queries';
import type { EngineType } from '$shared/types/unified';

export const ASSISTANT_DENIED_TOOLS: Record<EngineType, string[]> = {
	'claude-code': ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task'],
	opencode: ['write', 'edit', 'patch', 'bash', 'task'],
	copilot: ['shell', 'write'],
	codex: ['shell', 'apply_patch'],
	qwen: ['run_shell_command', 'write_file', 'edit', 'replace'],
	pi: ['bash', 'edit', 'write'],
	cline: ['run_commands', 'apply_patch', 'editor'],
	cursor: ['shell', 'edit', 'delete', 'applyAgentDiff', 'task']
};

/** Whether this project is Clopen's own workspace (kind `home`). */
export function isAssistantProjectId(projectId: string | null | undefined): boolean {
	if (!projectId) return false;
	try {
		return projectQueries.getById(projectId)?.kind === 'home';
	} catch {
		return false;
	}
}

/**
 * A few lines for engines that take a system prompt (Claude Code's `append`):
 * the role, said where the model gives it the most weight. The full brief
 * still rides in the user turn.
 */
export const ASSISTANT_SYSTEM_APPEND = [
	'You are Clopen, the owner\'s assistant, not a worker on their projects: you cannot write files or run a shell here.',
	'Do one-off things yourself with the Clopen tools (browse, send, remind, connect, ask, status, connected services, and run). Project work goes to delegate — its agents build and test it; you never verify it.',
	'Reply like a person in a fast chat: one or two short sentences, no headings or lists, unless the owner asks for detail.'
].join('\n');
