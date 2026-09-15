/**
 * Integration tests for the note image routes.
 *
 * The route reads the request body as a bounded stream rather than buffering
 * it, sniffs the type from the bytes instead of trusting the client, and stores
 * a path relative to the data dir. Each of those is load-bearing and silent
 * when broken — a buffered body only shows up as memory growth under a hostile
 * client, and an absolute path only shows up after the data dir moves — so they
 * are pinned here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { notesImagesRoute } from './notes-images';
import { authQueries } from '../database/queries';
import { hashToken } from '../auth/tokens';
import { projectQueries } from '../database/queries/project-queries';
import { noteQueries, noteCollectionQueries, noteImageQueries } from '../database/queries/note-queries';
import { initializeDatabase, closeDatabase } from '../database';
import { getCollectionNotesDir, resolveNoteImagePath } from '../notes/storage';

// Smallest valid GIF89a — `file-type` recognises it from the header alone.
const GIF_BYTES = new Uint8Array([
	0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff, 0xff,
	0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
	0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b
]);

let userId: string;
let token: string;
let projectId: string;
let collectionId: string;
let noteId: string;

function uploadRequest(body: BodyInit, fileName: string, declaredSize: number, bearer = token): Request {
	const url = new URL('http://localhost/api/notes/images/upload');
	url.searchParams.set('noteId', noteId);
	url.searchParams.set('fileName', fileName);
	url.searchParams.set('fileSize', String(declaredSize));
	return new Request(url.toString(), {
		method: 'POST',
		body,
		headers: { authorization: `Bearer ${bearer}` }
	});
}

beforeAll(async () => {
	await initializeDatabase();

	userId = randomUUID();
	authQueries.createUser({
		id: userId,
		name: 'Notes Test User',
		color: '#000000',
		avatar: 'test',
		role: 'admin',
		personal_access_token_hash: null,
		created_at: new Date().toISOString()
	});

	token = randomUUID();
	authQueries.createSession({
		id: randomUUID(),
		user_id: userId,
		token_hash: hashToken(token),
		expires_at: new Date(Date.now() + 86_400_000).toISOString(),
		created_at: new Date().toISOString(),
		last_active_at: new Date().toISOString(),
		user_agent: null,
		ip_address: null,
		source: null
	});

	const project = projectQueries.create({
		name: 'Notes Test Project',
		path: `/tmp/notes-test-project-${randomUUID()}`,
		created_at: new Date().toISOString(),
		last_opened_at: new Date().toISOString()
	});
	projectId = project.id;
	projectQueries.addUserProject(userId, projectId);

	collectionId = noteCollectionQueries.create({
		name: 'General',
		scope: 'project',
		projectId,
		createdBy: userId
	}).id;
	noteId = noteQueries.create({ collectionId, content: 'body', createdBy: userId }).id;
});

afterAll(async () => {
	await rm(getCollectionNotesDir(collectionId), { recursive: true, force: true });
	authQueries.deleteSessionsByUserId(userId);
	authQueries.deleteUser(userId);
	projectQueries.deleteProject(projectId);
	closeDatabase();
});

describe('POST /api/notes/images/upload', () => {
	it('stores an accepted image at a path relative to the data dir', async () => {
		const res = await notesImagesRoute.handle(
			uploadRequest(GIF_BYTES, 'holiday photo.gif', GIF_BYTES.length)
		);
		expect(res.status).toBe(200);

		const body = (await res.json()) as { image: { id: string; storage_path: string; mime_type: string } };
		expect(body.image.mime_type).toBe('image/gif');
		// Relative + POSIX: an absolute path here would break the moment
		// CLOPEN_DATA_DIR changes or the data dir is copied to another machine.
		// The space in the uploaded name is sanitized away.
		expect(body.image.storage_path).toMatch(
			new RegExp(`^notes/${collectionId}/${noteId}/[0-9a-f-]{36}-holiday_photo\\.gif$`)
		);

		const absolute = resolveNoteImagePath(body.image.storage_path);
		expect(absolute).not.toBeNull();
		expect(await Bun.file(absolute!).exists()).toBe(true);
	});

	it('rejects a non-image announced with an image file name, and keeps no file', async () => {
		const before = noteImageQueries.listByNote(noteId).length;
		const payload = new TextEncoder().encode('<svg onload=alert(1)></svg>'.padEnd(5000, ' '));

		const res = await notesImagesRoute.handle(uploadRequest(payload, 'payload.png', payload.length));
		expect(res.status).toBe(400);
		expect(await res.text()).toContain('Unsupported image type');
		expect(noteImageQueries.listByNote(noteId).length).toBe(before);
	});

	it('stops reading once a body exceeds the size it declared', async () => {
		// A client that under-declares its size is how an unbounded read turns
		// into "one project member decides this process's memory ceiling".
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(64 * 1024));
				controller.enqueue(new Uint8Array(64 * 1024));
				controller.close();
			}
		});
		const res = await notesImagesRoute.handle(uploadRequest(stream, 'big.png', 1024));
		expect(res.status).toBe(400);
		expect(await res.text()).toContain('more bytes than declared');
	});

	it('rejects a declared size over the 10 MB cap before reading anything', async () => {
		const res = await notesImagesRoute.handle(uploadRequest(GIF_BYTES, 'huge.gif', 11 * 1024 * 1024));
		expect(res.status).toBe(413);
	});

	it('requires a bearer token', async () => {
		const url = new URL('http://localhost/api/notes/images/upload');
		url.searchParams.set('noteId', noteId);
		url.searchParams.set('fileSize', String(GIF_BYTES.length));
		const res = await notesImagesRoute.handle(
			new Request(url.toString(), { method: 'POST', body: GIF_BYTES })
		);
		expect(res.status).toBe(401);
	});
});

describe('GET /api/notes/images/:id', () => {
	it('serves the stored bytes to a project member', async () => {
		const upload = await notesImagesRoute.handle(uploadRequest(GIF_BYTES, 'served.gif', GIF_BYTES.length));
		const { image } = (await upload.json()) as { image: { id: string } };

		const res = await notesImagesRoute.handle(
			new Request(`http://localhost/api/notes/images/${image.id}`, {
				headers: { authorization: `Bearer ${token}` }
			})
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/gif');
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(GIF_BYTES);
	});

	it('does not accept the session token from the query string', async () => {
		const upload = await notesImagesRoute.handle(uploadRequest(GIF_BYTES, 'query.gif', GIF_BYTES.length));
		const { image } = (await upload.json()) as { image: { id: string } };

		// A credential in a URL ends up in browser history, proxy logs and tunnel
		// edge logs, so the route must not honour one.
		const res = await notesImagesRoute.handle(
			new Request(`http://localhost/api/notes/images/${image.id}?token=${token}`)
		);
		expect(res.status).toBe(401);
	});

	it('denies a user who is not a member of the project the collection belongs to', async () => {
		const outsiderId = randomUUID();
		authQueries.createUser({
			id: outsiderId,
			name: 'Outsider',
			color: '#000000',
			avatar: 'test',
			role: 'member',
			personal_access_token_hash: null,
			created_at: new Date().toISOString()
		});
		const outsiderToken = randomUUID();
		authQueries.createSession({
			id: randomUUID(),
			user_id: outsiderId,
			token_hash: hashToken(outsiderToken),
			expires_at: new Date(Date.now() + 86_400_000).toISOString(),
			created_at: new Date().toISOString(),
			last_active_at: new Date().toISOString(),
			user_agent: null,
			ip_address: null,
			source: null
		});

		const upload = await notesImagesRoute.handle(uploadRequest(GIF_BYTES, 'private.gif', GIF_BYTES.length));
		const { image } = (await upload.json()) as { image: { id: string } };

		const res = await notesImagesRoute.handle(
			new Request(`http://localhost/api/notes/images/${image.id}`, {
				headers: { authorization: `Bearer ${outsiderToken}` }
			})
		);
		expect(res.status).toBe(403);

		authQueries.deleteSessionsByUserId(outsiderId);
		authQueries.deleteUser(outsiderId);
	});
});
