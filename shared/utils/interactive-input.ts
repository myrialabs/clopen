/**
 * Single source of truth for the "is this conversation waiting for user input?"
 * derivation. Both the backend presence layer (status-manager) and the frontend
 * chat service consume this so the logic can never drift between them.
 *
 * Historically this logic was duplicated in three places with subtly different
 * rules, which let the "Needs input" status get stuck after an interrupt →
 * continue flow. Keeping one pure function here removes that class of bug.
 */

/** Tools that block the stream waiting for a user response. */
export const INTERACTIVE_TOOLS = new Set(['AskUserQuestion']);

/** Minimal structural shape shared by UnifiedMessage and its frontend supersets. */
interface WaitingInputMessage {
	type: string;
	stopReason?: string | null;
	content?: unknown;
}

interface WaitingInputBlock {
	type: string;
	name?: string;
	interrupted?: boolean;
}

/**
 * A conversation is "waiting for user input" if and only if its trailing turn
 * contains an unanswered, non-interrupted interactive tool_use.
 *
 * The rule is intentionally derived from message ordering rather than tracked
 * imperatively, so it stays correct across every entry path:
 *   - Answered normally     → the tool_result (a user message) lands after the
 *                             question, so the question is no longer trailing.
 *   - Interrupted → continue → the follow-up user message lands after the
 *                             question, so it is no longer trailing (was the bug).
 *   - Interrupted, no follow → the question turn is marked interrupted (via the
 *                             message stopReason or the block flag) and skipped.
 *   - Genuinely pending      → the question is the trailing turn and counts.
 *
 * Both interrupted representations are honored (message `stopReason` set by the
 * backend, block `interrupted` set by the frontend) so the reader tolerates
 * either signal regardless of which side produced the messages.
 */
export function isWaitingForInteractiveInput(messages: readonly WaitingInputMessage[]): boolean {
	// Find the index of the last user message — anything before it has already
	// been superseded by subsequent user activity and cannot be pending.
	let lastUserIndex = -1;
	for (let i = 0; i < messages.length; i++) {
		if (messages[i]?.type === 'user') lastUserIndex = i;
	}

	for (let i = lastUserIndex + 1; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg || msg.type !== 'assistant') continue;
		// An interrupted assistant turn never counts as waiting.
		if (msg.stopReason === 'interrupted') continue;
		if (!Array.isArray(msg.content)) continue;

		const hasPending = (msg.content as WaitingInputBlock[]).some(
			block =>
				block?.type === 'tool_use' &&
				!!block.name &&
				INTERACTIVE_TOOLS.has(block.name) &&
				!block.interrupted
		);
		if (hasPending) return true;
	}

	return false;
}
