/**
 * Shared helpers for one-shot structured JSON generation.
 *
 * Engines whose SDKs lack a native JSON-schema output mode (OpenCode, Copilot,
 * Qwen) fall back to prompt engineering: instruct the model to emit JSON only,
 * then parse it out of whatever text the model returns. The native path on
 * Claude and Codex doesn't need these helpers.
 */

/** Wrap a user prompt with a JSON-only instruction and the target schema. */
export function buildJsonPrompt(prompt: string, schema: Record<string, unknown>): string {
	return `${prompt}

IMPORTANT: You MUST respond with ONLY a valid JSON object matching this schema, no other text, no markdown fences, no commentary:
${JSON.stringify(schema, null, 2)}`;
}

/**
 * Extract a JSON object from a model response.
 *
 * Models routinely wrap JSON in markdown fences or prose even when asked
 * not to. This searches in order:
 *   1. ```json … ``` or ``` … ``` fenced block
 *   2. The first balanced `{ … }` substring
 *   3. The raw trimmed text
 *
 * Throws if nothing parses.
 */
export function extractJson<T = unknown>(text: string): T {
	const trimmed = text.trim();
	if (!trimmed) {
		throw new Error('Empty response — no JSON to parse');
	}

	const candidates: string[] = [];
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) candidates.push(fenced[1].trim());

	const braceStart = trimmed.indexOf('{');
	const braceEnd = trimmed.lastIndexOf('}');
	if (braceStart !== -1 && braceEnd > braceStart) {
		candidates.push(trimmed.slice(braceStart, braceEnd + 1));
	}

	candidates.push(trimmed);

	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate) as T;
		} catch (err) {
			lastError = err;
		}
	}
	throw new Error(
		`Response did not contain valid JSON: ${trimmed.slice(0, 200)}${trimmed.length > 200 ? '…' : ''}` +
			(lastError instanceof Error ? ` (${lastError.message})` : '')
	);
}
