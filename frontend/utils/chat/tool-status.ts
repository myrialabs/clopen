/**
 * Where a single tool call stands, for the status shown next to it.
 *
 * A call with a result is settled by that result. A call without one is only
 * still running if it belongs to the turn in flight: `isLoading` describes the
 * viewed session as a whole, so an unanswered call from an earlier turn (the
 * stream was stopped, the app restarted) must not spin again just because a
 * new turn started.
 */

import type { ToolUseBlock } from '$shared/types/unified';
import type { FrontendMessage } from '$frontend/stores/core/sessions.svelte';

export type ToolStatus = 'processing' | 'waiting' | 'success' | 'error' | 'interrupted';

/** What the viewed session is doing right now. */
export interface LiveTurn {
	isLoading: boolean;
	isWaitingInput: boolean;
	messages: FrontendMessage[];
}

/** Whether a tool call was made after the user's latest prompt. */
export function isInCurrentTurn(messages: FrontendMessage[], toolUseId: string): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!('content' in message) || !Array.isArray(message.content)) continue;
		if (message.type === 'assistant') {
			if (message.content.some((block) => block.type === 'tool_use' && block.id === toolUseId)) return true;
		} else if (message.type === 'user') {
			// Tool results and engine notices ride in "user" messages; only a real prompt opens a turn.
			const isPrompt = !message.content.some((block) => block.type === 'tool_result')
				&& !('synthetic' in message && message.synthetic === true);
			if (isPrompt) return false;
		}
	}
	return false;
}

export function getToolStatus(tool: ToolUseBlock, live: LiveTurn): ToolStatus {
	if (tool.result) return tool.result.isError ? 'error' : 'success';
	if (tool.interrupted || !live.isLoading || !isInCurrentTurn(live.messages, tool.id)) return 'interrupted';
	return live.isWaitingInput ? 'waiting' : 'processing';
}

/** One status for a group of calls: anything unsettled wins, then any failure. */
export function combineToolStatuses(statuses: ToolStatus[]): ToolStatus | null {
	if (statuses.length === 0) return null;
	if (statuses.includes('processing')) return 'processing';
	if (statuses.includes('waiting')) return 'waiting';
	if (statuses.includes('error')) return 'error';
	if (statuses.includes('interrupted')) return 'interrupted';
	return 'success';
}
