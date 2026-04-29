/**
 * Codex SDK error handler.
 *
 * Mirrors the Claude / Copilot error-handler pattern:
 * - Swallow abort errors (returned during cancellation, not rethrown).
 * - Map well-known Codex error categories to user-facing messages.
 * - Otherwise enrich the message with status code / request id when available.
 */

import type { ThreadError } from '@openai/codex-sdk';

export function handleStreamError(error: unknown): void {
	if (!(error instanceof Error)) {
		throw error;
	}

	if (
		error.name === 'AbortError'
		|| error.message.includes('aborted')
		|| error.message.includes('abort')
		|| error.message === 'Operation aborted'
	) {
		return;
	}

	if (error.message.includes('ENOENT') || error.message.includes('spawn codex')) {
		throw new Error('Codex CLI not found. Install it via Settings → System Tools (or run `bun add -g @openai/codex`).');
	}

	if (error.message.includes('OPENAI_API_KEY') || error.message.includes('not authenticated')) {
		throw new Error('Codex is not authenticated. Add an API key or sign in with ChatGPT in Settings → Engines.');
	}

	if (error.message.includes('insufficient_quota') || error.message.includes('quota')) {
		throw new Error('Codex quota exceeded. Add credits to your OpenAI account or switch to a ChatGPT-mode account.');
	}

	if (error.message.includes('401') || error.message.toLowerCase().includes('unauthorized')) {
		throw new Error('Codex authentication failed. Re-authenticate in Settings → Engines.');
	}

	throw new Error(extractDetailedError(error));
}

/**
 * Build a Codex-flavoured error from a `turn.failed` event payload.
 */
export function buildTurnError(data: ThreadError): Error {
	return new Error(data.message?.trim() || 'Unknown Codex error');
}

function extractDetailedError(error: Error): string {
	const err = error as unknown as Record<string, unknown>;
	let message = (typeof err.message === 'string' ? err.message : '').replace(/^Error:\s*/, '');
	if (!message) {
		message = typeof err.name === 'string' && err.name !== 'Error' ? err.name : 'Unknown error';
	}
	if (err.status && !message.includes(String(err.status))) {
		message += ` (status ${String(err.status)})`;
	}
	if (err.code && !message.includes(String(err.code))) {
		message += ` [${String(err.code)}]`;
	}
	return message || error.message || 'Unknown error';
}
