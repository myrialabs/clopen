/**
 * Secret redaction on the memory write path.
 *
 * Everything that reaches episodic extraction is a raw transcript: pasted API
 * keys, an `.env` a tool printed, an Authorization header inside a failed
 * request. Memory is the worst possible place for those to land, because unlike
 * a chat message a memory is durable, is re-injected into EVERY future turn on
 * EVERY engine, and is readable by every member of the instance. A secret that
 * reaches a message is exposed once; a secret that reaches the graph is exposed
 * continuously.
 *
 * So redaction runs before the transcript is handed to the model, and again on
 * what the model returns — a model asked to summarise a turn will happily quote
 * the token it saw, and the second pass is what stops that from being persisted.
 *
 * This is a filter, not a guarantee. It targets the shapes that are recognisable
 * without context (assigned credentials, known token prefixes, private keys,
 * connection strings) and deliberately does not try to catch a bare hex string,
 * which is far more often a commit hash than a secret. The point is to keep
 * routine leakage out of durable storage, not to promise that nothing can pass.
 */

const PLACEHOLDER = '[redacted]';

/**
 * Patterns are ordered longest-context-first: the assignment forms must run
 * before the bare-token forms, or `API_KEY=sk-…` would be half-redacted and the
 * variable name left dangling with a truncated value.
 */
const PATTERNS: { name: string; re: RegExp }[] = [
	// PEM blocks, including the body — the header alone is not the secret.
	{
		name: 'private-key',
		re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
	},
	// Authorization headers, in either the header or the curl form.
	//
	// These MUST run before `assigned-credential`. That pattern matches any name
	// containing "AUTH", so on `Authorization: Bearer <token>` it would consume the
	// header name and the word "Bearer" as its value, replace exactly that, and
	// leave the actual token sitting in the text — redacted-looking output with the
	// secret still in it, which is the worst possible outcome for this module.
	{ name: 'auth-header', re: /\b(Authorization|Proxy-Authorization)\s*:\s*\S+(?:\s+\S+)?/gi },
	{ name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g },
	// `FOO_TOKEN = "value"` / `foo_secret: value` in .env, YAML, JSON or code.
	{
		name: 'assigned-credential',
		re: /\b([A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH)[A-Za-z0-9_.-]*)\s*[:=]\s*["']?([^\s"',;]{6,})["']?/gi
	},
	// Vendor-prefixed keys. These are self-identifying, which is what makes them
	// safe to match without any surrounding context.
	{ name: 'vendor-key', re: /\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{16,}\b/g },
	{ name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
	{ name: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
	{ name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	// Google keys are AIza + 35, but the bound is loosened: a length-exact pattern
	// fails open on a key that was truncated or padded in transit, and `AIza` is
	// already specific enough that a false positive is implausible.
	{ name: 'google-key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
	{ name: 'clopen-device-code', re: /\bclp_dev_[A-Za-z0-9_-]{8,}\b/g },
	// JWTs — three base64url segments is a shape nothing else has.
	{ name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
	// Credentials embedded in a URL, which is how database strings leak.
	{ name: 'url-credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi }
];

export interface RedactionResult {
	text: string;
	/** Which pattern names fired, for the log. Never the values themselves. */
	hits: string[];
}

/**
 * Strip anything that looks like a credential.
 *
 * The variable name is kept in the assignment form (`API_KEY=[redacted]`)
 * because the FACT that a turn configured an API key is often the durable memory
 * worth keeping; the value never is.
 */
export function redactSecrets(input: string): RedactionResult {
	if (!input) return { text: input, hits: [] };

	let text = input;
	const hits: string[] = [];

	for (const { name, re } of PATTERNS) {
		// `re` carries /g, so reset lastIndex — these are module-level literals
		// reused across calls and a stale index silently skips matches.
		re.lastIndex = 0;
		if (!re.test(text)) continue;
		re.lastIndex = 0;
		hits.push(name);

		text = text.replace(re, (match, ...groups) => {
			if (name === 'assigned-credential') return `${groups[0]}=${PLACEHOLDER}`;
			if (name === 'url-credentials') return `${groups[0]}${PLACEHOLDER}@`;
			if (name === 'auth-header') return `${groups[0]}: ${PLACEHOLDER}`;
			return PLACEHOLDER;
		});
	}

	return { text, hits };
}

/** True when the text still contains something that reads as a credential. */
export function containsSecret(input: string): boolean {
	return redactSecrets(input).hits.length > 0;
}

/**
 * Neutralize a memory's text before it is placed inside the `<clopen-memory>`
 * block that every engine receives.
 *
 * Memory content is not trusted input. It is derived from repository files, tool
 * output and web pages — all of which an attacker can influence — and it is then
 * replayed into a privileged position in every future prompt, on every engine,
 * potentially in a different project from the one it was written in. That is a
 * stored prompt-injection channel with an unusually long reach.
 *
 * Two things are removed: anything that could close or forge the block's own
 * delimiters, and the instruction-shaped framing models are most likely to obey
 * ("ignore previous instructions", "system:"). Newlines are collapsed so a
 * memory cannot lay out a fake conversation turn inside the block.
 */
export function neutralizeForPrompt(text: string): string {
	return text
		.replace(/[<>]/g, ' ')
		.replace(/\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/gi, '[…]')
		.replace(/^\s*(?:system|assistant|user|human)\s*:/gim, '')
		.replace(/\s*\n\s*/g, ' ')
		.replace(/\s{2,}/g, ' ')
		.trim();
}
