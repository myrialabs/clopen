/**
 * The headers are only worth anything if they survive the way Clopen actually
 * returns responses. The SPA fallback and the static file handler in
 * `backend/index.ts` hand back a raw `Response`, which is a different path
 * through Elysia than a plain object return — so both are exercised here.
 */

import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { SECURITY_HEADERS, securityMiddleware } from './security';

const app = new Elysia()
	.use(securityMiddleware)
	.get('/json', () => ({ ok: true }))
	// Mirrors the production SPA fallback: a raw Response with its own headers.
	.get('/spa', () => new Response('<!doctype html>', {
		headers: { 'Content-Type': 'text/html; charset=utf-8' }
	}));

async function headersFor(path: string): Promise<Headers> {
	const response = await app.handle(new Request(`http://localhost${path}`));
	return response.headers;
}

function csp(headers: Headers): string {
	return headers.get('content-security-policy') ?? '';
}

describe('security headers reach the response', () => {
	for (const path of ['/json', '/spa']) {
		test(`every header is set on ${path}`, async () => {
			const headers = await headersFor(path);
			for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
				expect(headers.get(name.toLowerCase())).toBe(value);
			}
		});
	}

	test('the raw Response keeps its own Content-Type', async () => {
		const headers = await headersFor('/spa');
		expect(headers.get('content-type')).toBe('text/html; charset=utf-8');
	});
});

describe('CSP covers what the app loads', () => {
	test('Monaco can load its scripts, styles and codicon font from the CDN', async () => {
		const policy = csp(await headersFor('/spa'));
		for (const directive of ['script-src', 'style-src', 'font-src', 'connect-src']) {
			expect(policy).toMatch(new RegExp(`${directive} [^;]*https://cdn\\.jsdelivr\\.net`));
		}
	});

	test("Monaco's blob-bootstrapped language workers are allowed", async () => {
		const policy = csp(await headersFor('/spa'));
		expect(policy).toMatch(/script-src [^;]*blob:/);
		expect(policy).toMatch(/worker-src [^;]*blob:/);
	});

	test('object-URL previews are allowed for media, frames and images', async () => {
		const policy = csp(await headersFor('/spa'));
		// MediaPreview.svelte: <audio>/<video> src, the PDF <iframe>, and images.
		expect(policy).toMatch(/media-src [^;]*blob:/);
		expect(policy).toMatch(/frame-src [^;]*blob:/);
		expect(policy).toMatch(/img-src [^;]*blob:/);
	});

	test('remote images in rendered markdown are not blocked', async () => {
		const policy = csp(await headersFor('/spa'));
		expect(policy).toMatch(/img-src [^;]*https:/);
	});

	test('embedding, base rewriting and off-site form posts are shut down', async () => {
		const policy = csp(await headersFor('/spa'));
		expect(policy).toContain("frame-ancestors 'none'");
		expect(policy).toContain("object-src 'none'");
		expect(policy).toContain("base-uri 'self'");
		expect(policy).toContain("form-action 'self'");
	});
});

describe('Permissions-Policy matches what the host bridge relays', () => {
	test('device APIs the Preview Browser relays stay available to the app', async () => {
		const policy = (await headersFor('/spa')).get('permissions-policy') ?? '';
		for (const feature of ['camera', 'microphone', 'geolocation', 'display-capture', 'clipboard-read']) {
			expect(policy).toContain(`${feature}=(self)`);
		}
	});

	test('features Clopen never uses are denied', async () => {
		const policy = (await headersFor('/spa')).get('permissions-policy') ?? '';
		for (const feature of ['payment', 'usb', 'serial', 'bluetooth', 'midi', 'hid']) {
			expect(policy).toContain(`${feature}=()`);
		}
	});
});
