import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';

import { cacheControlFor, pickEncoding, serveIndexHtml, serveStaticFile } from './static-assets';

const dir = mkdtempSync(join(tmpdir(), 'clopen-static-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const source = 'console.log("hello");\n'.repeat(200);
const asset = join(dir, 'main-nBOb9YOA.js');
writeFileSync(asset, source);
writeFileSync(`${asset}.br`, brotliCompressSync(source));
writeFileSync(`${asset}.gz`, gzipSync(source));
const plain = join(dir, 'favicon.svg');
writeFileSync(plain, '<svg/>');

const request = (headers: Record<string, string> = {}) => new Request('http://localhost/x', { headers });

describe('cache policy', () => {
	test('content-hashed build output is immutable; everything else revalidates', () => {
		expect(cacheControlFor('/assets/main-nBOb9YOA.js')).toContain('immutable');
		expect(cacheControlFor('/assets/xterm-B-qIQCd3.js')).toContain('immutable');
		expect(cacheControlFor('/assets/zipkit-engine-CaR0t_Uy.wasm')).toContain('immutable');
		expect(cacheControlFor('/sw.js')).toBe('no-cache');
		expect(cacheControlFor('/index.html')).toBe('no-cache');
		expect(cacheControlFor('/favicon.svg')).toBe('no-cache');
	});
});

describe('encoding negotiation', () => {
	const both = new Set(['br', 'gzip'] as const);
	test('prefers brotli, falls back to gzip, honours q=0', () => {
		expect(pickEncoding('gzip, deflate, br', both)).toBe('br');
		expect(pickEncoding('gzip', both)).toBe('gzip');
		expect(pickEncoding('br;q=0, gzip', both)).toBe('gzip');
		expect(pickEncoding('identity', both)).toBeNull();
		expect(pickEncoding(null, both)).toBeNull();
	});
});

describe('serveStaticFile', () => {
	test('sends the brotli copy with the original type, and decodes to the original', async () => {
		const res = serveStaticFile(request({ 'accept-encoding': 'br, gzip' }), '/assets/main-nBOb9YOA.js', asset);
		expect(res.headers.get('content-encoding')).toBe('br');
		expect(res.headers.get('content-type')).toContain('javascript');
		expect(res.headers.get('vary')).toBe('Accept-Encoding');
		expect(res.headers.get('cache-control')).toContain('immutable');
		expect(brotliDecompressSync(Buffer.from(await res.arrayBuffer())).toString()).toBe(source);
	});

	test('sends gzip to a client without brotli, and the raw file to one without either', async () => {
		const gz = serveStaticFile(request({ 'accept-encoding': 'gzip' }), '/assets/main-nBOb9YOA.js', asset);
		expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).toBe(source);
		const raw = serveStaticFile(request(), '/assets/main-nBOb9YOA.js', asset);
		expect(raw.headers.get('content-encoding')).toBeNull();
		expect(await raw.text()).toBe(source);
	});

	test('answers 304 when the browser already holds this version', () => {
		const first = serveStaticFile(request(), '/favicon.svg', plain);
		const etag = first.headers.get('etag')!;
		const again = serveStaticFile(request({ 'if-none-match': etag }), '/favicon.svg', plain);
		expect(again.status).toBe(304);
		expect(again.headers.get('cache-control')).toBe('no-cache');
	});
});

describe('serveIndexHtml', () => {
	test('is always revalidated and answers 304 for the current version', () => {
		const fresh = serveIndexHtml(request(), '<html></html>', 'W/"1"');
		expect(fresh.headers.get('cache-control')).toBe('no-cache');
		expect(serveIndexHtml(request({ 'if-none-match': 'W/"1"' }), '<html></html>', 'W/"1"').status).toBe(304);
		expect(serveIndexHtml(request({ 'if-none-match': 'W/"0"' }), '<html></html>', 'W/"1"').status).toBe(200);
	});
});
