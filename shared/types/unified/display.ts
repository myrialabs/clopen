/**
 * Display helper types for frontend rendering.
 *
 * Since ToolUseBlock already carries enrichment fields (result,
 * subActivities), this file only contains grouping/pairing helpers.
 */

import type { ToolResult } from './tool';
import type { UnifiedMessage } from './message';

// ============================================================
// Tool Group (for message grouper)
// ============================================================

/** Pairs a tool_use assistant message with its tool_result user message */
export interface ToolGroup {
	toolUseMessage: UnifiedMessage;
	toolResultMessage: UnifiedMessage | null;
}

/** Background bash session tracking */
export interface BackgroundBashData {
	bashToolId: string;
	bashOutputs: ToolResult[];
}
