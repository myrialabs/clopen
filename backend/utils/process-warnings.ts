/**
 * Process warning filter — the single place that decides which
 * `process.emitWarning` output reaches the server log.
 *
 * Registering ANY 'warning' listener silences the runtime's default printer
 * (Bun only prints when the event has no listener at all — verified on Bun
 * 1.3.x, where `process.listenerCount('warning')` is 0 out of the box). So this
 * module owns the printing too: anything it does not explicitly suppress is
 * re-emitted to the log, or we would swallow deprecation notices,
 * MaxListenersExceededWarning, TimeoutOverflowWarning and friends.
 *
 * Suppress by `code`, never by message text — codes are stable, wording is not.
 */

import { debug } from '$shared/utils/logger';

/**
 * Warning codes we deliberately drop, each with the reason it is noise here.
 *
 * - CLAUDE_SDK_CAN_USE_TOOL_SHADOWED: @anthropic-ai/claude-agent-sdk >= 0.3.229
 *   emits this on every query() when `canUseTool` is passed alongside
 *   permissionMode 'bypassPermissions' — a static check on the options object,
 *   not an observed failure. Clopen keeps the callback for one job the CLI does
 *   still route through it (AskUserQuestion, which must wait on a human without
 *   a deadline); tool gating moved to the PreToolUse hook the warning itself
 *   recommends. See backend/engine/adapters/claude/stream.ts.
 */
const SUPPRESSED_WARNING_CODES = new Set(['CLAUDE_SDK_CAN_USE_TOOL_SHADOWED']);

let installed = false;

/** Idempotent — safe to call from more than one entry point. */
export function installProcessWarningFilter(): void {
	if (installed) return;
	installed = true;

	process.on('warning', (warning: Error & { code?: string }) => {
		if (warning.code && SUPPRESSED_WARNING_CODES.has(warning.code)) return;
		debug.warn('server', warning.stack || `${warning.name}: ${warning.message}`);
	});
}
