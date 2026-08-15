/**
 * File watcher tests.
 *
 * These exercise the real watcher against a real temp directory, because the
 * bugs this code exists to prevent are all about what the OS actually reports:
 * ignored directories still generating events, a rebuilt watcher announcing
 * itself as a file change, and nested directories created after start-up going
 * unwatched (which is only a risk on the platforms where recursion is emulated).
 */

import { describe, expect, mock, test, beforeAll, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Emitted {
	projectId: string;
	event: string;
	payload: Record<string, unknown>;
}

const emitted: Emitted[] = [];

mock.module('$backend/utils/ws', () => ({
	ws: {
		emit: {
			project: (projectId: string, event: string, payload: Record<string, unknown>) => {
				emitted.push({ projectId, event, payload });
			},
			user: () => {},
			global: () => {}
		}
	}
}));

// Imported after the mock so the watcher binds to the stub.
let fileWatcher: typeof import('./file-watcher').fileWatcher;

beforeAll(async () => {
	({ fileWatcher } = await import('./file-watcher'));
});

const tempRoots: string[] = [];

async function makeProject(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'clopen-watch-'));
	tempRoots.push(dir);
	return dir;
}

/** Wait until `predicate` holds, or fail after `timeout` ms. */
async function waitFor(predicate: () => boolean, timeout = 4000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error('Timed out waiting for watcher event');
}

function changesFor(projectId: string): string[] {
	return emitted
		.filter((e) => e.projectId === projectId && e.event === 'files:changed')
		.flatMap((e) => (e.payload.changes as { path: string }[]).map((c) => c.path));
}

afterEach(async () => {
	for (const projectId of fileWatcher.getWatchedProjects()) {
		fileWatcher.releaseProject(projectId);
	}
	emitted.length = 0;
	await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('FileWatcherManager', () => {
	test('reports changes to files in the project root', async () => {
		const root = await makeProject();
		expect(await fileWatcher.startWatching('p1', root)).toBe(true);

		await writeFile(join(root, 'index.ts'), 'export {}');

		await waitFor(() => changesFor('p1').some((p) => p.endsWith('index.ts')));
	});

	test('reports changes in nested directories created after the watch started', async () => {
		const root = await makeProject();
		expect(await fileWatcher.startWatching('p2', root)).toBe(true);

		// A directory that did not exist at start-up: on Linux this only works if
		// the watcher attaches to newly created directories as it sees them.
		const nested = join(root, 'src', 'deep');
		await mkdir(nested, { recursive: true });
		await waitFor(() => changesFor('p2').some((p) => p.endsWith('src')));

		emitted.length = 0;
		await writeFile(join(nested, 'mod.ts'), 'export {}');

		await waitFor(() => changesFor('p2').some((p) => p.endsWith('mod.ts')));
	});

	test('never reports changes inside ignored directories', async () => {
		const root = await makeProject();
		await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
		await mkdir(join(root, '.git'), { recursive: true });
		expect(await fileWatcher.startWatching('p3', root)).toBe(true);

		await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), '// noise');
		await writeFile(join(root, '.git', 'COMMIT_EDITMSG'), 'wip');

		// Space the writes out: the platform watchers coalesce bursts and can drop
		// events that land in the same instant, which would make this pass for the
		// wrong reason (or fail on the sentinel write below).
		await new Promise((r) => setTimeout(r, 400));

		// Write a watched file last; once it lands, the ignored writes have had at
		// least as long to arrive, so their absence is meaningful rather than a race.
		await writeFile(join(root, 'app.ts'), 'export {}');
		await waitFor(() => changesFor('p3').some((p) => p.endsWith('app.ts')));

		const paths = changesFor('p3');
		expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
		expect(paths.some((p) => p.includes('.git'))).toBe(false);
	});

	test('does not emit an empty change list', async () => {
		const root = await makeProject();
		expect(await fileWatcher.startWatching('p4', root)).toBe(true);

		await writeFile(join(root, 'a.ts'), 'export {}');
		await waitFor(() => changesFor('p4').length > 0);

		const empties = emitted.filter(
			(e) => e.event === 'files:changed' && (e.payload.changes as unknown[]).length === 0
		);
		expect(empties).toHaveLength(0);
	});

	test('tracks dirty files for the snapshot system', async () => {
		const root = await makeProject();
		expect(await fileWatcher.startWatching('p5', root)).toBe(true);

		await writeFile(join(root, 'tracked.ts'), 'export {}');
		await waitFor(() => fileWatcher.getDirtyFiles('p5').has('tracked.ts'));

		fileWatcher.clearDirtyFiles('p5');
		expect(fileWatcher.getDirtyFiles('p5').size).toBe(0);
	});

	test('stops watching once the last viewer leaves', async () => {
		const root = await makeProject();
		expect(await fileWatcher.addViewer('conn-a', 'p6', root)).toBe(true);
		expect(await fileWatcher.addViewer('conn-b', 'p6', root)).toBe(true);

		fileWatcher.removeViewer('conn-a', 'p6');
		expect(fileWatcher.isWatching('p6')).toBe(true);

		fileWatcher.removeViewer('conn-b', 'p6');
		expect(fileWatcher.isWatching('p6')).toBe(false);
	});
});
