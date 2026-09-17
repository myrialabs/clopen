/**
 * Web Push cryptography (RFC 8291 `aes128gcm` + RFC 8292 VAPID).
 *
 * Implemented with the platform WebCrypto API instead of a `web-push`
 * dependency: Bun ships ECDH P-256, HKDF, AES-GCM and ECDSA, which is
 * everything the protocol needs. No new supply chain for a
 * security-sensitive path.
 *
 * Two pieces:
 * - VAPID: an ES256-signed JWT proving the push originates from this server.
 * - Content encryption: the payload is encrypted to the browser's per-
 *   subscription key, so the push service (Google/Mozilla/Apple) relaying it
 *   only ever sees ciphertext.
 */

const textEncoder = new TextEncoder();

export function base64UrlEncode(data: Uint8Array | ArrayBuffer): string {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	let binary = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
	const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

// ============================================================================
// VAPID (RFC 8292)
// ============================================================================

export interface VapidKeypair {
	/** Uncompressed P-256 public key (65 bytes), base64url. */
	publicKey: string;
	/** Raw P-256 private key (32 bytes), base64url. */
	privateKey: string;
}

export async function generateVapidKeypair(): Promise<VapidKeypair> {
	const keypair = await crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' },
		true,
		['sign', 'verify']
	);
	const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keypair.publicKey));
	const privateJwk = await crypto.subtle.exportKey('jwk', keypair.privateKey);
	if (!privateJwk.d) throw new Error('Failed to export VAPID private key');
	return { publicKey: base64UrlEncode(publicRaw), privateKey: privateJwk.d };
}

/**
 * Build the `Authorization` header for a push request.
 *
 * `audience` is the push service origin (`new URL(endpoint).origin`), so a
 * token minted for FCM cannot be replayed at another service. `subject`
 * identifies the server operator (`mailto:` or URL).
 */
export async function createVapidAuthorizationHeader(
	audience: string,
	subject: string,
	keypair: VapidKeypair,
	ttlSeconds = 12 * 3600
): Promise<string> {
	const header = base64UrlEncode(textEncoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
	const nowSeconds = Math.floor(Date.now() / 1000);
	const claims = base64UrlEncode(
		textEncoder.encode(
			JSON.stringify({ aud: audience, exp: nowSeconds + ttlSeconds, sub: subject })
		)
	);
	const signingInput = textEncoder.encode(`${header}.${claims}`);

	const publicBytes = base64UrlDecode(keypair.publicKey);
	if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
		throw new Error('Invalid VAPID public key (expected 65-byte uncompressed point)');
	}
	const privateKey = await crypto.subtle.importKey(
		'jwk',
		{
			kty: 'EC',
			crv: 'P-256',
			x: base64UrlEncode(publicBytes.slice(1, 33)),
			y: base64UrlEncode(publicBytes.slice(33, 65)),
			d: keypair.privateKey
		},
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		privateKey,
		signingInput
	);
	return `vapid t=${header}.${claims}.${base64UrlEncode(signature)}, k=${keypair.publicKey}`;
}

// ============================================================================
// Content encryption (RFC 8291, `aes128gcm`, single record)
// ============================================================================

/** Record size announced in the header. 4096 is what every push service accepts. */
const RECORD_SIZE = 4096;

export interface EncryptedPushPayload {
	/** Full request body: 16-byte salt + 4-byte rs + 1-byte idlen + 65-byte key + ciphertext. */
	body: Uint8Array<ArrayBuffer>;
}

/**
 * HKDF-Extract + first-block Expand, per RFC 5869 as used by RFC 8291.
 *
 * `secret = HKDF(salt, IKM, info, length)` means Extract(salt, IKM) then the
 * first `length` bytes of Expand — the same construction the reference
 * `web-push` implementation computes, so ciphertext decrypts in real
 * browsers.
 */
async function hkdf(
	salt: Uint8Array<ArrayBuffer>,
	ikm: Uint8Array<ArrayBuffer>,
	info: Uint8Array<ArrayBuffer>,
	length: number
): Promise<Uint8Array<ArrayBuffer>> {
	const extractKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
	return new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: 'HKDF', hash: 'SHA-256', salt, info },
			extractKey,
			length * 8
		)
	);
}

/**
 * Encrypt a payload for one subscription.
 *
 * Throws on malformed subscription keys — callers translate that into
 * dropping the dead subscription, never into failing the whole fan-out.
 */
export async function encryptPushPayload(
	clientPublicKeyBase64: string,
	clientAuthSecretBase64: string,
	payload: Uint8Array
): Promise<EncryptedPushPayload> {
	const clientPublicBytes = base64UrlDecode(clientPublicKeyBase64);
	if (clientPublicBytes.length !== 65 || clientPublicBytes[0] !== 0x04) {
		throw new Error('Invalid subscription p256dh key');
	}
	const authSecret = base64UrlDecode(clientAuthSecretBase64);
	if (authSecret.length < 16) {
		throw new Error('Invalid subscription auth secret');
	}

	const ephemeral = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' },
		true,
		['deriveBits']
	);
	const ephemeralPublicBytes = new Uint8Array(
		await crypto.subtle.exportKey('raw', ephemeral.publicKey)
	);
	const clientPublicKey = await crypto.subtle.importKey(
		'raw',
		clientPublicBytes,
		{ name: 'ECDH', namedCurve: 'P-256' },
		false,
		[]
	);
	const sharedSecret = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: 'ECDH', public: clientPublicKey },
			ephemeral.privateKey,
			256
		)
	);

	const salt = crypto.getRandomValues(new Uint8Array(16));

	// `key_info` binds the secret to this exact sender/receiver pair, so a
	// ciphertext cannot be transplanted onto another subscription.
	const keyInfo = concat(
		textEncoder.encode('WebPush: info\0'),
		clientPublicBytes,
		ephemeralPublicBytes
	);
	const secret = await hkdf(authSecret, sharedSecret, keyInfo, 32);
	const contentEncryptionKey = await hkdf(
		salt,
		secret,
		textEncoder.encode('Content-Encoding: aes128gcm\0'),
		16
	);
	const nonce = await hkdf(salt, secret, textEncoder.encode('Content-Encoding: nonce\0'), 12);

	// Single record: payload + 0x02 delimiter, no extra padding.
	const plaintext = concat(payload, new Uint8Array([0x02]));
	const aesKey = await crypto.subtle.importKey('raw', contentEncryptionKey, 'AES-GCM', false, [
		'encrypt'
	]);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext)
	);

	const header = new Uint8Array(16 + 4 + 1 + ephemeralPublicBytes.length);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
	header[20] = ephemeralPublicBytes.length;
	header.set(ephemeralPublicBytes, 21);

	return { body: concat(header, ciphertext) };
}
