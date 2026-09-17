/**
 * VAPID identity for this server.
 *
 * VAPID is not optional decoration: every push request must carry an
 * ES256-signed JWT proving which server sent it, or the push service answers
 * 401, and the same public key is what binds a browser's subscription to
 * this server so nobody else can push to that device. What IS optional is
 * the operator's involvement — a keypair is generated on first use and
 * persisted in the `settings` table, so push needs no configuration at all.
 *
 * There is deliberately no env-var override. Keys and subscriptions live in
 * the same database, so they are created and wiped together and a key can
 * never go stale against rows that outlived it — which is the only thing an
 * externally-provisioned key would have bought.
 *
 * Auto-generation (rather than failing closed) is likewise deliberate: push
 * is an opt-in per-device feature, and a missing key must never break boot.
 */

import { debug } from '$shared/utils/logger';
import { settingsQueries } from '../database/queries/settings-queries';
import { base64UrlDecode, generateVapidKeypair, type VapidKeypair } from './webpush-crypto';

const SETTINGS_KEY = 'push:vapid_keys';

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

/**
 * Contact for the VAPID JWT `sub` claim.
 *
 * RFC 8292 wants a `mailto:` or `https:` URI a push service operator could
 * use to reach whoever is sending. A self-hosted instance has no such
 * address, so this points at the project rather than inventing an
 * undeliverable mailbox — and it is a constant precisely so that nobody has
 * to configure it.
 */
const VAPID_SUBJECT = 'https://github.com/myrialabs/clopen';

export function getVapidSubject(): string {
	return VAPID_SUBJECT;
}
