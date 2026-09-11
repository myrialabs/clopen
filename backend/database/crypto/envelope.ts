/**
 * AES-256-GCM envelope for secrets at rest.
 *
 * Format: `clpsec:v1:<fingerprint>:<base64(iv ‖ tag ‖ ciphertext)>`
 *
 * The PREFIX is what makes the rollout safe, and it carries three properties
 * the migration and every query module depend on:
 *
 *   1. A value WITHOUT the prefix is pre-migration plaintext and is returned
 *      untouched. A half-migrated table therefore reads correctly.
 *   2. Sealing a value that already carries the prefix is a NO-OP, so a re-run
 *      migration cannot double-encrypt, and a read-modify-write path that hands
 *      a still-sealed value back to `seal()` stays correct.
 *   3. The fingerprint identifies WHICH key sealed the value, so a value the
 *      active key cannot open is recognisable as a key mismatch rather than
 *      corruption.
 *
 * `open()` NEVER throws. Throwing here would take down every read path that
 * touches a stored connection the moment a key went missing — the Settings
 * page, the MCP config builder, the db-client list. An unopenable value returns
 * null and increments a counter the Integrations hub surfaces as a banner.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { getMasterKey } from './master-key';
import { debug } from '$shared/utils/logger';

const PREFIX = 'clpsec';
const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** `clpsec:v1:<8 hex>:<base64>` */
const SEALED_PATTERN = /^clpsec:v1:[0-9a-f]{8}:[A-Za-z0-9+/=]+$/;

export interface DecryptFailureState {
	/** Number of values the active key could not open since process start. */
	count: number;
	/** ISO timestamp of the most recent failure, or null. */
	lastAt: string | null;
	/** Key fingerprints seen on values we could not open — helps identify the missing key. */
	fingerprints: string[];
}

const failures = {
	count: 0,
	lastAt: null as string | null,
	fingerprints: new Set<string>()
};

/** True when the value already carries a sealed envelope. */
export function isSealed(value: string): boolean {
	return SEALED_PATTERN.test(value);
}

/**
 * Seal a value. `null`, `undefined` and the empty string pass through unchanged
 * — an empty secret is "not set", and sealing it would turn a falsy check into
 * a truthy one everywhere downstream.
 */
export function seal(value: string | null | undefined): string | null {
	if (value === null || value === undefined || value === '') {
		return value === undefined ? null : value;
	}
	if (isSealed(value)) return value;

	const { key, fingerprint } = getMasterKey();
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
	const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);

	return `${PREFIX}:${VERSION}:${fingerprint}:${payload.toString('base64')}`;
}

/**
 * Open a sealed value.
 *
 * Returns the input unchanged when it is not sealed (pre-migration plaintext),
 * and `null` when it is sealed but cannot be opened. Never throws.
 */
export function open(value: string | null | undefined): string | null {
	if (value === null || value === undefined || value === '') {
		return value === undefined ? null : value;
	}
	if (!isSealed(value)) return value;

	const [, , fingerprint, encoded] = value.split(':');

	try {
		const { key, fingerprint: activeFingerprint } = getMasterKey();
		if (fingerprint !== activeFingerprint) {
			throw new Error(`sealed with key ${fingerprint}, active key is ${activeFingerprint}`);
		}

		const payload = Buffer.from(encoded!, 'base64');
		const iv = payload.subarray(0, IV_BYTES);
		const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
		const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);

		const decipher = createDecipheriv('aes-256-gcm', key, iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
	} catch (error) {
		failures.count += 1;
		failures.lastAt = new Date().toISOString();
		if (fingerprint) failures.fingerprints.add(fingerprint);
		debug.error('database', '🔒 Could not open a sealed value:', error);
		return null;
	}
}

/** Snapshot of decryption failures — the hub renders this as a banner. */
export function getDecryptFailures(): DecryptFailureState {
	return {
		count: failures.count,
		lastAt: failures.lastAt,
		fingerprints: [...failures.fingerprints]
	};
}

/** Clear the failure counter. Tests, and the hub's "dismiss" action. */
export function resetDecryptFailures(): void {
	failures.count = 0;
	failures.lastAt = null;
	failures.fingerprints.clear();
}
