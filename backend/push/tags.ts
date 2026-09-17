/**
 * Server-side notification tags.
 *
 * A tag is identity, not a label: a push whose tag matches the on-screen
 * toast replaces it. Chat events therefore carry deterministic tags —
 * `chat-<streamId>`, `waiting-<toolUseId>` — so the server copy replaces the
 * local copy the open tab already showed (or appears alone when Chrome is
 * closed), instead of stacking a duplicate. Test pushes get a unique tag per
 * attempt so rapid retests never swallow each other.
 */

let tagCounter = 0;

export function uniquePushTag(prefix: string): string {
	tagCounter += 1;
	return `${prefix}-${Date.now()}-${tagCounter}`;
}

export function chatStreamPushTag(streamId: string): string {
	return `chat-${streamId}`;
}

export function waitingInputPushTag(toolUseId: string): string {
	return `waiting-${toolUseId}`;
}
