/**
 * Scoping a sub-agent's output to the parent tool call that spawned it.
 *
 * Every engine that runs sub-agents (`Agent` / `Workflow`) has to make the same
 * decision for each output the child produces: does it belong to the parent
 * tool block, or to the main turn? Answering that per message constructor is
 * how sub-agent thinking leaked into the main chat — the Claude converter set
 * `parent.toolUseId` on assistant and user messages but hard-coded `null` on
 * reasoning, and forwarded the child's live `stream_event` deltas into the
 * root typing placeholder. A new output kind would leak the same way.
 *
 * So the decision lives here, once, keyed on the output's TYPE rather than on
 * which constructor made it: whatever the child emits either joins the parent
 * tool or is dropped. Nothing a child produces can reach the root.
 */

import type { EngineOutput } from '$shared/types/unified';

/**
 * Scope one sub-agent output to `parentToolUseId`.
 *
 * - Persisted messages (`user`, `assistant`, `reasoning`, `compact_boundary`)
 *   are returned tagged with the parent tool id, so the frontend folds them
 *   into that tool's `subActivities`. A message already tagged by a deeper
 *   sub-agent keeps its own (closer) parent.
 * - Everything else is turn-level — live typing deltas, results, init, rate
 *   limits, notifications. A child's copy of any of these would drive the MAIN
 *   turn's placeholder or lifecycle, and the stream protocol cannot carry a
 *   parent for them (adapter-contract §2.3, parent-tool rule 4), so they are dropped.
 *
 * Returns `null` for dropped outputs. Never mutates the input.
 */
export function scopeToParentTool(output: EngineOutput, parentToolUseId: string): EngineOutput | null {
	switch (output.type) {
		case 'user':
		case 'assistant':
		case 'reasoning':
		case 'compact_boundary':
			if (output.parent.toolUseId) return output;
			return { ...output, parent: { ...output.parent, toolUseId: parentToolUseId } };
		default:
			return null;
	}
}
