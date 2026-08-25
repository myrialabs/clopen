/**
 * Integration tests for the file download route.
 *
 * The point of this route is a streamed body with a real `Content-Length` —
 * that header is what makes the browser's progress event computable, so it is
 * asserted here rather than left to be noticed missing in the UI. Access
 * control is exercised too: a path outside the caller's projects must not be
 * readable just because the token is valid.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { filesDownloadRoute } from './files-download';
import { authQueries } from '../database/queries';
import { hashToken } from '../auth/tokens';
import { projectQueries } from '../database/queries/project-queries';
import { initializeDatabase, closeDatabase } from '../database';

const TEST_DIR = join(import.meta.dir, '.test-download-integration');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');
const OUTSIDE_DIR = join(TEST_DIR, 'outside');

let testUserId: string;
let testToken: string;
let testProjectId: string;

function createMockDownloadRequest(path: string, token: string | null): Request {
	const url = new URL('http://localhost/api/files/download');
	url.searchParams.set('path', path);

	return new Request(url.toString(), {
		method: 'GET',
		headers: token ? { authorization: `Bearer ${token}` } : {}
	});
}

beforeAll(async () => {
	await initializeDatabase();

	await mkdir(TEST_WORKSPACE, { recursive: true });
	await mkdir(OUTSIDE_DIR, { recursive: true });

	testUserId = randomUUID();
	authQueries.createUser({
		id: testUserId,
		name: 'Test User',
		color: '#000000',
		avatar: 'test',
		role: 'member',
		personal_access_token_hash: null,
		created_at: new Date().toISOString()
	});

	testToken = randomUUID();
	authQueries.createSession({
		id: randomUUID(),
		user_id: testUserId,
		token_hash: hashToken(testToken),
		expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
		created_at: new Date().toISOString(),
		last_active_at: new Date().toISOString(),
		user_agent: null,
		ip_address: null,
		source: null
	});

	const project = projectQueries.create({
		name: 'Test Project',
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

describe('File download route', () => {
	it('streams the file with a computable length and an attachment name', async () => {
		const content = 'x'.repeat(10000);
		const filePath = join(TEST_WORKSPACE, 'report card.txt');
		await writeFile(filePath, content);

		const response = await filesDownloadRoute.handle(createMockDownloadRequest(filePath, testToken));

		expect(response.status).toBe(200);
		// The client's progress bar prefers this over the size it already knows,
		// so a file that grew since the listing still reports an honest total.
		expect(response.headers.get('content-length')).toBe(String(content.length));
		expect(response.headers.get('content-disposition')).toBe(
			"attachment; filename*=UTF-8''report%20card.txt"
		);
		expect(await response.text()).toBe(content);
	});

	it('preserves bytes exactly for binary content', async () => {
		const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
		const filePath = join(TEST_WORKSPACE, 'blob.bin');
		await writeFile(filePath, bytes);

		const response = await filesDownloadRoute.handle(createMockDownloadRequest(filePath, testToken));

		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
	});

	it('rejects a path outside the caller projects', async () => {
		const filePath = join(OUTSIDE_DIR, 'secret.txt');
		await writeFile(filePath, 'secret');

		const response = await filesDownloadRoute.handle(createMockDownloadRequest(filePath, testToken));

		expect(response.status).toBe(403);
	});

	it('rejects an unauthenticated request', async () => {
		const filePath = join(TEST_WORKSPACE, 'open.txt');
		await writeFile(filePath, 'hello');

		const response = await filesDownloadRoute.handle(createMockDownloadRequest(filePath, null));

		expect(response.status).toBe(401);
	});

	it('reports a missing file as 404 and a directory as 400', async () => {
		const missing = await filesDownloadRoute.handle(
			createMockDownloadRequest(join(TEST_WORKSPACE, 'nope.txt'), testToken)
		);
		expect(missing.status).toBe(404);

		const directory = await filesDownloadRoute.handle(
			createMockDownloadRequest(TEST_WORKSPACE, testToken)
		);
		expect(directory.status).toBe(400);
	});
});
