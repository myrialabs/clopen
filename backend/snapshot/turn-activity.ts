/**
 * When a turn's tools were running.
 *
 * The disk says WHAT changed (turn-changes.ts). It cannot say which chat
 * changed it, and that only matters when two chats run in the same folder at
 * once and both see the same file move. Naming files per tool could never
 * settle it: a shell command, a build script, an MCP tool or a tool that does
 * not exist yet writes files no tool input names.
 *
 * Time can. Every tool call, whatever it is, runs between its call and its
 * result, and a file written by it carries a modification time inside that
 * span. So the question "which chat wrote this" becomes "whose tool was
 * running when it was written" — one rule for every tool.
 *
 * A window opens at the engine's LAST output before the call, not at the call
 * itself. Some engines (Codex) only report a command once it has finished, so
 * the call and its result arrive together; the silence before them is when
 * the command actually ran.
 */

/** Filesystem timestamps are coarse on some volumes; a write this close counts. */
const WINDOW_SLACK_MS = 1000;

interface ContentBlock {
	type?: string;
	id?: string;
	toolUseId?: string;
}

/** The part of an engine output this reads: its type and content blocks. */
export interface ObservedOutput {
	type: string;
	content?: unknown;
}

function blocksOf(output: ObservedOutput): ContentBlock[] {
	return Array.isArray(output.content) ? (output.content as ContentBlock[]) : [];
}

export class TurnActivity {
	private lastOutputAt: number;
	private readonly open = new Map<string, number>();
	private readonly windows: Array<{ start: number; end: number }> = [];

	constructor(startedAt: number) {
		this.lastOutputAt = startedAt;
	}

	/** Feed every engine output of the turn, in order. */
	observe(output: ObservedOutput, now = Date.now()): void {
		if (output.type === 'assistant') {
			for (const block of blocksOf(output)) {
				if (block.type === 'tool_use' && block.id && !this.open.has(block.id)) {
					this.open.set(block.id, this.lastOutputAt);
				}
			}
		} else if (output.type === 'user') {
			for (const block of blocksOf(output)) {
				if (block.type !== 'tool_result' || !block.toolUseId) continue;
				const start = this.open.get(block.toolUseId);
				if (start === undefined) continue;
				this.windows.push({ start, end: now });
				this.open.delete(block.toolUseId);
			}
		}
		this.lastOutputAt = now;
	}

	/**
	 * Whether one of this turn's tools was running at `time` (epoch ms). A call
	 * still waiting for its result counts as running — an interrupted tool
	 * never sends one.
	 */
	wasRunningAt(time: number): boolean {
		for (const window of this.windows) {
			if (time >= window.start - WINDOW_SLACK_MS && time <= window.end + WINDOW_SLACK_MS) return true;
		}
		for (const start of this.open.values()) {
			if (time >= start - WINDOW_SLACK_MS) return true;
		}
		return false;
	}
}
