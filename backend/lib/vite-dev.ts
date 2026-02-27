/**
 * Vite Dev Server Integration (Bun-optimized)
 *
 * Embeds Vite as middleware inside the Elysia/Bun server.
 *
 * Performance optimizations:
 * - HTML requests use vite.transformIndexHtml() directly (bypass Node compat layer)
 * - Module requests use vite.transformRequest() directly (bypass Node compat layer)
 * - Only edge cases (Vite internals, pre-bundled deps) go through middleware adapter
 *
 * Reliability:
 * - All async operations have timeouts to prevent hanging promises
 * - HTML has raw fallback if Vite transform hangs
 * - Middleware adapter has safety timeout
 */

import { createServer as createViteServer, type ViteDevServer, type Connect } from 'vite';
import { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';

let vite: ViteDevServer | null = null;

// Resolved paths (computed once at startup)
const PUBLIC_DIR = resolve(process.cwd(), 'static');
const INDEX_PATH = resolve(process.cwd(), 'index.html');

// Timeouts (ms)
const HTML_TRANSFORM_TIMEOUT = 5000;
const MODULE_TRANSFORM_TIMEOUT = 10000;
const MIDDLEWARE_TIMEOUT = 10000;

// ============================================================================
// Utilities
// ============================================================================

/**
 * Race a promise against a timeout. Returns null on timeout (never rejects).
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout>;
	return Promise.race([
		promise,
		new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })
	]).finally(() => clearTimeout(timer));
}

// ============================================================================
// Lifecycle
// ============================================================================

export async function initViteDev(): Promise<ViteDevServer> {
	vite = await createViteServer({
		configFile: './vite.config.ts',
		server: { middlewareMode: true },
		appType: 'spa'
	});

	return vite;
}

export function getViteDev(): ViteDevServer | null {
	return vite;
}

export async function closeViteDev(): Promise<void> {
	if (vite) {
		await vite.close();
		vite = null;
	}
}

// ============================================================================
// Main Request Handler
// ============================================================================

/**
 * Handle an HTTP request in dev mode.
 * Uses Vite's direct APIs for speed, middleware only as fallback.
 * All paths have timeouts to guarantee a response — never hangs.
 */
export async function handleDevRequest(viteServer: ViteDevServer, request: Request): Promise<Response> {
	const url = new URL(request.url);
	const pathname = url.pathname;

	// 1. Static public files — fast Bun.file() (no Vite overhead)
	const publicFile = await servePublicFile(pathname);
	if (publicFile) return publicFile;

	// 2. HTML / SPA routes — direct vite.transformIndexHtml() with timeout + fallback
	if (isHtmlRequest(pathname)) {
		const htmlResponse = await withTimeout(serveHtml(viteServer, pathname), HTML_TRANSFORM_TIMEOUT);
		if (htmlResponse) return htmlResponse;

		// Fallback: serve raw HTML without Vite transforms (HMR won't work but page loads)
		try {
			const rawHtml = await Bun.file(INDEX_PATH).text();
			return new Response(rawHtml, {
				headers: { 'Content-Type': 'text/html; charset=utf-8' }
			});
		} catch {
			// INDEX_PATH doesn't exist — fall through
		}
	}

	// 3. Module requests — direct vite.transformRequest() with timeout
	if (!pathname.startsWith('/__')) {
		const moduleResponse = await withTimeout(
			serveModule(viteServer, pathname + url.search, request),
			MODULE_TRANSFORM_TIMEOUT
		);
		if (moduleResponse) return moduleResponse;
	}

	// 4. Fallback: pipe through Vite's connect middleware (with safety timeout)
	const middlewareResponse = await pipeViteMiddleware(viteServer.middlewares, request);
	if (middlewareResponse) return middlewareResponse;

	return new Response('Not Found', { status: 404 });
}

// ============================================================================
// Fast Path: Public Files
// ============================================================================

/**
 * Try serving a static file from the public directory (static/).
 * Uses BunFile directly (not .stream()) so Bun sets Content-Length automatically,
 * preventing endless loading when the browser can't detect stream end.
 */
async function servePublicFile(pathname: string): Promise<Response | null> {
	if (pathname.includes('..')) return null;

	const filePath = resolve(PUBLIC_DIR, pathname.slice(1));
	if (!filePath.startsWith(PUBLIC_DIR)) return null;

	const file = Bun.file(filePath);
	if (!(await file.exists())) return null;

	return new Response(file, {
		headers: {
			'Content-Type': file.type || 'application/octet-stream',
			'Cache-Control': 'public, max-age=3600'
		}
	});
}

// ============================================================================
// Fast Path: HTML / SPA
// ============================================================================

/**
 * Check if a request is for an HTML page (root or SPA client-side route).
 */
function isHtmlRequest(pathname: string): boolean {
	if (pathname === '/') return true;
	if (pathname.startsWith('/@') || pathname.startsWith('/__')) return false;
	if (pathname.startsWith('/node_modules/')) return false;
	const lastSegment = pathname.split('/').pop() || '';
	return !lastSegment.includes('.');
}

/**
 * Serve transformed HTML directly via Vite's API.
 */
async function serveHtml(viteServer: ViteDevServer, pathname: string): Promise<Response> {
	const rawHtml = await Bun.file(INDEX_PATH).text();
	const html = await viteServer.transformIndexHtml(pathname, rawHtml);
	return new Response(html, {
		headers: { 'Content-Type': 'text/html; charset=utf-8' }
	});
}

// ============================================================================
// Fast Path: Module Requests
// ============================================================================

function getModuleContentType(url: string): string {
	const pathname = url.split('?')[0];
	// Only serve as raw CSS when explicitly requested with ?direct (e.g. <link> tags).
	// CSS imported via JS is always transformed to a JavaScript module by Vite
	// (for HMR / style injection), so it must be served as application/javascript.
	if (pathname.endsWith('.css') && url.includes('direct')) {
		return 'text/css';
	}
	return 'application/javascript';
}

/**
 * Try to serve a module using Vite's transformRequest API.
 */
async function serveModule(viteServer: ViteDevServer, url: string, request: Request): Promise<Response | null> {
	try {
		const result = await viteServer.transformRequest(url);
		if (!result) return null;

		if (result.etag) {
			const ifNoneMatch = request.headers.get('if-none-match');
			if (ifNoneMatch === result.etag) {
				return new Response(null, { status: 304 });
			}
		}

		const headers: Record<string, string> = {
			'Content-Type': getModuleContentType(url),
		};
		if (result.etag) {
			headers['ETag'] = result.etag;
		}

		return new Response(result.code, { headers });
	} catch {
		return null;
	}
}

// ============================================================================
// Fallback: Vite Connect Middleware Adapter (with safety timeout)
// ============================================================================

const MOCK_SOCKET = {
	remoteAddress: '127.0.0.1',
	remotePort: 0,
	remoteFamily: 'IPv4',
	encrypted: false,
	writable: true,
	readable: true,
	destroy() {},
	end() {},
	write() { return true; },
	on() { return this; },
	once() { return this; },
	off() { return this; },
	emit() { return false; },
	addListener() { return this; },
	removeListener() { return this; },
	setTimeout() { return this; },
	setNoDelay() { return this; },
	setKeepAlive() { return this; },
	ref() { return this; },
	unref() { return this; },
	address() { return { address: '127.0.0.1', family: 'IPv4', port: 0 }; }
};

/**
 * Pipe a request through Vite's connect middleware.
 * Has a safety timeout to prevent promises that never resolve
 * (e.g., middleware errors without calling res.end() or next()).
 */
function pipeViteMiddleware(
	middleware: Connect.Server,
	request: Request
): Promise<Response | null> {
	return new Promise((resolve) => {
		const url = new URL(request.url);

		const req = new IncomingMessage(MOCK_SOCKET as any);
		req.method = request.method;
		req.url = url.pathname + url.search;
		req.headers = request.headers.toJSON();
		req.push(null);

		const res = new ServerResponse(req);
		let ended = false;
		const chunks: Uint8Array[] = [];

		// Safety timeout — if middleware never calls res.end() or next(),
		// resolve with null to prevent hanging the HTTP response forever.
		const safetyTimer = setTimeout(() => {
			if (!ended) {
				ended = true;
				resolve(null);
			}
		}, MIDDLEWARE_TIMEOUT);

		function finalize() {
			if (ended) return;
			ended = true;
			clearTimeout(safetyTimer);

			const nodeHeaders = res.getHeaders();
			const h = new Headers();
			for (const key in nodeHeaders) {
				// Skip hop-by-hop headers — these are transport-level headers that
				// must NOT be forwarded through the adapter. Bun will set the correct
				// Content-Length and Transfer-Encoding based on the actual body.
				// Forwarding stale Content-Length from the Node.js ServerResponse
				// can cause a mismatch with the collected body, making the browser
				// wait for more data that never arrives (infinite loading spinner).
				const lower = key.toLowerCase();
				if (lower === 'transfer-encoding' || lower === 'content-length' ||
					lower === 'connection' || lower === 'keep-alive') continue;

				const v = nodeHeaders[key];
				if (v === undefined) continue;
				if (Array.isArray(v)) {
					for (let i = 0; i < v.length; i++) h.append(key, v[i]);
				} else {
					h.set(key, String(v));
				}
			}

			const body = chunks.length === 0
				? null
				: chunks.length === 1
					? chunks[0]
					: Buffer.concat(chunks);

			resolve(new Response(body, { status: res.statusCode, headers: h }));
		}

		res.write = function (chunk: any, encodingOrCb?: any, cb?: any): boolean {
			if (chunk != null) {
				chunks.push(
					typeof chunk === 'string'
						? Buffer.from(chunk, typeof encodingOrCb === 'string' ? encodingOrCb as BufferEncoding : 'utf-8')
						: chunk instanceof Uint8Array ? chunk : Buffer.from(chunk)
				);
			}
			const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
			if (typeof callback === 'function') callback();
			return true;
		};

		res.end = function (data?: any, encodingOrCb?: any, cb?: any): ServerResponse {
			if (ended) return res;

			if (typeof data === 'function') {
				data();
			} else {
				if (data != null) {
					chunks.push(
						typeof data === 'string'
							? Buffer.from(data, typeof encodingOrCb === 'string' ? encodingOrCb as BufferEncoding : 'utf-8')
							: data instanceof Uint8Array ? data : Buffer.from(data)
					);
				}
				const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
				if (typeof callback === 'function') callback();
			}

			finalize();
			return res;
		} as any;

		middleware(req as any, res as any, () => {
			if (!ended) {
				ended = true;
				clearTimeout(safetyTimer);
				resolve(null);
			}
		});
	});
}
