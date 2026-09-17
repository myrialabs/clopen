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

import { filesSharedRoute, FILE_SHARE_GONE_MESSAGE } from './files-shared';
import {
	createFileShareLink,
	peekFileShare,
	revokeFileShareLink,
	listFileShares,
	consumerFingerprint,
	describeShareLocation,
	sweepStaleFileShares,
	DEFAULT_FILE_SHARE_TTL_MINUTES
} from '../files/file-shares';
import { authQueries, fileShareQueries } from '../database/queries';
import { hashToken } from '../auth/tokens';
import { projectQueries } from '../database/queries/project-queries';
import { initializeDatabase, closeDatabase } from '../database';

const TEST_DIR = join(import.meta.dir, '.test-shared-integration');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');
const OUTSIDE_DIR = join(TEST_DIR, 'outside');

let testUserId: string;
let otherUserId: string;
let testProjectId: string;

function createMockSharedRequest(share: string | null, headers?: Record<string, string>): Request {
	const url = new URL('http://localhost/api/files/shared');
	if (share !== null) url.searchParams.set('share', share);
	return new Request(url.toString(), { method: 'GET', headers });
}

/** Same URL, but arriving from a different device than the one that opened it. */
function createStrangerRequest(share: string, headers?: Record<string, string>): Request {
	return createMockSharedRequest(share, {
		'user-agent': 'Some-Other-Device/1.0',
		'x-forwarded-for': '203.0.113.9',
		...headers
	});
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

	otherUserId = randomUUID();
	authQueries.createUser({
		id: otherUserId,
		name: 'Other Test User',
		color: '#111111',
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
	authQueries.deleteSessionsByUserId(otherUserId);
	authQueries.deleteUser(otherUserId);
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
		expect(await second.text()).toContain(FILE_SHARE_GONE_MESSAGE);

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
		expect(await reopen.text()).toContain(FILE_SHARE_GONE_MESSAGE);
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

	it('stops serving after revoke, which needs only the share id', async () => {
		const filePath = join(TEST_WORKSPACE, 'revoked.txt');
		await writeFile(filePath, 'bye');
		// The raw token is deliberately NOT passed to revoke: it only ever exists
		// in the browser that minted it, so a revoke keyed on it would be
		// unreachable the moment that view closes.
		const { shareId, shareToken } = await createFileShareLink(filePath, 'member', testUserId);

		expect(revokeFileShareLink(shareId, 'member', testUserId)).toBe(true);
		await expect(peekFileShare(shareToken, consumerFingerprint())).rejects.toThrow();

		const response = await filesSharedRoute.handle(createMockSharedRequest(shareToken));
		expect(response.status).toBe(410);

		// Revoking the same id twice is a no-op, not an error.
		expect(revokeFileShareLink(shareId, 'member', testUserId)).toBe(false);
	});

	it("refuses to revoke another member's link but lets an admin", async () => {
		const filePath = join(TEST_WORKSPACE, 'not-yours.txt');
		await writeFile(filePath, 'mine');
		const { shareId } = await createFileShareLink(filePath, 'member', testUserId);

		expect(() => revokeFileShareLink(shareId, 'member', otherUserId)).toThrow();
		expect(revokeFileShareLink(shareId, 'admin', otherUserId)).toBe(true);
	});

	it('lists live links with no token material, scoped by role', async () => {
		const filePath = join(TEST_WORKSPACE, 'listed.txt');
		await writeFile(filePath, 'listed');
		const { shareId } = await createFileShareLink(filePath, 'member', testUserId);

		const mine = listFileShares('member', testUserId);
		const entry = mine.find((s) => s.id === shareId);
		expect(entry).toBeDefined();
		expect(entry?.fileName).toBe('listed.txt');
		expect(entry?.createdByName).toBe('Share Test User');
		expect(entry?.consumedAt).toBeNull();
		// Nothing in the summary can rebuild the URL.
		expect(JSON.stringify(entry)).not.toContain('clp_fsh_');

		// Another member sees none of it; an admin sees it.
		expect(listFileShares('member', otherUserId).some((s) => s.id === shareId)).toBe(false);
		expect(listFileShares('admin', otherUserId).some((s) => s.id === shareId)).toBe(true);

		revokeFileShareLink(shareId, 'member', testUserId);
		expect(listFileShares('member', testUserId).some((s) => s.id === shareId)).toBe(false);
	});

	it('marks a link as opened in the list instead of hiding it', async () => {
		const filePath = join(TEST_WORKSPACE, 'opened.txt');
		await writeFile(filePath, 'read me');
		const { shareId, shareToken } = await createFileShareLink(filePath, 'member', testUserId);

		expect((await filesSharedRoute.handle(createMockSharedRequest(shareToken))).status).toBe(200);

		// Still listed, still revocable — the continuation window is live until
		// it is cut, and cutting it is the point of showing the row.
		const entry = listFileShares('member', testUserId).find((s) => s.id === shareId);
		expect(entry?.consumedAt).not.toBeNull();
		expect(revokeFileShareLink(shareId, 'member', testUserId)).toBe(true);
	});

	it('defaults to one-time and a five-minute deadline', async () => {
		const filePath = join(TEST_WORKSPACE, 'ttl.txt');
		await writeFile(filePath, 'tick');
		const { oneTime, expiresAt } = await createFileShareLink(filePath, 'member', testUserId);

		expect(DEFAULT_FILE_SHARE_TTL_MINUTES).toBe(5);
		expect(oneTime).toBe(true);
		const lifetime = new Date(expiresAt!).getTime() - Date.now();
		expect(lifetime).toBeGreaterThan(4 * 60_000);
		expect(lifetime).toBeLessThanOrEqual(5 * 60_000);
	});

	it('serves a reusable link over and over, counting the opens', async () => {
		const content = 'read me twice';
		const filePath = join(TEST_WORKSPACE, 'reusable.txt');
		await writeFile(filePath, content);
		const { shareId, shareToken } = await createFileShareLink(filePath, 'member', testUserId, {
			oneTime: false,
			expiresInMinutes: 15
		});

		for (const _ of [1, 2, 3]) {
			const response = await filesSharedRoute.handle(createMockSharedRequest(shareToken));
			expect(response.status).toBe(200);
			expect(await response.text()).toBe(content);
		}

		// Even a stranger — a reusable link is exactly that, on purpose.
		expect((await filesSharedRoute.handle(createStrangerRequest(shareToken))).status).toBe(200);

		const entry = listFileShares('member', testUserId).find((s) => s.id === shareId);
		expect(entry?.oneTime).toBe(false);
		expect(entry?.openCount).toBe(4);
		expect(entry?.lastOpenedAt).not.toBeNull();
		// Never burned, so no continuation-window marker.
		expect(entry?.consumedAt).toBeNull();
	});

	it('does not inflate the open count with range requests', async () => {
		const filePath = join(TEST_WORKSPACE, 'reusable-clip.mp4');
		await writeFile(filePath, '0123456789abcdef');
		const { shareId, shareToken } = await createFileShareLink(filePath, 'member', testUserId, {
			oneTime: false,
			expiresInMinutes: 15
		});

		expect((await filesSharedRoute.handle(createMockSharedRequest(shareToken))).status).toBe(200);
		for (const range of ['bytes=0-4', 'bytes=5-9', 'bytes=-4']) {
			expect((await filesSharedRoute.handle(createMockSharedRequest(shareToken, { range }))).status).toBe(206);
		}

		// One viewing is one open, not four.
		expect(listFileShares('member', testUserId).find((s) => s.id === shareId)?.openCount).toBe(1);
	});

	it('keeps a link without a deadline alive, and revoke is the only end', async () => {
		const filePath = join(TEST_WORKSPACE, 'no-deadline.txt');
		await writeFile(filePath, 'forever');
		const { shareId, shareToken } = await createFileShareLink(filePath, 'member', testUserId, {
			oneTime: false,
			expiresInMinutes: null
		});

		const entry = listFileShares('member', testUserId).find((s) => s.id === shareId);
		expect(entry?.expiresAt).toBeNull();
		expect((await filesSharedRoute.handle(createMockSharedRequest(shareToken))).status).toBe(200);

		// The stale sweep must never collect it — nothing says it is over.
		sweepStaleFileShares();
		expect((await filesSharedRoute.handle(createMockSharedRequest(shareToken))).status).toBe(200);

		expect(revokeFileShareLink(shareId, 'member', testUserId)).toBe(true);
		expect((await filesSharedRoute.handle(createMockSharedRequest(shareToken))).status).toBe(410);
	});

	it('rejects a deadline outside the allowed range', async () => {
		const filePath = join(TEST_WORKSPACE, 'bad-ttl.txt');
		await writeFile(filePath, 'nope');
		await expect(
			createFileShareLink(filePath, 'member', testUserId, { expiresInMinutes: 0 })
		).rejects.toThrow();
		await expect(
			createFileShareLink(filePath, 'member', testUserId, { expiresInMinutes: 60 * 24 * 365 })
		).rejects.toThrow();
	});

	it('reports where a shared file lives, with / separators everywhere', async () => {
		const nested = join(TEST_WORKSPACE, 'src', 'deep');
		await mkdir(nested, { recursive: true });
		const filePath = join(nested, 'index.ts');
		await writeFile(filePath, 'export {};');
		const { shareId } = await createFileShareLink(filePath, 'member', testUserId);

		const entry = listFileShares('member', testUserId).find((s) => s.id === shareId);
		expect(entry?.projectName).toBe('Share Test Project');
		expect(entry?.relativePath).toBe('src/deep/index.ts');
		expect(entry?.fileName).toBe('index.ts');

		// A path no project owns falls back to the absolute path.
		const orphan = describeShareLocation(join(OUTSIDE_DIR, 'loose.txt'));
		expect(orphan.projectName).toBeNull();
		expect(orphan.relativePath).toContain('loose.txt');
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

	it('persists the link outside process memory so a restart does not kill it', async () => {
		const filePath = join(TEST_WORKSPACE, 'durable.txt');
		await writeFile(filePath, 'still here');
		const { shareToken, expiresAt } = await createFileShareLink(filePath, 'member', testUserId);

		// The row — not a Map entry — is what a restarted server reads back.
		const row = fileShareQueries.getByHash(hashToken(shareToken));
		expect(row?.file_path).toBe(filePath);
		expect(row?.created_by).toBe(testUserId);
		expect(row?.consumed_at).toBeNull();
		expect(row?.expires_at).toBe(expiresAt);
		expect(row?.one_time).toBe(1);
	});

	it('keeps the continuation window with the client that opened the link', async () => {
		const content = '0123456789abcdef';
		const filePath = join(TEST_WORKSPACE, 'bound.mp4');
		await writeFile(filePath, content);
		const { shareToken } = await createFileShareLink(filePath, 'member', testUserId);

		// The recipient opens it: token burned, their player may keep seeking.
		expect((await filesSharedRoute.handle(createMockSharedRequest(shareToken))).status).toBe(200);
		const seek = await filesSharedRoute.handle(
			createMockSharedRequest(shareToken, { range: 'bytes=4-9' })
		);
		expect(seek.status).toBe(206);

		// Anyone else holding the leaked URL gets nothing — not even a range.
		const leaked = await filesSharedRoute.handle(
			createStrangerRequest(shareToken, { range: 'bytes=0-' })
		);
		expect(leaked.status).toBe(410);
		expect(await leaked.text()).toContain(FILE_SHARE_GONE_MESSAGE);
	});

	it('stops serving once the creator loses access to the path', async () => {
		const filePath = join(TEST_WORKSPACE, 'offboarded.txt');
		await writeFile(filePath, 'internal');
		const { shareToken } = await createFileShareLink(filePath, 'member', testUserId);

		projectQueries.removeUserProject(testUserId, testProjectId);
		try {
			const response = await filesSharedRoute.handle(createMockSharedRequest(shareToken));
			expect(response.status).toBe(410);
		} finally {
			projectQueries.addUserProject(testUserId, testProjectId);
		}

		// Access restored — the untouched single use is still there.
		expect((await filesSharedRoute.handle(createMockSharedRequest(shareToken))).status).toBe(200);
	});

	it('answers HEAD with metadata only, without spending the single use', async () => {
		const content = 'probe me';
		const filePath = join(TEST_WORKSPACE, 'probed.txt');
		await writeFile(filePath, content);
		const { shareToken } = await createFileShareLink(filePath, 'member', testUserId);

		const url = new URL('http://localhost/api/files/shared');
		url.searchParams.set('share', shareToken);
		const head = await filesSharedRoute.handle(new Request(url.toString(), { method: 'HEAD' }));
		expect(head.status).toBe(200);
		expect(head.headers.get('accept-ranges')).toBe('bytes');
		expect(await head.text()).toBe('');

		// The probe did not count as the one open.
		const open = await filesSharedRoute.handle(createMockSharedRequest(shareToken));
		expect(open.status).toBe(200);
		expect(await open.text()).toBe(content);
	});

	it('falls back to an extension MIME type from the real extension only', async () => {
		// A dotted DIRECTORY on the way down must not be read as the file's
		// extension — `path.extname` is separator-aware on every platform.
		const dottedDir = join(TEST_WORKSPACE, 'release.mp4');
		await mkdir(dottedDir, { recursive: true });
		const filePath = join(dottedDir, 'NOTES');
		await writeFile(filePath, 'no extension here');
		const { shareToken } = await createFileShareLink(filePath, 'member', testUserId);

		const response = await filesSharedRoute.handle(createMockSharedRequest(shareToken));
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/octet-stream');
	});
});
