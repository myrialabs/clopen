/**
 * Inbound signature verification.
 *
 * The digest is computed over the RAW REQUEST BYTES. Not the parsed body, not a
 * re-serialised copy of it: `JSON.parse` followed by `JSON.stringify` reorders
 * keys, drops insignificant whitespace and normalises escapes, and a valid
 * signature over the original bytes will not match the result. This is the
 * single most common way a webhook verifier ends up rejecting every genuine
 * delivery, or — worse — being "fixed" by disabling it.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { WebhookSpec } from '../registry';

export type VerifyOutcome =
	| { ok: true }
	| { ok: false; reason: string };

/**
 * Compare in constant time.
 *
 * `timingSafeEqual` throws on a length mismatch, which would leak length
 * through an exception, so the lengths are checked first and a mismatch is
 * simply a failure.
 */
function safeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

export function verifySignature(
	spec: WebhookSpec,
	secret: string,
	rawBody: Uint8Array,
	headers: Headers
): VerifyOutcome {
	if (spec.scheme === 'none') return { ok: true };

	if (!spec.signatureHeader) {
		return { ok: false, reason: 'provider declares a signature scheme but no header' };
	}
	if (!secret) {
		return { ok: false, reason: 'no signing secret configured on the account' };
	}

	const presented = headers.get(spec.signatureHeader);
	if (!presented) {
		return { ok: false, reason: `missing ${spec.signatureHeader}` };
	}

	const prefix = spec.signaturePrefix ?? '';
	if (prefix && !presented.startsWith(prefix)) {
		return { ok: false, reason: 'signature prefix mismatch' };
	}

	const digest = createHmac('sha256', secret)
		.update(rawBody)
		.digest(spec.digestEncoding ?? 'hex');

	return safeEqual(presented.slice(prefix.length), digest)
		? { ok: true }
		: { ok: false, reason: 'signature mismatch' };
}
