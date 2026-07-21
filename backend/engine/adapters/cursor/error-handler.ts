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

	// Free-tier / plan gating: the Cursor agent API is Pro-only. A free key is
	// valid but its agent quota is limited — surface a clear, actionable message
	// instead of the raw SDK error.
	if (lower.includes('plan_required') || lower.includes('upgrade to pro') || lower.includes('not available for free users')) {
		throw new Error('Cursor agent runs require a paid plan. This API key is valid but its account is on the free tier — upgrade to Cursor Pro to use this engine.');
	}

	// Transient connectivity to Cursor's backend (the SDK's connect-rpc key
	// exchange). Seen most often with rate-limited / exhausted keys; surface a
	// clear, retryable message rather than the raw NetworkError.
	if (lower.includes('socket connection was closed') || lower.includes('api key exchange endpoint') || lower.includes('failed to connect')) {
		throw new Error('Cursor could not reach its backend (connection closed). This is usually transient or a rate-limited key — retry, and verify your account has agent quota.');
	}

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
