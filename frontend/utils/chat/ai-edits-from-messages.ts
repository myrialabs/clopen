/**
 * Derive the AI edit list for the currently-displayed conversation from the raw
 * message array. Because `sessionState.messages` is replaced whenever the session,
 * checkpoint, or history view changes, deriving from it keeps the AI-change
 * indicators in lockstep with what the user is actually looking at — instead of
 * accumulating as a side effect of rendering chat tool rows.
 */
import type { FrontendMessage } from '$frontend/stores/core/sessions.svelte';
import type { EditInput, WriteInput } from '$shared/types/unified';
import { extractToolUses, extractToolResults } from './message-processor';
import type { AiEditEntry } from '$frontend/utils/ai-changes';

/** Extract successful Edit/Write tool calls, in conversation order. */
export function extractAiEdits(messages: FrontendMessage[]): AiEditEntry[] {
	// First pass: map each tool_use id to whether its result errored.
	const errorById = new Map<string, boolean>();
	for (const message of messages) {
		if (message.type === 'user' && 'content' in message && Array.isArray(message.content)) {
			for (const result of extractToolResults(message.content)) {
				if (result.toolUseId) errorById.set(result.toolUseId, result.isError);
			}
		}
	}

	// Second pass: collect Edit/Write tool_uses that completed successfully.
	const entries: AiEditEntry[] = [];
	for (const message of messages) {
		if (message.type !== 'assistant' || !('content' in message) || !Array.isArray(message.content)) {
			continue;
		}
		for (const toolUse of extractToolUses(message.content)) {
			if (toolUse.name !== 'Edit' && toolUse.name !== 'Write') continue;
			// Require a completed, non-error result — mirrors the old per-component
			// `hasResult` gate so in-flight or failed edits don't show a gutter.
			if (errorById.get(toolUse.id) !== false) continue;

			if (toolUse.name === 'Edit') {
				const input = toolUse.input as EditInput;
				const filePath = input.filePath || '';
				if (!filePath) continue;
				entries.push({
					filePath,
					oldContent: input.oldString || '',
					newContent: input.newString || '',
					key: toolUse.id
				});
			} else {
				const input = toolUse.input as WriteInput;
				const filePath = input.filePath || '';
				const content = input.content || '';
				if (!filePath || !content) continue;
				entries.push({ filePath, oldContent: '', newContent: content, key: toolUse.id });
			}
		}
	}
	return entries;
}
