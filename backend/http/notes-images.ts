/**
 * HTTP routes for note image upload / download.
 *
 * Storage: DATA_DIR/notes/<projectId>/<noteId>/<imageId>-<sanitizedName>
 * Auth: Bearer token + project access via note.project_id
 */

import { Elysia } from 'elysia';
import { join, basename } from 'node:path';
import { mkdir, stat, unlink } from 'node:fs/promises';

import { getClopenDir } from '../utils/paths';
import { authenticateRequest, type AuthIdentity } from './bearer-auth';
import { noteQueries, noteImageQueries } from '../database/queries/note-queries';
import { projectQueries } from '../database/queries/project-queries';
import { fileTypeFromBuffer } from 'file-type';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function sanitizeFileName(name: string): string {
	const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
	return base.slice(0, 120) || 'image';
}

function notesDir(projectId: string, noteId: string): string {
	return join(getClopenDir(), 'notes', projectId, noteId);
}

export const notesImagesRoute = new Elysia()
	.post('/api/notes/images/upload', async ({ request, query }) => {
		let identity: AuthIdentity;
		try {
			identity = authenticateRequest(request);
		} catch (error) {
			const status = (error as { status?: number }).status ?? 401;
			const message = error instanceof Error ? error.message : 'Unauthorized';
			return new Response(message, { status });
		}

		const noteId = typeof query.noteId === 'string' ? query.noteId : '';
		const fileNameParam = typeof query.fileName === 'string' ? query.fileName : 'image';
		const fileSizeParam = typeof query.fileSize === 'string' ? Number(query.fileSize) : NaN;

		if (!noteId) return new Response('Missing noteId', { status: 400 });
		if (!Number.isFinite(fileSizeParam) || fileSizeParam <= 0) {
			return new Response('Invalid fileSize', { status: 400 });
		}
		if (fileSizeParam > MAX_IMAGE_SIZE) {
			return new Response(`File too large. Max ${MAX_IMAGE_SIZE} bytes`, { status: 413 });
		}

		const note = noteQueries.getRawById(noteId);
		if (!note) return new Response('Note not found', { status: 404 });

		const hasAccess = projectQueries.userHasProject(identity.userId, note.project_id);
		if (!hasAccess) return new Response('Access denied', { status: 403 });

		if (!request.body) return new Response('Request body is empty', { status: 400 });

		// Read body into buffer for mime sniff + size check
		const buffer = Buffer.from(await request.arrayBuffer());
		if (buffer.length !== fileSizeParam) {
			// Allow small mismatch due to client, but enforce max
			if (buffer.length > MAX_IMAGE_SIZE) return new Response('File too large', { status: 413 });
		}
		if (buffer.length > MAX_IMAGE_SIZE) return new Response('File too large', { status: 413 });

		const detected = await fileTypeFromBuffer(buffer);
		const mime = detected?.mime ?? '';
		if (!ALLOWED_MIMES.has(mime)) {
			return new Response(`Unsupported image type. Allowed: ${Array.from(ALLOWED_MIMES).join(', ')}`, { status: 400 });
		}

		const sanitized = sanitizeFileName(fileNameParam);
		const imageId = crypto.randomUUID();
		const dir = notesDir(note.project_id, noteId);
		await mkdir(dir, { recursive: true });
		const storagePath = join(dir, `${imageId}-${sanitized}`);
		const tempPath = `${storagePath}.${crypto.randomUUID()}.partial`;

		try {
			await Bun.write(tempPath, buffer);
			await Bun.file(tempPath).exists(); // ensure written
			// Atomic move
			const { rename } = await import('node:fs/promises');
			await rename(tempPath, storagePath);
		} catch (error) {
			try { await unlink(tempPath); } catch { /* ignore */ }
			return new Response(error instanceof Error ? error.message : 'Failed to save image', { status: 500 });
		}

		const record = noteImageQueries.create({
			noteId,
			fileName: sanitized,
			mimeType: mime,
			size: buffer.length,
			storagePath
		});

		return Response.json({
			image: record,
			url: `/api/notes/images/${record.id}`
		});
	})

	.get('/api/notes/images/:id', async ({ request, params, query }) => {
		let identity: AuthIdentity;
		// Allow token via query param for <img src> (browser cannot set Authorization header)
		const queryToken = typeof (query as Record<string, unknown>).token === 'string' ? (query as Record<string, string>).token : '';
		if (queryToken) {
			try {
				const { hashToken } = await import('../auth/tokens');
				const { authQueries } = await import('../database/queries');
				const session = authQueries.getSessionByTokenHash(hashToken(queryToken));
				if (session && new Date(session.expires_at) >= new Date()) {
					const user = authQueries.getUserById(session.user_id);
					if (user) {
						authQueries.updateLastActive(session.id);
						identity = { userId: user.id, role: user.role };
					} else {
						throw Object.assign(new Error('User not found'), { status: 401 });
					}
				} else {
					throw Object.assign(new Error('Invalid token'), { status: 401 });
				}
			} catch (error) {
				const status = (error as { status?: number }).status ?? 401;
				const message = error instanceof Error ? error.message : 'Unauthorized';
				return new Response(message, { status });
			}
		} else {
			try {
				identity = authenticateRequest(request);
			} catch (error) {
				const status = (error as { status?: number }).status ?? 401;
				const message = error instanceof Error ? error.message : 'Unauthorized';
				return new Response(message, { status });
			}
		}

		const id = (params as { id: string }).id;
		const img = noteImageQueries.getById(id);
		if (!img) return new Response('Image not found', { status: 404 });

		const note = noteQueries.getRawById(img.note_id);
		if (!note) return new Response('Image not found', { status: 404 });

		const hasAccess = projectQueries.userHasProject(identity.userId, note.project_id);
		if (!hasAccess) return new Response('Access denied', { status: 403 });

		const stats = await stat(img.storage_path).catch(() => null);
		if (!stats) return new Response('File not found', { status: 404 });

		const file = Bun.file(img.storage_path);
		return new Response(file.stream(), {
			headers: {
				'Content-Type': img.mime_type,
				'Content-Length': String(stats.size),
				'Cache-Control': 'private, max-age=3600'
			}
		});
	});
