/**
 * Cursor SDK error handler.
 *
 * Cursor runs in-process (local agent), so there is no CLI stderr to fold in.
 * Swallow abort/cancel errors, normalise the common `CursorSdkError` categories
 * (auth, rate limit, bad model/config), and otherwise re-throw a sanitised
 * message. Mirrors the Cline/Pi pattern.
 */

export function handleStreamError(error: unknown): void {
	if (!(error instanceof Error)) {
		throw error;
	}

	if (
		error.name === 'AbortError'
		|| error.message.includes('aborted')
		|| error.message.includes('cancelled')
		|| error.message.includes('Cancelled')
	) {
		return;
	}

	const lower = error.message.toLowerCase();

	if (
		error.name === 'AuthenticationError'
		|| lower.includes('unauthorized')
		|| lower.includes('invalid api key')
		|| lower.includes('expired')
		|| lower.includes('401')
	) {
		throw new Error('Cursor is not authenticated. Add or re-enter a valid API key in Settings → Engines → Cursor.');
	}

	if (error.name === 'RateLimitError' || lower.includes('rate limit') || lower.includes('quota') || lower.includes('429')) {
		throw new Error('Cursor rate limit or usage cap exceeded. Try again later or switch account.');
	}

	if (error.name === 'ConfigurationError' || lower.includes('model') && (lower.includes('not found') || lower.includes('unsupported') || lower.includes('invalid'))) {
		throw new Error('Cursor could not resolve the selected model. Pick a model your key supports.');
	}

	const message = error.message.replace(/^Error:\s*/, '') || error.name || 'Unknown error';
	throw new Error(message);
}
