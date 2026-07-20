/**
 * Pi SDK error handler.
 *
 * Mirrors the Claude/Qwen pattern: swallow abort errors, normalise the common
 * categories (missing auth, quota, bad model) and otherwise surface a sanitised
 * message. Pi runs in-process, so there is no CLI stderr tail to fold in.
 */

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

	const lower = error.message.toLowerCase();

	if (
		lower.includes('no api key')
		|| lower.includes('not authenticated')
		|| lower.includes('unauthorized')
		|| lower.includes('401')
		|| lower.includes('no auth')
		|| lower.includes('invalid api key')
	) {
		throw new Error('Pi is not authenticated for the selected provider. Add or re-authenticate the account in Settings → Engines → Pi.');
	}

	if (lower.includes('quota') || lower.includes('insufficient_quota') || lower.includes('429') || lower.includes('rate limit')) {
		throw new Error('Pi provider quota/rate limit exceeded. Check your balance or switch account.');
	}

	if (lower.includes('model not found') || lower.includes('does not exist') || lower.includes('unsupported model') || lower.includes('no model')) {
		throw new Error('Pi could not resolve the selected model for this account. Pick a model your provider supports.');
	}

	const message = error.message.replace(/^Error:\s*/, '') || error.name || 'Unknown error';
	throw new Error(message);
}
