/**
 * Integration tests for file upload race condition fix.
 *
 * These tests verify that the atomic hard-link approach prevents race
 * conditions when multiple uploads target the same file name by calling
 * the actual filesUploadRoute handler with mock HTTP requests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { filesUploadRoute } from './files-upload';
import { authQueries } from '../database/queries';
import { hashToken } from '../auth/tokens';
import { projectQueries } from '../database/queries/project-queries';
import { initializeDatabase, closeDatabase } from '../database';

const TEST_DIR = join(import.meta.dir, '.test-upload-integration');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');

let testUserId: string;
let testToken: string;
let testProjectId: string;

/**
 * Helper to create a mock upload request with proper authentication and parameters.
 */
function createMockUploadRequest(
	file: File,
	targetPath: string,
	fileName: string,
	token: string
): Request {
	const url = new URL('http://localhost/api/files/upload');
	url.searchParams.set('targetPath', targetPath);
	url.searchParams.set('fileName', fileName);
	url.searchParams.set('fileSize', String(file.size));

	return new Request(url.toString(), {
		method: 'POST',
		body: file,
		headers: {
			'authorization': `Bearer ${token}`
		}
	});
}

beforeAll(async () => {
	// Initialize database
	await initializeDatabase();

	// Create test directory structure
	await mkdir(TEST_WORKSPACE, { recursive: true });

	// Create test user
	testUserId = randomUUID();
	authQueries.createUser({
		id: testUserId,
		name: 'Test User',
		color: '#000000',
		avatar: 'test',
		role: 'admin',
		personal_access_token_hash: null,
		created_at: new Date().toISOString()
	});

	// Create test session
	testToken = randomUUID();
	const sessionId = randomUUID();
	const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours
	authQueries.createSession({
		id: sessionId,
		user_id: testUserId,
		token_hash: hashToken(testToken),
		expires_at: expiresAt,
		created_at: new Date().toISOString(),
		last_active_at: new Date().toISOString()
	});

	// Create test project
	const project = projectQueries.create({
		name: 'Test Project',
		path: TEST_WORKSPACE,
		created_at: new Date().toISOString(),
		last_opened_at: new Date().toISOString()
	});
	testProjectId = project.id;

	// Link user to project
	projectQueries.addUserProject(testUserId, testProjectId);
});

afterAll(async () => {
	// Clean up database
	authQueries.deleteSessionsByUserId(testUserId);
	authQueries.deleteUser(testUserId);
	projectQueries.deleteProject(testProjectId);

	// Close database
	closeDatabase();

	// Clean up filesystem
	await rm(TEST_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
	// Clean workspace between tests
	await rm(TEST_WORKSPACE, { recursive: true, force: true });
	await mkdir(TEST_WORKSPACE, { recursive: true });
});

describe('File upload integration tests', () => {
	it('concurrent uploads of same file - link-based exclusive create prevents overwrite', async () => {
		const file1 = new File(['content from upload 1'], 'test.txt', { type: 'text/plain' });
		const file2 = new File(['content from upload 2'], 'test.txt', { type: 'text/plain' });

		// Create mock requests
		const request1 = createMockUploadRequest(file1, TEST_WORKSPACE, 'test.txt', testToken);
		const request2 = createMockUploadRequest(file2, TEST_WORKSPACE, 'test.txt', testToken);

		// Fire both concurrently
		const [response1, response2] = await Promise.all([
			filesUploadRoute.handle(request1),
			filesUploadRoute.handle(request2)
		]);

		// Exactly one 200, one 409
		const statuses = [response1.status, response2.status].sort();
		expect(statuses).toEqual([200, 409]);

		// Winner's content is on disk (not empty)
		const finalPath = join(TEST_WORKSPACE, 'test.txt');
		const content = await readFile(finalPath, 'utf-8');
		expect(content).toMatch(/content from upload [12]/);
		expect(content.length).toBeGreaterThan(0); // Not empty placeholder
	});

	it('atomic link-based create prevents race', async () => {
		const file = new File(['test content'], 'atomic.txt', { type: 'text/plain' });

		// First upload succeeds
		const request1 = createMockUploadRequest(file, TEST_WORKSPACE, 'atomic.txt', testToken);
		const response1 = await filesUploadRoute.handle(request1);
		expect(response1.status).toBe(200);

		// Second upload fails immediately with 409
		const request2 = createMockUploadRequest(file, TEST_WORKSPACE, 'atomic.txt', testToken);
		const response2 = await filesUploadRoute.handle(request2);
		expect(response2.status).toBe(409);

		// File has first upload's content
		const finalPath = join(TEST_WORKSPACE, 'atomic.txt');
		const content = await readFile(finalPath, 'utf-8');
		expect(content).toBe('test content');
	});

	it('file appears atomically with full content (no partial-file window)', async () => {
		const largeContent = 'x'.repeat(10000); // 10KB
		const file = new File([largeContent], 'large.txt', { type: 'text/plain' });

		const request = createMockUploadRequest(file, TEST_WORKSPACE, 'large.txt', testToken);
		const response = await filesUploadRoute.handle(request);
		expect(response.status).toBe(200);

		// File has full content, not empty
		const finalPath = join(TEST_WORKSPACE, 'large.txt');
		const content = await readFile(finalPath, 'utf-8');
		expect(content).toBe(largeContent);
		expect(content.length).toBe(10000);
	});
});

