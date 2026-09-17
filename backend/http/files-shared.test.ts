/**
 * Integration tests for the public file-share route.
 *
 * `GET /api/files/shared?share=<token>` serves exactly the file its token was
 * minted for — no session, no path parameter — so the token binding (not just
 * the status code) is asserted here. Creation-time access control is exercised
 * too: a path outside the caller's projects must not be shareable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { filesSharedRoute } from './files-shared';
import { createFileShareLink, resolveFileShareLink, revokeFileShareLink } from '../files/file-shares';
import { authQueries } from '../database/queries';
import { hashToken } from '../auth/tokens';
import { projectQueries } from '../database/queries/project-queries';
import { initializeDatabase, closeDatabase } from '../database';

const TEST_DIR = join(import.meta.dir, '.test-shared-integration');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');
const OUTSIDE_DIR = join(TEST_DIR, 'outside');

let testUserId: string;
let testProjectId: string;

function createMockSharedRequest(share: string | null, headers?: Record<string, string>): Request {
	const url = new URL('http://localhost/api/files/shared');
	if (share !== null) url.searchParams.set('share', share);
	return new Request(url.toString(), { method: 'GET', headers });
}

beforeAll(async () => {
	await initializeDatabase();

	await mkdir(TEST_WORKSPACE, { recursive: true });
	await mkdir(OUTSIDE_DIR, { recursive: true });

	testUserId = randomUUID();
	authQueries.createUser({
		id: testUserId,
		name: 'Share Test User',
		color: '#000000',
		avatar: 'test',
		role: 'member',
		personal_access_token_hash: null,
		created_at: new Date().toISOString()
	});

	const project = projectQueries.create({
		name: 'Share Test Project',
		path: TEST_WORKSPACE,
		created_at: new Date().toISOString(),
		last_opened_at: new Date().toISOString()
	});
	testProjectId = project.id;
	projectQueries.addUserProject(testUserId, testProjectId);
});

afterAll(async () => {
	authQueries.deleteSessionsByUserId(testUserId);
	authQueries.deleteUser(testUserId);
	projectQueries.deleteProject(testProjectId);
	closeDatabase();
	await rm(TEST_DIR, { recursive: true, force: true });
});

describe('File share links', () => {
	it('serves the shared file inline with a computable length', async () => {
		const content = 'shared-hello'.repeat(1000);
		const filePath = join(TEST_WORKSPACE, 'shared notes.txt');
		await writeFile(filePath, content);

		const { shareToken } = await createFileShareLink(filePath, 'member', testUserId);
		const response = await filesSharedRoute.handle(createMockSharedRequest(shareToken));

		expect(response.status).toBe(200);
		expect(response.headers.get('content-length')).toBe(String(content.length));
		expect(response.headers.get('content-disposition')).toBe(
			"inline; filename*=UTF-8''shared%20notes.txt"
		);
		expect(await response.text()).toBe(content);
	});

	it('expires after the first successful open', async () => {
		const filePath = join(TEST_WORKSPACE, 'one-time.txt');
		await writeFile(filePath, 'open me once');
		const { shareToken } = await createFileShareLink(filePath, 'member', testUserId);

		const first = await filesSharedRoute.handle(createMockSharedRequest(shareToken));
		expect(first.status).toBe(200);
		expect(await first.text()).toBe('open me once');

		// Copy-paste / reopen / rescan of the same link must not show the file.
		const second = await filesSharedRoute.handle(createMockSharedRequest(shareToken));
		expect(second.status).toBe(410);
		expect(await second.text()).toContain('Link sudah digunakan atau sudah kedaluwarsa');

		const third = await filesSharedRoute.handle(createMockSharedRequest(shareToken));
		expect(third.status).toBe(410);
	});

	it('serves byte ranges (206) so video/audio can stream, seek and replay', async () => {
		const content = '0123456789abcdef';
		const filePath = join(TEST_WORKSPACE, 'clip.mp4');
		await writeFile(filePath, content);
		const { shareToken } = await createFileShareLink(filePath, 'member', testUserId);

		const part = await filesSharedRoute.handle(
			createMockSharedRequest(shareToken, { range: 'bytes=0-4' })
		);
		expect(part.status).toBe(206);
		expect(part.headers.get('content-range')).toBe(`bytes 0-4/${content.length}`);
		expect(part.headers.get('accept-ranges')).toBe('bytes');
		expect(part.headers.get('content-length')).toBe('5');
		expect(await part.text()).toBe('01234');

		const tail = await filesSharedRoute.handle(
			createMockSharedRequest(shareToken, { range: 'bytes=-4' })
		);
		expect(tail.status).toBe(206);
		expect(await tail.text()).toBe('cdef');
	});

	it('keeps the open player streaming after the single use, but blocks reopen', async () => {
		const content = '0123456789abcdef';
		const filePath = join(TEST_WORKSPACE, 'movie.mp4');
		await writeFile(filePath, content);
		const { shareToken } = await createFileShareLink(filePath, 'member', testUserId);

		// The one open: full body, token burned.
		const first = await filesSharedRoute.handle(createMockSharedRequest(shareToken));
		expect(first.status).toBe(200);
		expect(first.headers.get('accept-ranges')).toBe('bytes');

		// Same player's seek/replay (range requests) still served…
		const seek = await filesSharedRoute.handle(
			createMockSharedRequest(shareToken, { range: 'bytes=4-9' })
		);
		expect(seek.status).toBe(206);
		expect(await seek.text()).toBe('456789');

		// …while copy-paste / reopen / reload (a full GET) is gone.
		const reopen = await filesSharedRoute.handle(createMockSharedRequest(shareToken));
		expect(reopen.status).toBe(410);
		expect(await reopen.text()).toContain('Link sudah digunakan atau sudah kedaluwarsa');
	});

	it('answers 416 for unsatisfiable ranges without burning the single use', async () => {
		const content = '0123456789';
		const filePath = join(TEST_WORKSPACE, 'short.mp4');
		await writeFile(filePath, content);
		const { shareToken } = await createFileShareLink(filePath, 'member', testUserId);

		const over = await filesSharedRoute.handle(
			createMockSharedRequest(shareToken, { range: `bytes=${content.length}-` })
		);
		expect(over.status).toBe(416);
		expect(over.headers.get('content-range')).toBe(`bytes */${content.length}`);

		// The failed range did not count as the one open.
		const open = await filesSharedRoute.handle(createMockSharedRequest(shareToken));
		expect(open.status).toBe(200);
	});

	it('scopes one-time use per file: using one link leaves others alive', async () => {
		const fileA = join(TEST_WORKSPACE, 'file-a.txt');
		const fileB = join(TEST_WORKSPACE, 'file-b.txt');
		await writeFile(fileA, 'content-a');
		await writeFile(fileB, 'content-b');
		const { shareToken: tokenA } = await createFileShareLink(fileA, 'member', testUserId);
		const { shareToken: tokenB } = await createFileShareLink(fileB, 'member', testUserId);

		expect((await filesSharedRoute.handle(createMockSharedRequest(tokenA))).status).toBe(200);
		expect((await filesSharedRoute.handle(createMockSharedRequest(tokenA))).status).toBe(410);

		const stillAlive = await filesSharedRoute.handle(createMockSharedRequest(tokenB));
		expect(stillAlive.status).toBe(200);
		expect(await stillAlive.text()).toBe('content-b');
	});

	it('resolves to the minted file even when the bytes change on disk', async () => {
		const filePath = join(TEST_WORKSPACE, 'moving.txt');
		await writeFile(filePath, 'v1');
		const { shareToken } = await createFileShareLink(filePath, 'member', testUserId);
		await writeFile(filePath, 'v2-longer');

		const response = await filesSharedRoute.handle(createMockSharedRequest(shareToken));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('v2-longer');
	});

	it('rejects unknown tokens as gone and a missing param as bad request', async () => {
		const unknown = await filesSharedRoute.handle(createMockSharedRequest('clp_fsh_' + '0'.repeat(48)));
		expect(unknown.status).toBe(410);

		const missing = await filesSharedRoute.handle(createMockSharedRequest(null));
		expect(missing.status).toBe(400);
	});

	it('stops serving after revoke', async () => {
		const filePath = join(TEST_WORKSPACE, 'revoked.txt');
		await writeFile(filePath, 'bye');
		const { shareToken } = await createFileShareLink(filePath, 'member', testUserId);

		expect(revokeFileShareLink(shareToken, 'member', testUserId)).toBe(true);
		expect(() => resolveFileShareLink(shareToken)).toThrow();

		const response = await filesSharedRoute.handle(createMockSharedRequest(shareToken));
		expect(response.status).toBe(410);
	});

	it('refuses to share a directory or a path outside the caller projects', async () => {
		await expect(createFileShareLink(TEST_WORKSPACE, 'member', testUserId)).rejects.toThrow();

		const outside = join(OUTSIDE_DIR, 'secret.txt');
		await writeFile(outside, 'secret');
		await expect(createFileShareLink(outside, 'member', testUserId)).rejects.toThrow();
	});

	it('reports a deleted file as not found without burning the single use', async () => {
		const filePath = join(TEST_WORKSPACE, 'deleted.txt');
		await writeFile(filePath, 'gone soon');
		const { shareToken } = await createFileShareLink(filePath, 'member', testUserId);
		await rm(filePath);

		// A failed open never counts as the one use: still 404, never 410.
		expect((await filesSharedRoute.handle(createMockSharedRequest(shareToken))).status).toBe(404);
		expect((await filesSharedRoute.handle(createMockSharedRequest(shareToken))).status).toBe(404);
	});
});
