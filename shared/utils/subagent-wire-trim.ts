/**
 * Sub-agent (Task) wire payload trimming.
 *
 * Messages produced INSIDE a sub-agent (Task) run carry `parent.toolUseId` and
 * are folded into the parent Agent tool's collapsed `subActivities` in the UI.
 * That collapsed view only ever renders a tool_use's NAME plus one short brief
 * field, and any text — it never renders sub-agent tool_result content, nor any
 * non-brief tool_use input field. Those are pure dead weight on the wire and
 * are typically the bulk of a heavy session's payload (file dumps, command
 * output, Write/Edit bodies).
 *
 * `trimSubAgentForWire` strips that dead weight from anything SENT to the
 * frontend (message read responses + live stream broadcast + catch-up buffer).
 * The DB copy is never touched, so resume, branching/undo, interrupt detection,
 * and the raw DebugModal (via `messages:get`) all keep the full data.
 */

import type { UnifiedMessage } from '$shared/types/unified';

/**
 * The single input field the collapsed sub-agent view shows per tool.
 *
 * MUST stay in sync with `getToolBrief()` in the AgentTool variants
 * (frontend/components/chat/tools/variants/{classic,compact}/AgentTool.svelte).
 * Tools not listed show no brief, so their input is dropped entirely.
 *
 * Keys are unified camelCase (engines normalise snake_case → camelCase before
 * persistence), so this mapping is engine-agnostic.
 */
const SUBAGENT_BRIEF_FIELD: Record<string, string> = {
	Bash: 'command',
	Read: 'filePath',
	Write: 'filePath',
	Edit: 'filePath',
	Glob: 'pattern',
	Grep: 'pattern',
	WebFetch: 'url',
	WebSearch: 'query',
};

/** Whether a message was produced inside a sub-agent (Task) run. */
function isSubAgentMessage(msg: UnifiedMessage): boolean {
	return msg.parent?.toolUseId != null;
}

/**
 * Return a wire-trimmed copy of a message. Non-sub-agent messages are returned
 * by reference (unchanged). Sub-agent messages get a shallow copy with:
 *  - tool_result blocks: `content` emptied. The block, `toolUseId` and `isError`
 *    are kept so live waiting-input handling and interrupt detection — which key
 *    off the block's presence/toolUseId — behave exactly as before.
 *  - tool_use blocks: `input` reduced to the one displayed brief field (or `{}`
 *    for tools with no brief).
 */
export function trimSubAgentForWire(msg: UnifiedMessage): UnifiedMessage {
	if (!isSubAgentMessage(msg)) return msg;

	if (msg.type === 'user') {
		let changed = false;
		const content = msg.content.map(block => {
			if (block.type === 'tool_result' && block.content !== '') {
				changed = true;
				return { ...block, content: '' };
			}
			return block;
		});
		return changed ? { ...msg, content } : msg;
	}

	if (msg.type === 'assistant') {
		let changed = false;
		const content = msg.content.map(block => {
			if (block.type !== 'tool_use') return block;
			const briefField = SUBAGENT_BRIEF_FIELD[block.name];
			const input = block.input as Record<string, unknown>;
			const trimmed =
				briefField && input && briefField in input
					? { [briefField]: input[briefField] }
					: {};
			changed = true;
			return { ...block, input: trimmed } as typeof block;
		});
		return changed ? ({ ...msg, content } as UnifiedMessage) : msg;
	}

	return msg;
}
