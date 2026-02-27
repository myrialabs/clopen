export function handleStreamError(error: unknown): void {
  if (!(error instanceof Error)) {
    throw error;
  }

  // Abort errors are expected during cancellation - don't re-throw
  if (error.name === 'AbortError' || error.message.includes('aborted') || error.message.includes('abort')) {
    return;
  }

  if (error.message.includes('error_max_turns') || error.message.includes('max_turns')) {
    throw new Error('Unexpected conversation limit reached. This should not happen with unlimited turns enabled.');
  }

  if (error.message.includes('git-bash') || error.message.includes('requires git-bash')) {
    throw new Error('Claude Code requires git-bash on Windows. Please ensure Git is installed and accessible.');
  }

  if (error.message.includes('ENOENT') || error.message.includes('spawn claude-code')) {
    throw new Error('Claude Agent SDK not found. Please install it with: npm install @anthropic-ai/claude-agent-sdk');
  }

  if (error.message.includes('API key')) {
    throw new Error('Claude Agent SDK requires an Anthropic API key. Please set ANTHROPIC_API_KEY environment variable.');
  }

  // Extract detailed error info from API errors (Anthropic SDK APIError has .status, .error)
  const enriched = extractDetailedError(error);
  throw new Error(enriched);
}

/**
 * Extract detailed error info from an Error object.
 * Handles Anthropic SDK's APIError which has .status and .error.message fields.
 *
 * Does NOT prepend error class names (e.g. "APIError", "UnknownError") —
 * those are SDK implementation details, not useful for the end user.
 * The stream-manager's normalizeErrorText() also strips them as a safety net.
 */
function extractDetailedError(error: Error): string {
  const err = error as Record<string, any>;

  // Use the message directly, stripping any redundant leading "Error: " prefix
  let message = (err.message || '').replace(/^Error:\s*/, '');
  if (!message) {
    message = err.name && err.name !== 'Error' ? String(err.name) : 'Unknown error';
  }

  // Append status code if available (Anthropic APIError has .status)
  if (err.status && !message.includes(String(err.status))) {
    message += ` (status ${err.status})`;
  }

  // Append nested error body (Anthropic APIError has .error.message)
  if (err.error?.message && !message.includes(err.error.message)) {
    message += ` - ${err.error.message}`;
  }

  return message || error.message || 'Unknown error';
}
