import { describe, expect, test } from 'bun:test';

import {
	base64UrlDecode,
	base64UrlEncode,
	createVapidAuthorizationHeader,
	encryptPushPayload,
	generateVapidKeypair
} from './webpush-crypto';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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

async function hmac(
	key: Uint8Array<ArrayBuffer>,
	data: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
	const hmacKey = await crypto.subtle.importKey(
		'raw',
		key,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	return new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, data));
}

/**
 * Independent HKDF (manual HMAC Extract + Expand) — deliberately NOT the
 * module's native-HKDF path, so agreement between the two proves the math
 * rather than repeating the same code.
 */
async function hkdfManual(
	salt: Uint8Array<ArrayBuffer>,
	ikm: Uint8Array<ArrayBuffer>,
	info: Uint8Array<ArrayBuffer>,
	length: number
): Promise<Uint8Array<ArrayBuffer>> {
	const prk = await hmac(salt, ikm);
	return (await hmac(prk, concat(info, new Uint8Array([0x01])))).slice(0, length);
}

/** Simulate the browser side: generate a subscription keypair + auth secret. */
async function makeBrowserSubscription() {
	const keypair = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' },
		true,
		['deriveBits']
	);
	const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keypair.publicKey));
	const authSecret = crypto.getRandomValues(new Uint8Array(16));
	return {
		privateKey: keypair.privateKey,
		p256dh: base64UrlEncode(publicBytes),
		auth: base64UrlEncode(authSecret),
		authBytes: authSecret
	};
}

describe('base64url', () => {
	test('round-trips arbitrary bytes without padding', () => {
		const bytes = crypto.getRandomValues(new Uint8Array(65));
		expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
		expect(base64UrlEncode(bytes)).not.toContain('=');
		expect(base64UrlEncode(bytes)).not.toMatch(/[+/]/);
	});
});

describe('VAPID', () => {
	test('generates a 65-byte uncompressed public key', async () => {
		const keypair = await generateVapidKeypair();
		const pub = base64UrlDecode(keypair.publicKey);
		expect(pub.length).toBe(65);
		expect(pub[0]).toBe(0x04);
		expect(base64UrlDecode(keypair.privateKey).length).toBe(32);
	});

	test('produces a verifiable ES256 JWT with aud/exp/sub', async () => {
		const keypair = await generateVapidKeypair();
		const header = await createVapidAuthorizationHeader(
			'https://fcm.googleapis.com',
			'mailto:admin@example.com',
			keypair
		);

		expect(header).toStartWith('vapid t=');
		const token = header.slice('vapid t='.length).split(', k=')[0];
		const [headerB64, claimsB64, signatureB64] = token.split('.');
		expect(JSON.parse(textDecoder.decode(base64UrlDecode(headerB64)))).toEqual({
			typ: 'JWT',
			alg: 'ES256'
		});
		const claims = JSON.parse(textDecoder.decode(base64UrlDecode(claimsB64)));
		expect(claims.aud).toBe('https://fcm.googleapis.com');
		expect(claims.sub).toBe('mailto:admin@example.com');
		expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

		const pubBytes = base64UrlDecode(keypair.publicKey);
		const publicKey = await crypto.subtle.importKey(
			'jwk',
			{
				kty: 'EC',
				crv: 'P-256',
				x: base64UrlEncode(pubBytes.slice(1, 33)),
				y: base64UrlEncode(pubBytes.slice(33, 65))
			},
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['verify']
		);
		const valid = await crypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			publicKey,
			base64UrlDecode(signatureB64),
			textEncoder.encode(`${headerB64}.${claimsB64}`)
		);
		expect(valid).toBe(true);
	});
});

describe('encryptPushPayload', () => {
	test('encrypts so the subscription owner can decrypt (full round-trip)', async () => {
		const sub = await makeBrowserSubscription();
		const payload = textEncoder.encode(
			JSON.stringify({ title: 'Claude Response Complete', body: 'Balasan AI siap', tag: 't-1' })
		);

		const { body } = await encryptPushPayload(sub.p256dh, sub.auth, payload);

		// Header + ciphertext overhead: 86-byte header, payload + 1 delimiter + 16 tag.
		expect(body.length).toBe(86 + payload.length + 1 + 16);

		// --- browser side, independent code path ---
		const salt = body.slice(0, 16);
		const serverPublicBytes = body.slice(21, 86);
		const ciphertext = body.slice(86);
		const clientPublicBytes = base64UrlDecode(sub.p256dh);

		const serverPublicKey = await crypto.subtle.importKey(
			'raw',
			serverPublicBytes,
			{ name: 'ECDH', namedCurve: 'P-256' },
			false,
			[]
		);
		const sharedSecret = new Uint8Array(
			await crypto.subtle.deriveBits(
				{ name: 'ECDH', public: serverPublicKey },
				sub.privateKey,
				256
			)
		);
		const keyInfo = concat(
			textEncoder.encode('WebPush: info\0'),
			clientPublicBytes,
			serverPublicBytes
		);
		const secret = await hkdfManual(sub.authBytes, sharedSecret, keyInfo, 32);
		const cek = await hkdfManual(
			salt,
			secret,
			textEncoder.encode('Content-Encoding: aes128gcm\0'),
			16
		);
		const nonce = await hkdfManual(
			salt,
			secret,
			textEncoder.encode('Content-Encoding: nonce\0'),
			12
		);
		const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
		const plaintext = new Uint8Array(
			await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aesKey, ciphertext)
		);

		expect(plaintext[plaintext.length - 1]).toBe(0x02);
		expect(textDecoder.decode(plaintext.slice(0, -1))).toBe(textDecoder.decode(payload));
	});

	test('rejects malformed subscription keys', async () => {
		const sub = await makeBrowserSubscription();
		await expect(
			encryptPushPayload('not-a-key', sub.auth, new Uint8Array([1]))
		).rejects.toThrow();
		await expect(
			encryptPushPayload(sub.p256dh, base64UrlEncode(new Uint8Array([1, 2])), new Uint8Array([1]))
		).rejects.toThrow();
	});
});
