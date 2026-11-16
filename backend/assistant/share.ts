/**
 * A link the owner can open anywhere — instead of a local path or localhost.
 *
 * A running app (a port) gets a public HTTPS link through a Cloudflare quick
 * tunnel. A folder (a static site, a report with assets) is served first by a
 * small static server on a free port, then tunnelled the same way. Everything
 * started here is listed, so "stop everything" can close it.
 */

import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { tunnelKit } from '$backend/tunnel/tunnel-config';
import { isClopenPort } from '$backend/tunnel/public-origin';
import { debug } from '$shared/utils/logger';
import { mimeOf } from './files';

interface Shared {
	port: number;
	url: string;
	folder: string | null;
	server: ReturnType<typeof Bun.serve> | null;
	at: string;
}

const shares = new Map<number, Shared>();

function serveFolder(folder: string): ReturnType<typeof Bun.serve> {
	const root = resolve(folder);
	return Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch(request) {
			const url = new URL(request.url);
			let path = normalize(join(root, decodeURIComponent(url.pathname)));
			if (!path.startsWith(root)) return new Response('Not found', { status: 404 });
			if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
			if (!existsSync(path)) {
				// Single-page apps route everything to index.html.
				const index = join(root, 'index.html');
				if (!extname(url.pathname) && existsSync(index)) path = index;
				else return new Response('Not found', { status: 404 });
			}
			return new Response(Bun.file(path), { headers: { 'Content-Type': mimeOf(path) === 'application/octet-stream' ? 'text/plain' : mimeOf(path) } });
		}
	});
}

/** Share a port or a folder; returns the public link (and the local one). */
export async function shareLink(input: { port?: number; folder?: string }): Promise<{ url: string; localUrl: string }> {
	let port = input.port ?? null;
	let server: ReturnType<typeof Bun.serve> | null = null;
	if (!port) {
		if (!input.folder) throw new Error('Give a port (a running app) or a folder (files to serve).');
		const folder = resolve(input.folder.replace(/^~(?=\/|$)/, process.env.HOME ?? ''));
		if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`There is no folder at ${input.folder}.`);
		server = serveFolder(folder);
		port = server.port ?? null;
		if (!port) throw new Error('Could not start a server for that folder.');
	}
	// A link is for the work (an app, a folder) — never for Clopen itself.
	if (isClopenPort(port)) throw new Error('That is Clopen itself, which is never shared this way. Share the app or folder instead.');
	const existing = shares.get(port);
	if (existing) return { url: existing.url, localUrl: `http://localhost:${port}` };
	try {
		await tunnelKit.bin.ensure();
		const { publicUrl } = await tunnelKit.quick.start({ service: port, autoStopMinutes: 0 });
		shares.set(port, { port, url: publicUrl, folder: input.folder ?? null, server, at: new Date().toISOString() });
		return { url: publicUrl, localUrl: `http://localhost:${port}` };
	} catch (error) {
		server?.stop(true);
		throw error;
	}
}

export function listShares(): Array<{ port: number; url: string; folder: string | null; at: string }> {
	return [...shares.values()].map(({ port, url, folder, at }) => ({ port, url, folder, at }));
}

/** Close every link opened here (and the folder servers behind them). */
export async function stopAllShares(): Promise<number> {
	let stopped = 0;
	for (const share of shares.values()) {
		try {
			await tunnelKit.quick.stop(share.port);
		} catch (error) {
			debug.warn('assistant', `Stopping the link for port ${share.port} failed:`, error);
		}
		share.server?.stop(true);
		stopped += 1;
	}
	shares.clear();
	return stopped;
}
