/**
 * Copilot SDK error handler.
 *
 * Mirrors the Claude error-handler pattern:
 * - Swallow abort errors (returned during cancellation, not rethrown).
 * - Map well-known Copilot error categories to user-facing messages.
 * - Otherwise, enrich the message with status code / providerCallId / url.
 */

import type { SessionEvent } from '@github/copilot-sdk';

type ErrorData = Extract<SessionEvent, { type: 'session.error' }>['data'];

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

	if (error.message.includes('ENOENT') || error.message.includes('spawn copilot')) {
		throw new Error('GitHub Copilot CLI not found. Reinstall @github/copilot-sdk so the bundled CLI is available.');
	}

	if (error.message.includes('Copilot Requests')) {
		throw new Error('Your GitHub PAT is missing the "Copilot Requests" permission. Regenerate it at github.com/settings/personal-access-tokens/new and enable Copilot Requests under Account permissions.');
	}

	if (error.message.includes('GITHUB_TOKEN') || error.message.includes('not authenticated')) {
		throw new Error('GitHub Copilot is not authenticated. Add a Personal Access Token with the "Copilot Requests" permission in Settings.');
	}

	throw new Error(extractDetailedError(error));
}

/**
 * Build a Copilot-flavoured error from a `session.error` ErrorData payload.
 * Returns an Error with errorType + statusCode + url enrichment.
 */
export function buildSessionError(data: ErrorData): Error {
	let message = data.message?.trim() || 'Unknown Copilot error';

	switch (data.errorType) {
		case 'authentication':
			message = `Authentication failed: ${message}`;
			break;
		case 'authorization':
			message = `Authorization denied: ${message}`;
			break;
		case 'quota':
			message = `Copilot quota exceeded: ${message}`;
			break;
		case 'rate_limit':
			message = `Copilot rate limit reached: ${message}`;
			break;
		case 'context_limit':
			message = `Context limit exceeded: ${message}`;
			break;
	}

	if (data.statusCode && !message.includes(String(data.statusCode))) {
		message += ` (status ${data.statusCode})`;
	}
	if (data.providerCallId) {
		message += ` [requestId: ${data.providerCallId}]`;
	}
	if (data.url) {
		message += ` — ${data.url}`;
	}

	return new Error(message);
}

function extractDetailedError(error: Error): string {
	const err = error as Record<string, any>;
	let message = (err.message || '').replace(/^Error:\s*/, '');
	if (!message) {
		message = err.name && err.name !== 'Error' ? String(err.name) : 'Unknown error';
	}
	if (err.status && !message.includes(String(err.status))) {
		message += ` (status ${err.status})`;
	}
	if (err.code && !message.includes(String(err.code))) {
		message += ` [${err.code}]`;
	}
	return message || error.message || 'Unknown error';
}
