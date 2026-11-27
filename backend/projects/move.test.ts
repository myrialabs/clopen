/**
 * Moving a project: the folder, the record, and everything keyed by the old
 * path go together — or nothing moves at all.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializeDatabase, closeDatabase, getDatabase } from '$backend/database';
import { memoryQueueQueries, projectQueries } from '$backend/database/queries';
import { streamManager } from '$backend/chat/stream-manager';
import { getClaudeUserConfigDir } from '$backend/engine/adapters/claude/environment';
import { getPiSessionDir } from '$backend/engine/adapters/pi/session-fork';
import { moveProject, rewritePathPrefix } from './move';
import { protectedFolderReason } from './folder-guard';

let root: string;
const created: string[] = [];

function makeProject(name: string): { id: string; path: string } {
	const path = join(root, name);
	mkdirSync(path, { recursive: true });
	const now = new Date().toISOString();
	const project = projectQueries.create({ name, path, created_at: now, last_opened_at: now });
	projectQueries.list(project.id);
	created.push(project.id);
	return { id: project.id, path };
}

function claudeDir(cwd: string): string {
	return join(getClaudeUserConfigDir(), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

beforeAll(async () => {
	await initializeDatabase();
	root = mkdtempSync(join(tmpdir(), 'clopen-move-'));
});

afterEach(() => {
	for (const id of created.splice(0)) projectQueries.deleteProject(id);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	closeDatabase();
});

describe('rewritePathPrefix', () => {
	it('re-roots paths at and under the folder, and only those', () => {
		const value = {
			root: '/work/app',
			file: '/work/app/src/index.ts',
			sibling: '/work/app-two/readme.md',
			windows: 'C:\\work\\app\\src',
			list: ['/work/app/a', 'unrelated']
		};
		expect(rewritePathPrefix(value, '/work/app', '/work/renamed')).toEqual({
			root: '/work/renamed',
			file: '/work/renamed/src/index.ts',
			sibling: '/work/app-two/readme.md',
			windows: 'C:\\work\\app\\src',
			list: ['/work/renamed/a', 'unrelated']
		});
		expect(rewritePathPrefix('C:\\work\\app\\src', 'C:\\work\\app', 'C:\\work\\new')).toBe('C:\\work\\new\\src');
	});

	it('opens JSON stored inside JSON, and leaves untouched values as the same object', () => {
		const inner = JSON.stringify({ openTabs: [{ path: '/work/app/a.ts' }] });
		const outer = JSON.stringify({ v: 2, scopes: { main: inner } });
		const rewritten = JSON.parse(rewritePathPrefix(outer, '/work/app', '/work/new') as string);
		expect(JSON.parse(rewritten.scopes.main).openTabs[0].path).toBe('/work/new/a.ts');

		const untouched = { a: '/elsewhere', b: [1, 2] };
		expect(rewritePathPrefix(untouched, '/work/app', '/work/new')).toBe(untouched);
	});
});

describe('moveProject', () => {
	it('renames the folder and carries the record, history and saved state along', async () => {
		const project = makeProject('alpha');
		writeFileSync(join(project.path, 'keep.txt'), 'kept');
		const renamedPath = join(root, 'alpha-renamed');

		mkdirSync(claudeDir(project.path), { recursive: true });
		writeFileSync(join(claudeDir(project.path), 'session.jsonl'), '{}');
		mkdirSync(getPiSessionDir(project.path), { recursive: true });
		writeFileSync(join(getPiSessionDir(project.path), 'pi.jsonl'), '{}');

		memoryQueueQueries.enqueue({
			sessionId: `move-test-${project.id}`,
			projectId: project.id,
			projectPath: project.path,
			userMessageId: 'm1',
			changedPaths: [],
			delaySeconds: 3600
		});
		projectQueries.setWorkspaceState(project.id, JSON.stringify({ v: 1, docks: { git: { repoPath: join(project.path, 'sub') } } }));

		const outcome = await moveProject(project.id, { kind: 'rename', name: 'alpha-renamed' });

		expect(outcome.status).toBe('moved');
		if (outcome.status !== 'moved') return;
		expect(outcome.project.path).toBe(renamedPath);
		expect(outcome.project.name).toBe('alpha-renamed');
		expect(outcome.project.missing).toBe(false);
		expect(outcome.previousPath).toBe(project.path);
		expect(outcome.warnings).toEqual([]);

		expect(existsSync(project.path)).toBe(false);
		expect(readFileSync(join(renamedPath, 'keep.txt'), 'utf8')).toBe('kept');
		expect(projectQueries.getById(project.id)).toMatchObject({ path: renamedPath, name: 'alpha-renamed' });

		expect(existsSync(join(claudeDir(renamedPath), 'session.jsonl'))).toBe(true);
		expect(existsSync(claudeDir(project.path))).toBe(false);
		expect(existsSync(join(getPiSessionDir(renamedPath), 'pi.jsonl'))).toBe(true);

		const row = getDatabase()
			.prepare('SELECT project_path FROM memory_extraction_queue WHERE session_id = ?')
			.get(`move-test-${project.id}`) as { project_path: string } | null;
		expect(row?.project_path).toBe(renamedPath);
		getDatabase().prepare('DELETE FROM memory_extraction_queue WHERE session_id = ?').run(`move-test-${project.id}`);

		const blob = JSON.parse(projectQueries.getWorkspaceState(project.id)!);
		expect(blob.docks.git.repoPath).toBe(join(renamedPath, 'sub'));

		rmSync(claudeDir(renamedPath), { recursive: true, force: true });
		rmSync(getPiSessionDir(renamedPath), { recursive: true, force: true });
	});

	it('answers busy and moves nothing while a chat runs in the main tree', async () => {
		const project = makeProject('busy');
		const streams = (streamManager as unknown as { activeStreams: Map<string, unknown> }).activeStreams;
		streams.set('move-test-stream', {
			streamId: 'move-test-stream',
			projectId: project.id,
			chatSessionId: 'move-test-no-such-session',
			status: 'active',
			messages: []
		});
		try {
			const outcome = await moveProject(project.id, { kind: 'rename', name: 'busy-renamed' });
			expect(outcome).toEqual({ status: 'busy', usage: { chats: 1, terminals: 0 } });
			expect(existsSync(project.path)).toBe(true);
			expect(projectQueries.getById(project.id)?.path).toBe(project.path);
		} finally {
			streams.delete('move-test-stream');
		}
	});

	it('puts the folder back when the record cannot be updated', async () => {
		const project = makeProject('rollback');
		const original = projectQueries.relocate;
		projectQueries.relocate = () => {
			throw new Error('disk full');
		};
		try {
			await expect(moveProject(project.id, { kind: 'rename', name: 'rollback-renamed' })).rejects.toThrow('disk full');
		} finally {
			projectQueries.relocate = original;
		}
		expect(existsSync(project.path)).toBe(true);
		expect(existsSync(join(root, 'rollback-renamed'))).toBe(false);
		expect(projectQueries.getById(project.id)?.path).toBe(project.path);
	});

	it('points a project whose folder vanished at where it is now', async () => {
		const project = makeProject('lost');
		const foundPath = join(root, 'found-again');
		mkdirSync(foundPath);
		rmSync(project.path, { recursive: true });

		const outcome = await moveProject(project.id, { kind: 'relocate', path: foundPath });
		expect(outcome.status).toBe('moved');
		if (outcome.status !== 'moved') return;
		expect(outcome.project).toMatchObject({ path: foundPath, name: 'found-again', missing: false });
		expect(existsSync(foundPath)).toBe(true);
	});

	it('refuses a name that is taken, a folder that holds another project, and Home', async () => {
		const project = makeProject('outer');
		mkdirSync(join(root, 'taken'));
		await expect(moveProject(project.id, { kind: 'rename', name: 'taken' })).rejects.toThrow(/already exists/);
		await expect(moveProject(project.id, { kind: 'rename', name: '../escape' })).rejects.toThrow(/not a folder name/);

		makeProject('outer/inner');
		await expect(moveProject(project.id, { kind: 'rename', name: 'outer-2' })).rejects.toThrow(/holds the project/);
		expect(existsSync(project.path)).toBe(true);

		const home = projectQueries.getHome();
		if (home) await expect(moveProject(home.id, { kind: 'rename', name: 'x' })).rejects.toThrow(/Home cannot/);
	});

	it('refuses to point a project at a folder another project already has', async () => {
		const first = makeProject('first');
		const second = makeProject('second');
		await expect(moveProject(first.id, { kind: 'relocate', path: second.path })).rejects.toThrow(/is the project second/);
	});
});

describe('protectedFolderReason', () => {
	it('exempts only the moving project, never one inside it', () => {
		const project = makeProject('guarded');
		expect(protectedFolderReason(project.path)).toMatch(/is the project guarded/);
		expect(protectedFolderReason(project.path, project.id)).toBeNull();
		expect(protectedFolderReason(root)).toMatch(/holds the project/);
	});
});
