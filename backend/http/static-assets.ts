/**
 * Serving the built frontend (`dist/`) in production.
 *
 * It used to go out with no caching headers and no compression, so a browser
 * had nothing to revalidate against and every page load — a refresh, a new tab,
 * reopening the app on a phone — downloaded the whole bundle again: ~8 MB,
 * ~1.6 MB of it after brotli.
 *
 * - Content-hashed build output (`/assets/name-<hash>.ext`) never changes under
 *   its name, so it is cached for a year as immutable.
 * - Everything else (`index.html`, `sw.js`, the manifest, fonts, sounds) is
 *   revalidated on every use with an ETag, so an update is picked up at once
 *   and an unchanged file costs a 304. A new release's `index.html` names new
 *   hashed assets; the old ones simply stop being requested.
 * - Brotli or gzip copies written at build time (scripts/vite-precompress.ts)
 *   are sent when the browser accepts them — no compression at request time.
 */

import { statSync } from 'node:fs';

/** Build output named by its content hash, e.g. `main-nBOb9YOA.js`. */
const HASHED_ASSET = /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

type Encoding = 'br' | 'gzip';
const SUFFIX: Record<Encoding, string> = { br: '.br', gzip: '.gz' };

/** Which precompressed siblings exist — the build output does not change while running. */
const siblings = new Map<string, Set<Encoding>>();

function availableEncodings(filePath: string): Set<Encoding> {
	let found = siblings.get(filePath);
	if (!found) {
		found = new Set();
		for (const encoding of ['br', 'gzip'] as const) {
			try {
				if (statSync(filePath + SUFFIX[encoding]).isFile()) found.add(encoding);
			} catch {
				// No such copy.
			}
		}
		siblings.set(filePath, found);
	}
	return found;
}

/** The best encoding both sides support: brotli, then gzip, else none. */
export function pickEncoding(acceptEncoding: string | null, available: Set<Encoding>): Encoding | null {
	if (!acceptEncoding) return null;
	const accepted = new Set(
		acceptEncoding
			.split(',')
			.map((part) => part.trim())
			.filter((part) => !/;\s*q=0(\.0+)?$/.test(part))
			.map((part) => part.split(';')[0].trim().toLowerCase())
	);
	if (available.has('br') && accepted.has('br')) return 'br';
	if (available.has('gzip') && (accepted.has('gzip') || accepted.has('*'))) return 'gzip';
	return null;
}

/** Cache policy for a request path. */
export function cacheControlFor(urlPath: string): string {
	return HASHED_ASSET.test(urlPath) ? IMMUTABLE : REVALIDATE;
}

/**
 * A response for a file under `dist/`, or a 304 when the browser's copy is
 * current. `filePath` must already be resolved and confined to `dist/`.
 */
export function serveStaticFile(request: Request, urlPath: string, filePath: string): Response {
	const stats = statSync(filePath);
	const etag = `W/"${stats.size.toString(36)}-${Math.floor(stats.mtimeMs).toString(36)}"`;
	const headers: Record<string, string> = {
		'Cache-Control': cacheControlFor(urlPath),
		ETag: etag,
		Vary: 'Accept-Encoding'
	};

	if (request.headers.get('if-none-match') === etag) {
		return new Response(null, { status: 304, headers });
	}

	const original = Bun.file(filePath);
	headers['Content-Type'] = original.type || 'application/octet-stream';

	const encoding = pickEncoding(request.headers.get('accept-encoding'), availableEncodings(filePath));
	if (encoding) {
		headers['Content-Encoding'] = encoding;
		return new Response(Bun.file(filePath + SUFFIX[encoding]), { headers });
	}
	return new Response(original, { headers });
}

/** The SPA shell (`index.html`), always revalidated so a release is picked up at once. */
export function serveIndexHtml(request: Request, html: string, etag: string): Response {
	const headers = { 'Cache-Control': REVALIDATE, ETag: etag, 'Content-Type': 'text/html; charset=utf-8' };
	if (request.headers.get('if-none-match') === etag) {
		return new Response(null, { status: 304, headers });
	}
	return new Response(html, { headers });
}
