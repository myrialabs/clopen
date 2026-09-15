/**
 * HTTP routes for note image upload / download.
 *
 * They sit next to the WebSocket router for the same reason the file routes do:
 * a base64 image on the socket costs a third more bytes and holds the whole
 * attachment in memory at both ends, while HTTP streams it.
 *
 * Storage: `<DATA_DIR>/notes/<collectionId>/<noteId>/<uuid>-<name>`, recorded
 * relative to the data dir — see `backend/notes/storage.ts`. The UUID prefix
 * only has to make the name unique within the note, so two uploads of
 * `screenshot.png` don't collide.
 *
 * Auth: `Authorization: Bearer <session-token>` on both routes, then the same
 * collection rule the WebSocket handlers use, resolved through the image's
 * note. The bytes must never be reachable under a weaker rule than the
 * metadata.
 */

import { Elysia } from 'elysia';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';

import { debug } from '$shared/utils/logger';
import { authenticateRequest, type AuthIdentity } from './bearer-auth';
import { noteQueries, noteCollectionQueries, noteImageQueries } from '../database/queries/note-queries';
import { canAccessCollection } from '../notes/access';
import {
	getNoteDir,
	noteImageRelPath,
	resolveNoteImagePath,
	sanitizeImageFileName
} from '../notes/storage';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Bytes `file-type` needs before it can name a format. Sniffing the content is
 * what makes the allow-list meaningful: a client-declared `Content-Type` is
 * just a string, and an SVG or HTML file announced as `image/png` would other-
 * wise be stored and later served back with a type the browser will script.
 */
const SNIFF_BYTES = 4100;

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

		if (!noteId) return new Response('Missing required query parameter: noteId', { status: 400 });
		if (!Number.isFinite(fileSizeParam) || fileSizeParam <= 0) {
			return new Response('Invalid fileSize query parameter', { status: 400 });
		}
		if (fileSizeParam > MAX_IMAGE_SIZE) {
			return new Response(`File too large. Max ${MAX_IMAGE_SIZE} bytes`, { status: 413 });
		}

		const note = noteQueries.getRawById(noteId);
		if (!note) return new Response('Note not found', { status: 404 });

		const collection = noteCollectionQueries.getById(note.collection_id);
		if (!collection || !canAccessCollection(identity.userId, collection)) {
			return new Response('Access denied', { status: 403 });
		}

		if (!request.body) return new Response('Request body is empty', { status: 400 });

		const sanitized = sanitizeImageFileName(fileNameParam);
		const storedName = `${crypto.randomUUID()}-${sanitized}`;
		const dir = getNoteDir(collection.id, noteId);
		await mkdir(dir, { recursive: true });
		const finalPath = join(dir, storedName);
		const tempPath = `${finalPath}.${crypto.randomUUID()}.partial`;

		// Stream to a temp file with a hard ceiling instead of buffering the body.
		// `fileSize` is a client claim: reading the whole request into memory first
		// would let one member of one project decide how much RAM this process
		// allocates, no matter what the query parameter said.
		const writer = Bun.file(tempPath).writer();
		const header: Uint8Array[] = [];
		let headerBytes = 0;
		let written = 0;

		const discardTemp = async () => {
			try { await writer.end(); } catch { /* best-effort */ }
			await unlink(tempPath).catch(() => {});
		};

		try {
			const reader = request.body.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value) continue;
				written += value.byteLength;
				if (written > fileSizeParam || written > MAX_IMAGE_SIZE) {
					await discardTemp();
					return new Response('Received more bytes than declared file size', { status: 400 });
				}
				if (headerBytes < SNIFF_BYTES) {
					// `slice` copies: the chunk is handed to the writer next and must
					// not be read again through a view once that buffer is recycled.
					header.push(value.slice(0, SNIFF_BYTES - headerBytes));
					headerBytes += Math.min(value.byteLength, SNIFF_BYTES - headerBytes);
				}
				writer.write(value);
			}
			await writer.end();
		} catch (error) {
			await discardTemp();
			debug.error('notes', 'Image upload stream failed:', error);
			return new Response('Failed to read upload', { status: 500 });
		}

		if (written !== fileSizeParam) {
			await unlink(tempPath).catch(() => {});
			return new Response(`Incomplete upload: received ${written} of ${fileSizeParam} bytes`, { status: 400 });
		}

		const detected = await fileTypeFromBuffer(Buffer.concat(header));
		const mime = detected?.mime ?? '';
		if (!ALLOWED_MIMES.has(mime)) {
			await unlink(tempPath).catch(() => {});
			return new Response(
				`Unsupported image type. Allowed: ${Array.from(ALLOWED_MIMES).join(', ')}`,
				{ status: 400 }
			);
		}

		try {
			// Same-directory rename is atomic on POSIX and Windows alike, so the
			// final path only ever appears with the complete file behind it.
			await rename(tempPath, finalPath);
		} catch (error) {
			await unlink(tempPath).catch(() => {});
			debug.error('notes', 'Failed to store note image:', error);
			return new Response('Failed to save image', { status: 500 });
		}

		const record = noteImageQueries.create({
			noteId,
			fileName: sanitized,
			mimeType: mime,
			size: written,
			storagePath: noteImageRelPath(collection.id, noteId, storedName)
		});

		return Response.json({ image: record, url: `/api/notes/images/${record.id}` });
	})

	.get('/api/notes/images/:id', async ({ request, params }) => {
		let identity: AuthIdentity;
		try {
			identity = authenticateRequest(request);
		} catch (error) {
			const status = (error as { status?: number }).status ?? 401;
			const message = error instanceof Error ? error.message : 'Unauthorized';
			return new Response(message, { status });
		}

		const img = noteImageQueries.getById((params as { id: string }).id);
		if (!img) return new Response('Image not found', { status: 404 });

		const collection = noteCollectionQueries.getForNote(img.note_id);
		if (!collection) return new Response('Image not found', { status: 404 });

		if (!canAccessCollection(identity.userId, collection)) {
			return new Response('Access denied', { status: 403 });
		}

		const absolute = resolveNoteImagePath(img.storage_path);
		if (!absolute) return new Response('File not found', { status: 404 });

		const stats = await stat(absolute).catch(() => null);
		if (!stats || !stats.isFile()) return new Response('File not found', { status: 404 });

		return new Response(Bun.file(absolute).stream(), {
			headers: {
				'Content-Type': img.mime_type,
				'Content-Length': String(stats.size),
				// Attachments are immutable — the id changes when the bytes do.
				'Cache-Control': 'private, max-age=3600'
			}
		});
	});
