/**
 * Vite Dev Server Integration
 *
 * Embeds Vite as middleware inside the Elysia/Bun server.
 * Uses Vite's direct APIs (transformIndexHtml, transformRequest) for speed,
 * with Node.js compat middleware adapter only for Vite internals (HMR, pre-bundled deps).
 */

import { createServer as createViteServer, type ViteDevServer, type Connect } from 'vite';
import { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';

let vite: ViteDevServer | null = null;

const PUBLIC_DIR = resolve(process.cwd(), 'static');
const INDEX_PATH = resolve(process.cwd(), 'index.html');

// Safety timeout for the Node.js compat middleware adapter (ms).
// Prevents hanging if Vite middleware never calls res.end() or next().
const MIDDLEWARE_TIMEOUT = 10000;

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

export async function handleDevRequest(viteServer: ViteDevServer, request: Request): Promise<Response> {
	const url = new URL(request.url);
	const pathname = url.pathname;

	// 1. Static public files
	const publicFile = servePublicFile(pathname);
	if (publicFile) return publicFile;

	// 2. HTML / SPA routes
	if (isHtmlRequest(pathname)) {
		return serveHtml(viteServer, pathname);
	}

	// 3. Module requests (skip Vite internals like /__vite_hmr)
	if (!pathname.startsWith('/__')) {
		const moduleResponse = await serveModule(viteServer, pathname + url.search, request);
		if (moduleResponse) return moduleResponse;
	}

	// 4. Fallback: Vite connect middleware (for HMR, pre-bundled deps, etc.)
	const middlewareResponse = await pipeViteMiddleware(viteServer.middlewares, request);
	if (middlewareResponse) return middlewareResponse;

	return new Response('Not Found', { status: 404 });
}

// ============================================================================
// Static Public Files
// ============================================================================

function servePublicFile(pathname: string): Response | null {
	if (pathname === '/' || pathname.includes('..')) return null;

	const filePath = resolve(PUBLIC_DIR, pathname.slice(1));
	if (!filePath.startsWith(PUBLIC_DIR)) return null;

	// Use statSync to verify the path is a regular file, not a directory.
	// Bun.file().exists() returns inconsistent results for directories across
	// platforms (Linux/macOS/Windows) and Bun versions, which can cause
	// Response(Bun.file(directory)) to hang indefinitely.
	try {
		if (!statSync(filePath).isFile()) return null;
	} catch {
		return null;
	}

	const file = Bun.file(filePath);
	return new Response(file, {
		headers: {
			'Content-Type': file.type || 'application/octet-stream',
			'Cache-Control': 'public, max-age=3600'
		}
	});
}

// ============================================================================
// HTML / SPA
// ============================================================================

function isHtmlRequest(pathname: string): boolean {
	if (pathname === '/') return true;
	if (pathname.startsWith('/@') || pathname.startsWith('/__')) return false;
	if (pathname.startsWith('/node_modules/')) return false;
	const lastSegment = pathname.split('/').pop() || '';
	return !lastSegment.includes('.');
}

async function serveHtml(viteServer: ViteDevServer, pathname: string): Promise<Response> {
	const rawHtml = await Bun.file(INDEX_PATH).text();
	const html = await viteServer.transformIndexHtml(pathname, rawHtml);
	return new Response(html, {
		headers: { 'Content-Type': 'text/html; charset=utf-8' }
	});
}

// ============================================================================
// Module Requests
// ============================================================================

function getModuleContentType(url: string): string {
	const pathname = url.split('?')[0];
	// Raw CSS only when explicitly requested with ?direct (e.g. <link> tags).
	// CSS imported via JS is transformed to a JS module by Vite (for HMR).
	if (pathname.endsWith('.css') && url.includes('direct')) {
		return 'text/css';
	}
	return 'application/javascript';
}

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
// Vite Connect Middleware Adapter
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
 * Bridges Web API Request → Node.js IncomingMessage/ServerResponse → Web API Response.
 * Required because Vite's connect middleware uses the Node.js HTTP API.
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
				// Skip hop-by-hop headers — Bun sets correct Content-Length/Transfer-Encoding
				// based on the actual body. Forwarding stale values from ServerResponse
				// causes browser to wait for data that never arrives.
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
