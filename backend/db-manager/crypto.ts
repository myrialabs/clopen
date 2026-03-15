/**
 * AES-256-GCM credential encryption for Database Manager.
 *
 * Uses the Web Crypto API (SubtleCrypto) which is built into Bun.
 * The master key is generated once and stored in the app settings table.
 *
 * Encrypted format: "<base64(iv)>:<base64(ciphertext)>"
 * Plain values that are not encrypted are stored as-is (backward compat).
 */

import { settingsQueries } from '../database/queries';
import { debug } from '$shared/utils/logger';

const MASTER_KEY_SETTING = 'db-manager:master-key';
const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96-bit IV for AES-GCM

/** Sentinel prefix to distinguish encrypted values from plain text */
const ENCRYPTED_PREFIX = 'enc:';

// ─── Key Management ───────────────────────────────────────────────────────────

let cachedKey: CryptoKey | null = null;

/** Load or generate the master AES-256 key stored in settings */
async function getMasterKey(): Promise<CryptoKey> {
	if (cachedKey) return cachedKey;

	const stored = settingsQueries.get(MASTER_KEY_SETTING);

	if (stored?.value) {
		const raw = Buffer.from(stored.value as string, 'base64');
		cachedKey = await crypto.subtle.importKey(
			'raw',
			raw,
			{ name: ALGORITHM, length: KEY_LENGTH },
			false,
			['encrypt', 'decrypt']
		);
		return cachedKey;
	}

	// Generate a new key and persist it
	const key = await crypto.subtle.generateKey(
		{ name: ALGORITHM, length: KEY_LENGTH },
		true,
		['encrypt', 'decrypt']
	);
	const exported = await crypto.subtle.exportKey('raw', key);
	settingsQueries.set(MASTER_KEY_SETTING, Buffer.from(exported).toString('base64'));
	debug.log('database', 'Generated new AES-256 master key for DB Manager credentials');

	cachedKey = key;
	return key;
}

// ─── Encrypt / Decrypt ────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns `enc:<base64(iv)>:<base64(ciphertext)>`.
 */
export async function encrypt(plaintext: string): Promise<string> {
	const key = await getMasterKey();
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const encoded = new TextEncoder().encode(plaintext);

	const cipherBuffer = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, encoded);

	const ivB64 = Buffer.from(iv).toString('base64');
	const ctB64 = Buffer.from(cipherBuffer).toString('base64');
	return `${ENCRYPTED_PREFIX}${ivB64}:${ctB64}`;
}

/**
 * Decrypt a value produced by `encrypt()`.
 * If the value does not start with the encrypted prefix it is returned as-is
 * (backward compatibility with plain-text stored passwords).
 */
export async function decrypt(value: string): Promise<string> {
	if (!value.startsWith(ENCRYPTED_PREFIX)) return value;

	const payload = value.slice(ENCRYPTED_PREFIX.length);
	const colonIdx = payload.indexOf(':');
	if (colonIdx === -1) throw new Error('Invalid encrypted credential format');

	const iv = Buffer.from(payload.slice(0, colonIdx), 'base64');
	const ct = Buffer.from(payload.slice(colonIdx + 1), 'base64');

	const key = await getMasterKey();
	const plainBuffer = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ct);
	return new TextDecoder().decode(plainBuffer);
}

/** Returns true if the value was encrypted by this module */
export function isEncrypted(value: string): boolean {
	return value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Encrypt the sensitive fields of a DBConnectionConfig object in-place.
 * Only `password` is encrypted; other fields are unchanged.
 */
export async function encryptConnectionCredentials<
	T extends { password?: string }
>(config: T): Promise<T> {
	if (!config.password) return config;
	return { ...config, password: await encrypt(config.password) };
}

/**
 * Decrypt the sensitive fields of a DBConnectionConfig object in-place.
 * Safe to call even if fields are not encrypted (returns original value).
 */
export async function decryptConnectionCredentials<
	T extends { password?: string }
>(config: T): Promise<T> {
	if (!config.password) return config;
	return { ...config, password: await decrypt(config.password) };
}

// ─── SSH Tunnel Credential Helpers ────────────────────────────────────────────

type WithSshTunnel<T> = T & {
	sshTunnel?: { password?: string; privateKey?: string; passphrase?: string };
};

/** Encrypt SSH tunnel credentials (password, privateKey, passphrase). */
export async function encryptSSHTunnelCredentials<T extends WithSshTunnel<object>>(config: T): Promise<T> {
	if (!config.sshTunnel) return config;
	const t = { ...config.sshTunnel };
	if (t.password) t.password = await encrypt(t.password);
	if (t.privateKey) t.privateKey = await encrypt(t.privateKey);
	if (t.passphrase) t.passphrase = await encrypt(t.passphrase);
	return { ...config, sshTunnel: t };
}

/** Decrypt SSH tunnel credentials. Safe to call on plain-text values. */
export async function decryptSSHTunnelCredentials<T extends WithSshTunnel<object>>(config: T): Promise<T> {
	if (!config.sshTunnel) return config;
	const t = { ...config.sshTunnel };
	if (t.password) t.password = await decrypt(t.password);
	if (t.privateKey) t.privateKey = await decrypt(t.privateKey);
	if (t.passphrase) t.passphrase = await decrypt(t.passphrase);
	return { ...config, sshTunnel: t };
}

/** Replace SSH sensitive fields with placeholder strings for client responses. */
export function sanitizeSSHTunnelForClient<T extends WithSshTunnel<object>>(config: T): T {
	if (!config.sshTunnel) return config;
	const t = { ...config.sshTunnel };
	if (t.password) t.password = '••••••••';
	if (t.privateKey) t.privateKey = '••••••••';
	if (t.passphrase) t.passphrase = '••••••••';
	return { ...config, sshTunnel: t };
}
