/**
 * What a turn's snapshot is allowed to claim.
 *
 * A snapshot is a disk diff, and a disk diff sees every writer. Each case here
 * is a writer that used to land in the turn: the user's edit while the chat
 * sat idle, a `git merge` while the model worked (one real turn recorded 50
 * merged files as its own), another chat in the same folder, and the scan
 * itself failing to read a file and calling that a deletion. The other half
 * of each case is the edit that must survive — the turn's own write, and an
 * agent that commits its work.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { initializeDatabase, closeDatabase, getDatabase } from '../database/index';
import { projectQueries, sessionQueries, messageQueries } from '../database/queries';
import { execGit } from '../git/git-executor';
import { blobStore } from './blob-store';
import { snapshotService } from './snapshot-service';
import type { SessionScopedChanges } from '$shared/types/database/schema';
import type { UnifiedMessage } from '$shared/types/unified';

let root: string;
let projectId: string;

async function git(...args: string[]): Promise<string> {
	const result = await execGit(args, root);
	if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
	return result.stdout;
}

async function write(file: string, content: string): Promise<void> {
	await mkdir(path.dirname(path.join(root, file)), { recursive: true });
	await writeFile(path.join(root, file), content);
}

function newSession(): string {
	return sessionQueries.create({
		project_id: projectId,
		title: 'snapshot test',
		started_at: new Date().toISOString()
	} as Parameters<typeof sessionQueries.create>[0]).id;
}

function userMessage(sessionId: string): string {
	return messageQueries.create({
		session_id: sessionId,
		message: { type: 'user', content: [{ type: 'text', text: 'do it' }] } as unknown as UnifiedMessage
	}).id;
}

/**
 * Run `work` as one tool call of a session's turn: the call, whatever the
 * tool does, then its result — what the stream would feed the service.
 */
async function asTool(sessionId: string, id: string, work: () => Promise<void>): Promise<void> {
	snapshotService.observeEngineOutput(sessionId, { type: 'stream_event' });
	snapshotService.observeEngineOutput(sessionId, {
		type: 'assistant',
		content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'anything' } }]
	});
	await work();
	snapshotService.observeEngineOutput(sessionId, {
		type: 'user',
		content: [{ type: 'tool_result', toolUseId: id, content: '', isError: false }]
	});
}

/** Longer than the window slack, so two tool calls cannot overlap. */
const apart = () => new Promise((resolve) => setTimeout(resolve, 1500));

async function capture(sessionId: string): Promise<SessionScopedChanges> {
	const snapshot = await snapshotService.captureSnapshot(root, projectId, sessionId, userMessage(sessionId));
	const raw = snapshot.session_changes as unknown;
	return typeof raw === 'string' && raw ? JSON.parse(raw) as SessionScopedChanges : {};
}

/** Two writes in the same millisecond share an mtime, which the hash cache keys on. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

beforeAll(async () => {
	await initializeDatabase();
});

afterAll(() => {
	closeDatabase();
});

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'clopen-snapshot-'));
	await git('init', '-b', 'main', '.');
	await git('config', 'user.email', 'test@example.com');
	await git('config', 'user.name', 'Test');
	await git('config', 'commit.gpgsign', 'false');
	await write('a.ts', 'a\n');
	await write('b.ts', 'b\n');
	await git('add', '.');
	await git('commit', '-m', 'init');

	projectId = projectQueries.create({
		name: 'snapshot-test',
		path: root,
		created_at: new Date().toISOString(),
		last_opened_at: new Date().toISOString()
	}).id;
});

afterEach(async () => {
	const db = getDatabase();
	const sessions = `SELECT id FROM chat_sessions WHERE project_id = ?`;
	db.prepare(`DELETE FROM message_snapshots WHERE project_id = ?`).run(projectId);
	db.prepare(`DELETE FROM messages WHERE session_id IN (${sessions})`).run(projectId);
	db.prepare(`DELETE FROM chat_sessions WHERE project_id = ?`).run(projectId);
	projectQueries.deleteProject(projectId);
	await chmod(path.join(root, 'b.ts'), 0o644).catch(() => {});
	await rm(root, { recursive: true, force: true });
});

describe('turn baseline', () => {
	it('does not charge an idle-time edit to the next turn', async () => {
		const session = newSession();
		await snapshotService.beginTurn(root, projectId, session);
		await capture(session);

		await tick();
		await write('b.ts', 'edited by the user between turns\n');

		await snapshotService.beginTurn(root, projectId, session);
		await tick();
		await write('a.ts', 'a\nfrom the turn\n');
		const changes = await capture(session);

		expect(Object.keys(changes)).toEqual(['a.ts']);
	});
});

describe('git during a turn', () => {
	async function prepareBranch(): Promise<void> {
		await git('checkout', '-b', 'feature');
		await write('merged-1.ts', 'one\n');
		await write('merged-2.ts', 'two\n');
		await write('b.ts', 'b\nfrom feature\n');
		await git('add', '.');
		await git('commit', '-m', 'feature work');
		await git('checkout', 'main');
		await tick();
	}

	it('leaves out what a merge brought in, and keeps the turn\'s own edit', async () => {
		await prepareBranch();
		const session = newSession();
		await snapshotService.beginTurn(root, projectId, session);

		await tick();
		await write('a.ts', 'a\nfrom the turn\n');
		await git('merge', '--ff-only', 'feature');
		const changes = await capture(session);

		expect(Object.keys(changes)).toEqual(['a.ts']);
	});

	it('keeps only the turn\'s part of a file it edited on top of the merge', async () => {
		await prepareBranch();
		const session = newSession();
		await snapshotService.beginTurn(root, projectId, session);

		await git('merge', '--ff-only', 'feature');
		await tick();
		await write('b.ts', 'b\nfrom feature\nfrom the turn\n');
		const changes = await capture(session);

		expect(Object.keys(changes)).toEqual(['b.ts']);
		const before = (await blobStore.readBlob(changes['b.ts'].oldHash)).toString('utf8');
		expect(before).toBe('b\nfrom feature\n');
	});

	it('keeps work the agent committed during the turn', async () => {
		const session = newSession();
		await snapshotService.beginTurn(root, projectId, session);

		await tick();
		await write('a.ts', 'a\ncommitted by the agent\n');
		await git('commit', '-am', 'agent work');
		const changes = await capture(session);

		expect(Object.keys(changes)).toEqual(['a.ts']);
	});
});

describe('scan failures', () => {
	it('does not record an unreadable file as deleted', async () => {
		const session = newSession();
		await snapshotService.beginTurn(root, projectId, session);

		await tick();
		await write('a.ts', 'a\nfrom the turn\n');
		await write('b.ts', 'b\nchanged, then unreadable\n');
		await chmod(path.join(root, 'b.ts'), 0o000);
		const changes = await capture(session);

		expect(changes['b.ts']).toBeUndefined();
		expect(Object.keys(changes)).toEqual(['a.ts']);
	});

	it('does not record a file that grew past the size cap as deleted', async () => {
		const session = newSession();
		await snapshotService.beginTurn(root, projectId, session);

		await tick();
		await write('a.ts', 'a\nfrom the turn\n');
		await write('b.ts', 'x'.repeat(5 * 1024 * 1024 + 1));
		const changes = await capture(session);

		expect(Object.keys(changes)).toEqual(['a.ts']);
	});

	it('reads files with non-ASCII names', async () => {
		await write('café.ts', 'v1\n');
		await git('add', '.');
		await git('commit', '-m', 'unicode');

		const session = newSession();
		await snapshotService.beginTurn(root, projectId, session);
		await tick();
		await write('café.ts', 'v2\n');
		const changes = await capture(session);

		expect(Object.keys(changes)).toEqual(['café.ts']);
	});
});

describe('two chats in one folder', () => {
	it('hands each write to the chat whose tool was running, shell commands included', async () => {
		await write('sub/c.ts', 'c\n');
		await git('add', '.');
		await git('commit', '-m', 'sub');

		const mine = newSession();
		const theirs = newSession();
		await snapshotService.beginTurn(root, projectId, mine);
		await snapshotService.beginTurn(root, projectId, theirs);

		await asTool(mine, 'm1', () => write('a.ts', 'a\nmine, via a shell command\n'));
		await apart();
		await asTool(theirs, 't1', async () => {
			await write('b.ts', 'b\ntheirs\n');
			await rm(path.join(root, 'sub/c.ts'));
		});

		expect(Object.keys(await capture(mine))).toEqual(['a.ts']);
		expect(Object.keys(await capture(theirs)).sort()).toEqual(['b.ts', 'sub/c.ts']);
	});

	it('does not count a change twice when no tool of either chat was running', async () => {
		const first = newSession();
		const second = newSession();
		await snapshotService.beginTurn(root, projectId, first);
		await snapshotService.beginTurn(root, projectId, second);

		await tick();
		await write('a.ts', 'a\nwritten by a formatter\n');

		expect(Object.keys(await capture(first))).toEqual(['a.ts']);
		expect(await capture(second)).toEqual({});
		expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('a\nwritten by a formatter\n');
	});
});
