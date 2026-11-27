import type { ToolResult, ToolUseBlock } from '$shared/types/unified';

/**
 * Tools whose renderer reads a failed result itself (AskUserQuestion turns it
 * into "not answered"). Every other renderer is handed the call without its
 * failed result and the wrapper shows the failure, so no renderer prints an
 * error as if it were output and every tool shows it the same way.
 */
const READS_OWN_FAILURE = new Set<string>(['AskUserQuestion']);

/** A result's text, whatever shape the engine sent it in. */
export function resultText(result: ToolResult | null | undefined): string {
	if (!result) return '';
	const content: unknown = result.content;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content.map((part) => (typeof part?.text === 'string' ? part.text : JSON.stringify(part))).join('\n');
	}
	return content == null ? '' : JSON.stringify(content);
}

/** The failure text to show for a call, or null when it didn't fail (or reports it itself). */
export function failureText(tool: ToolUseBlock): string | null {
	if (!tool.result?.isError || READS_OWN_FAILURE.has(tool.name)) return null;
	return resultText(tool.result).trim() || 'The tool failed without saying why.';
}

/** The call as its renderer should see it: a failed result is the wrapper's to show. */
export function withoutFailure(tool: ToolUseBlock): ToolUseBlock {
	return failureText(tool) === null ? tool : ({ ...tool, result: null } as ToolUseBlock);
}
