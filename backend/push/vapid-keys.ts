/**
 * VAPID identity for this server.
 *
 * Resolution order:
 * 1. `CLOPEN_VAPID_PUBLIC_KEY` + `CLOPEN_VAPID_PRIVATE_KEY` env (documented in
 *    `.env.example`) — for operators who provision keys themselves.
 * 2. The `settings` table (`push:vapid_keys`) — auto-generated on first use
 *    and persisted there, so keys survive restarts without any setup.
 *
 * Auto-generation (rather than failing closed) is deliberate: push is an
 * opt-in per-device feature, and a missing key should never break boot.
 */

import { debug } from '$shared/utils/logger';
import { settingsQueries } from '../database/queries/settings-queries';
import { base64UrlDecode, generateVapidKeypair, type VapidKeypair } from './webpush-crypto';

const SETTINGS_KEY = 'push:vapid_keys';

function readEnvKeys(): VapidKeypair | null {
	const publicKey = process.env.CLOPEN_VAPID_PUBLIC_KEY?.trim();
	const privateKey = process.env.CLOPEN_VAPID_PRIVATE_KEY?.trim();
	if (!publicKey && !privateKey) return null;
	if (!publicKey || !privateKey) {
		throw new Error(
			'CLOPEN_VAPID_PUBLIC_KEY and CLOPEN_VAPID_PRIVATE_KEY must be set together'
		);
	}
	// Fail fast on garbage rather than signing undecryptable pushes all day.
	if (base64UrlDecode(publicKey).length !== 65 || base64UrlDecode(privateKey).length !== 32) {
		throw new Error('Invalid CLOPEN_VAPID_* keys (expected 65-byte public, 32-byte private)');
	}
	return { publicKey, privateKey };
}

function readStoredKeys(): VapidKeypair | null {
	try {
		const row = settingsQueries.get(SETTINGS_KEY);
		if (!row) return null;
		const parsed = JSON.parse(row.value) as Partial<VapidKeypair>;
		if (typeof parsed.publicKey !== 'string' || typeof parsed.privateKey !== 'string') {
			return null;
		}
		if (base64UrlDecode(parsed.publicKey).length !== 65) return null;
		if (base64UrlDecode(parsed.privateKey).length !== 32) return null;
		return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
	} catch (error) {
		debug.warn('notification', 'Ignoring unreadable stored VAPID keys:', error);
		return null;
	}
}

let cached: VapidKeypair | null = null;

/** Server VAPID identity, generating + persisting one on first use. */
export async function getVapidKeys(): Promise<VapidKeypair> {
	if (cached) return cached;

	cached = readEnvKeys();
	if (cached) return cached;

	cached = readStoredKeys();
	if (cached) return cached;

	const fresh = await generateVapidKeypair();
	try {
		settingsQueries.set(SETTINGS_KEY, JSON.stringify(fresh));
	} catch (error) {
		// The keys still work for this process lifetime; persistence is retry
		// -able on the next call rather than fatal now.
		debug.warn('notification', 'Failed to persist generated VAPID keys:', error);
	}
	cached = fresh;
	return cached;
}

/** Contact string for the VAPID JWT `sub` claim. */
export function getVapidSubject(): string {
	const subject = process.env.CLOPEN_VAPID_SUBJECT?.trim();
	return subject || 'mailto:clopen@localhost';
}

/** Test hook: drop the cache so env/stored reads run again. */
export function resetVapidKeyCache(): void {
	cached = null;
}
