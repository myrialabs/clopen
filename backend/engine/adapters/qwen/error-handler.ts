/**
 * Qwen Code SDK error handler.
 *
 * Mirrors the Claude/Codex pattern: swallow abort errors, normalise the
 * common categories (missing CLI, missing API key, quota, auth) and otherwise
 * surface a sanitised message.
 *
 * The SDK reports CLI subprocess failures as a generic
 * `CLI process exited with code N` Error — without the CLI's stderr the
 * underlying cause is invisible. The adapter buffers the last few stderr
 * lines and feeds them in via `stderrTail` so the user-facing message
 * carries something actionable.
 */

export function handleStreamError(error: unknown, stderrTail?: string): void {
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

	const tail = (stderrTail ?? '').trim();
	const tailLower = tail.toLowerCase();

	if (error.message.includes('ENOENT') || error.message.includes('spawn qwen')) {
		throw new Error('Qwen Code CLI not found. Install it via Settings → System Tools (or `bun add -g @qwen-code/qwen-code`).');
	}

	if (
		error.message.includes('OPENAI_API_KEY')
		|| error.message.includes('not authenticated')
		|| error.message.includes('401')
		|| tailLower.includes('invalid api key')
		|| tailLower.includes('unauthorized')
	) {
		throw new Error('Qwen Code is not authenticated. Check the API key and base URL in Settings → Engines → Qwen Code.');
	}

	if (error.message.includes('insufficient_quota') || error.message.includes('quota') || tailLower.includes('insufficient_quota')) {
		throw new Error('Qwen Code quota exceeded. Check your API balance or switch account.');
	}

	if (tailLower.includes('model not found') || tailLower.includes('does not exist') || tailLower.includes('unsupported model')) {
		throw new Error(`Qwen Code endpoint rejected the selected model. Pick a model supported by your provider.${tail ? `\n\nCLI: ${tail}` : ''}`);
	}

	throw new Error(buildDetailedError(error, tail));
}

function buildDetailedError(error: Error, stderrTail: string): string {
	const err = error as unknown as Record<string, unknown>;
	let message = (typeof err.message === 'string' ? err.message : '').replace(/^Error:\s*/, '');
	if (!message) {
		message = typeof err.name === 'string' && err.name !== 'Error' ? err.name : 'Unknown error';
	}
	if (err.status && !message.includes(String(err.status))) {
		message += ` (status ${String(err.status)})`;
	}
	const base = message || error.message || 'Unknown error';
	if (stderrTail && !base.includes(stderrTail)) {
		return `${base}\n\nCLI: ${stderrTail}`;
	}
	return base;
}
