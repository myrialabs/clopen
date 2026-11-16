/**
 * Files Clopen sent the owner (screenshots, generated images, reports) —
 * served from its own data folder by id, to signed-in users only.
 * See `backend/assistant/files.ts`.
 */

import { Elysia } from 'elysia';
import { stat } from 'node:fs/promises';
import { authenticateRequest } from './bearer-auth';
import { mimeOf, sharedFilePath } from '../assistant/files';

export const assistantFilesRoute = new Elysia().get('/api/assistant/files/:id', async ({ request, params }) => {
	try {
		authenticateRequest(request);
	} catch (error) {
		const status = (error as { status?: number }).status ?? 401;
		return new Response(error instanceof Error ? error.message : 'Unauthorized', { status });
	}
	const path = sharedFilePath((params as { id: string }).id);
	if (!path) return new Response('File not found', { status: 404 });
	const stats = await stat(path).catch(() => null);
	if (!stats?.isFile()) return new Response('File not found', { status: 404 });
	const mime = mimeOf(path);
	return new Response(Bun.file(path).stream(), {
		headers: {
			// SVG and HTML are downloaded, never rendered inline: they can script.
			'Content-Type': mime === 'image/svg+xml' || mime === 'text/html' ? 'application/octet-stream' : mime,
			'Content-Length': String(stats.size),
			'Cache-Control': 'private, max-age=86400'
		}
	});
});
