import { getContext, setContext } from 'svelte';
import type { ToolStatus } from '$frontend/utils/chat/tool-status';

const KEY = Symbol('compact-tool');

/**
 * What the wrapper around a compact tool knows about the call, handed to the
 * row that draws it so every tool gets the same status, duration and details
 * toggle without passing them through by hand.
 */
export interface CompactToolContext {
	readonly status: ToolStatus;
	readonly durationMs: number | undefined;
	/** Whether there is anything to show below the row. */
	readonly hasDetails: boolean;
	readonly expanded: boolean;
	toggle(): void;
}

export function setCompactToolContext(context: CompactToolContext): void {
	setContext(KEY, context);
}

/** The call being rendered, or undefined outside of one. */
export function useCompactTool(): CompactToolContext | undefined {
	return getContext<CompactToolContext | undefined>(KEY);
}
