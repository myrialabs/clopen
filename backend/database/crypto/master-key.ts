/**
 * Master key resolution for secrets at rest.
 *
 * THREAT MODEL — read this before changing anything here.
 *
 * This protects a DATABASE FILE THAT LEAVES THE MACHINE: a backup, an rsync, a
 * volume snapshot, a stolen `app.db`. It does NOT protect against an attacker
 * who already has read access to the data directory, because the default key
 * lives inside that same directory. A self-hoster who wants protection beyond
 * "the db file leaked" must set `CLOPEN_MASTER_KEY` and keep it out of the data
 * directory. Say this plainly wherever it surfaces in the UI — claiming more
 * than this is worse than claiming nothing.
 *
 * The key is deliberately NOT derived from a machine id. Binding it to hardware
 * would make a restored backup undecryptable on a new host, and self-hosters
 * migrate hosts. A key that cannot survive a restore is a key that eats data.
 */

import { createHash, randomBytes } from 'crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getClopenDir } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';

/** File name of the generated key inside the data directory. */
const KEY_FILE_NAME = 'secret.key';

/** Raw key length for AES-256. */
const KEY_BYTES = 32;

export interface MasterKey {
	/** The 32-byte key material. */
	key: Buffer;
	/** Short, non-secret identifier stamped into every envelope. */
	fingerprint: string;
	/** Where the key came from — surfaced in the hub so the source is never a mystery. */
	source: 'env' | 'file';
}

let cached: MasterKey | null = null;

/**
 * A fingerprint is a truncated hash of the key, never the key itself. It exists
 * so a value sealed with a key we no longer hold can be RECOGNISED as such
 * rather than being mistaken for corruption.
 */
function fingerprintOf(key: Buffer): string {
	return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/**
 * Accept the env override in base64 or hex, whichever the operator pasted.
 * Anything that does not decode to exactly 32 bytes is rejected loudly at
 * startup rather than silently falling back to the file — a typo in the
 * override must not quietly change which key seals new rows.
 */
function parseEnvKey(raw: string): Buffer {
	const trimmed = raw.trim();

	if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
		return Buffer.from(trimmed, 'hex');
	}

	const decoded = Buffer.from(trimmed, 'base64');
	if (decoded.length === KEY_BYTES) return decoded;

	throw new Error(
		`CLOPEN_MASTER_KEY must be ${KEY_BYTES} bytes encoded as base64 or hex ` +
		`(got ${decoded.length} bytes after decoding)`
	);
}

function keyFilePath(): string {
	return join(getClopenDir(), KEY_FILE_NAME);
}

/**
 * Read the generated key file, creating it on first run.
 *
 * The write is 0600 where the platform honours it. Windows ignores the mode,
 * which is one more reason the module never claims to defend against a local
 * attacker.
 */
function loadOrCreateKeyFile(): Buffer {
	const path = keyFilePath();

	try {
		const contents = readFileSync(path, 'utf8').trim();
		const key = Buffer.from(contents, 'base64');
		if (key.length === KEY_BYTES) return key;
		// A key file of the wrong length is corrupt, not empty. Refuse rather
		// than regenerate: regenerating would strand every sealed row.
		throw new Error(`key file at ${path} is ${key.length} bytes, expected ${KEY_BYTES}`);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code !== 'ENOENT') throw error;
	}

	const key = randomBytes(KEY_BYTES);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// Best effort — Windows has no equivalent and failing here would block startup.
	}
	debug.log('database', `🔑 Generated secrets master key at ${path}`);
	return key;
}

/** Resolve the active master key, generating one on first run. Cached per process. */
export function getMasterKey(): MasterKey {
	if (cached) return cached;

	const override = process.env.CLOPEN_MASTER_KEY;
	const key = override ? parseEnvKey(override) : loadOrCreateKeyFile();

	cached = {
		key,
		fingerprint: fingerprintOf(key),
		source: override ? 'env' : 'file'
	};
	return cached;
}

/** Drop the cached key. Tests only — a running server must not swap keys mid-flight. */
export function resetMasterKeyCache(): void {
	cached = null;
}
