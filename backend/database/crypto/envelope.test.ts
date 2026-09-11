/**
 * Tests for the secrets-at-rest envelope.
 *
 * The cases that matter are the ones the rollout depends on rather than the
 * happy path: plaintext must survive a read untouched (a half-migrated table),
 * sealing twice must not double-encrypt (a re-run migration, or a
 * read-modify-write that hands a sealed value straight back), and a value the
 * active key cannot open must degrade to null instead of throwing — because a
 * throw here would take down every read path that touches a stored credential.
 */

import { describe, it, expect, afterEach } from 'bun:test';

import { isSealed, open, seal, getDecryptFailures, resetDecryptFailures } from './envelope';
import { getMasterKey, resetMasterKeyCache } from './master-key';

afterEach(() => {
	resetDecryptFailures();
	delete process.env.CLOPEN_MASTER_KEY;
	resetMasterKeyCache();
});

describe('envelope', () => {
	it('round-trips a value', () => {
		const sealed = seal('ghp_super_secret');
		expect(sealed).not.toBe('ghp_super_secret');
		expect(isSealed(sealed!)).toBe(true);
		expect(open(sealed)).toBe('ghp_super_secret');
	});

	it('produces a different ciphertext each time (random IV)', () => {
		expect(seal('same')).not.toBe(seal('same'));
	});

	it('returns unsealed input untouched — pre-migration plaintext still reads', () => {
		expect(open('plain-token')).toBe('plain-token');
		expect(open('{"API_KEY":"abc"}')).toBe('{"API_KEY":"abc"}');
	});

	it('is a no-op when sealing an already-sealed value', () => {
		const once = seal('token');
		expect(seal(once)).toBe(once);
		expect(open(seal(seal(once)))).toBe('token');
	});

	it('passes null and empty string through — an empty secret stays falsy', () => {
		expect(seal(null)).toBe(null);
		expect(seal('')).toBe('');
		expect(open(null)).toBe(null);
		expect(open('')).toBe('');
	});

	it('stamps the active key fingerprint into the envelope', () => {
		const { fingerprint } = getMasterKey();
		expect(seal('x')!.startsWith(`clpsec:v1:${fingerprint}:`)).toBe(true);
	});

	it('returns null and counts a failure when the key cannot open the value', () => {
		const sealed = seal('token')!;

		// Swap in a different key without restarting — the same situation as a
		// restored backup landing next to the wrong secret.key.
		process.env.CLOPEN_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
		resetMasterKeyCache();

		expect(open(sealed)).toBe(null);

		const failures = getDecryptFailures();
		expect(failures.count).toBe(1);
		expect(failures.lastAt).not.toBe(null);
		expect(failures.fingerprints.length).toBe(1);
	});

	it('returns null rather than throwing on a tampered payload', () => {
		const sealed = seal('token')!;
		const tampered = `${sealed.slice(0, -4)}AAAA`;
		expect(open(tampered)).toBe(null);
		expect(getDecryptFailures().count).toBe(1);
	});

	it('rejects an override that is not 32 bytes instead of falling back', () => {
		process.env.CLOPEN_MASTER_KEY = 'too-short';
		resetMasterKeyCache();
		expect(() => getMasterKey()).toThrow();
	});

	it('accepts a hex override as well as base64', () => {
		process.env.CLOPEN_MASTER_KEY = Buffer.alloc(32, 3).toString('hex');
		resetMasterKeyCache();
		expect(getMasterKey().key.length).toBe(32);
		expect(getMasterKey().source).toBe('env');
	});
});
