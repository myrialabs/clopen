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
${JSON.stringify(schema, null, 2)}

End your response immediately after the closing brace — no explanation, no follow-up. Inside string values, escape every newline as \\n and every quote as \\".`;
}

/**
 * Scan out every top-level `{ … }` object in `text`.
 *
 * Brace counting alone is not enough: a `}` inside a string value would close
 * the object early, so this tracks string/escape state as it walks. Unbalanced
 * tails (a truncated response) yield nothing rather than a half object.
 */
function balancedObjects(text: string): string[] {
	const objects: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}

		if (ch === '"') inString = true;
		else if (ch === '{') {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === '}' && depth > 0) {
			depth--;
			if (depth === 0 && start !== -1) {
				objects.push(text.slice(start, i + 1));
				start = -1;
			}
		}
	}

	return objects;
}

/**
 * Escape raw control characters that appear inside string literals.
 *
 * JSON forbids a literal newline or tab inside a string, but models emit them
 * constantly when a field holds Markdown (an artifact body, a commit body).
 * Characters outside strings are left alone so structure is never altered.
 */
function escapeControlCharsInStrings(text: string): string {
	const ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\f': '\\f', '\b': '\\b' };
	let out = '';
	let inString = false;
	let escaped = false;

	for (const ch of text) {
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;

			if (!escaped && ch < ' ') {
				out += ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
				continue;
			}
		} else if (ch === '"') {
			inString = true;
		}
		out += ch;
	}

	return out;
}

/**
 * Extract a JSON object from a model response.
 *
 * Prompt-engineered engines get whatever the model felt like emitting, so this
 * tries, in order:
 *   1. Every ```json … ``` fenced block
 *   2. Every top-level balanced `{ … }` object — models routinely append
 *      commentary after the JSON, and that commentary can itself contain braces
 *   3. First `{` … last `}` — salvages an object whose braces only look
 *      unbalanced because of a stray brace in a string
 *   4. The raw trimmed text
 *
 * Each candidate is parsed as-is first, then with control characters inside
 * strings escaped.
 *
 * Throws if nothing parses.
 */
export function extractJson<T = unknown>(text: string): T {
	const trimmed = text.trim();
	if (!trimmed) {
		throw new Error('Empty response — no JSON to parse');
	}

	const candidates: string[] = [];
	for (const fence of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
		candidates.push(fence[1].trim());
	}

	candidates.push(...balancedObjects(trimmed));

	const braceStart = trimmed.indexOf('{');
	const braceEnd = trimmed.lastIndexOf('}');
	if (braceStart !== -1 && braceEnd > braceStart) {
		candidates.push(trimmed.slice(braceStart, braceEnd + 1));
	}

	candidates.push(trimmed);

	let lastError: unknown;
	for (const candidate of candidates) {
		const repaired = escapeControlCharsInStrings(candidate);
		for (const variant of repaired === candidate ? [candidate] : [candidate, repaired]) {
			try {
				return JSON.parse(variant) as T;
			} catch (err) {
				lastError = err;
			}
		}
	}

	// Show both ends: a truncated response and a response with trailing prose
	// fail identically from the head alone.
	const preview = trimmed.length > 400
		? `${trimmed.slice(0, 200)}… [${trimmed.length} chars] …${trimmed.slice(-200)}`
		: trimmed;
	throw new Error(
		`Response did not contain valid JSON: ${preview}` +
			(lastError instanceof Error ? ` (${lastError.message})` : '')
	);
}
