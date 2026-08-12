/**
 * Structural extraction tests.
 *
 * Run against a real temporary project on disk and a real in-memory SQLite
 * database, because what is being tested is precisely the interaction with the
 * filesystem: which import specifiers resolve to real files, which are packages,
 * and which are neither.
 *
 * Two cases here exist because they were live bugs found during bring-up, and
 * both were quiet — they produced a plausible-looking graph that degraded
 * retrieval rather than throwing:
 *
 *   - a build-tool path alias (`$shared/types`) was turned into a "dependency"
 *     node, inventing a shared dependency between every file using the alias;
 *   - structural nodes were given embedding vectors, and their path-fragment
 *     text scored above correct answers for natural-language questions.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseConnection } from '$shared/types/database/connection';
import * as migration066 from '$backend/database/migrations/066_create_memory_graph';

let db: Database;

// The whole module surface, not just `getDatabase`. `mock.module` replaces the
// module for the entire test PROCESS, so a partial stub leaves any file that runs
// afterwards unable to import the missing names — surfacing as
// "Export named 'closeDatabase' not found" in a test that never touched memory.
mock.module('$backend/database', () => ({
	getDatabase: () => db,
	initializeDatabase: async () => db,
	closeDatabase: () => {},
	resetDatabase: async () => {},
	getDatabaseInfo: async () => ({}),
	vacuumDatabase: async () => {}
}));

const { graphQueries } = await import('$backend/database/queries/graph-queries');
const { ingestStructuralChanges } = await import('./structural');

const PROJECT_ID = 'structural-test';
let projectPath: string;

beforeEach(async () => {
	db = new Database(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	migration066.up(db as unknown as DatabaseConnection);

	projectPath = await mkdtemp(join(tmpdir(), 'clopen-structural-'));
});

afterEach(async () => {
	await rm(projectPath, { recursive: true, force: true });
});

async function write(relativePath: string, contents: string): Promise<void> {
	const full = join(projectPath, relativePath);
	await mkdir(join(full, '..'), { recursive: true });
	await writeFile(full, contents, 'utf8');
}

function ingest(changedPaths: string[]) {
	return ingestStructuralChanges({ projectId: PROJECT_ID, projectPath, sessionId: 'session-1', changedPaths });
}

describe('structural extraction', () => {
	it('creates a file node and its containing module', async () => {
		await write('src/service.ts', 'export function run(): void {}\n');

		const result = await ingest(['src/service.ts']);
		expect(result.files).toBe(1);

		const file = graphQueries.getByPath(PROJECT_ID, 'src/service.ts');
		expect(file).not.toBeNull();
		expect(file!.language).toBe('typescript');
		expect(file!.label).toBe('service.ts');

		// The module edge is what gives the graph a skeleton, which is what makes
		// community detection produce meaningful lobes rather than one cloud.
		const neighbours = graphQueries.neighbours(file!.id, 1);
		expect(neighbours.some(n => n.node.subkind === 'module' && n.node.path === 'src')).toBe(true);
	});

	it('resolves a relative import to the file it actually points at', async () => {
		await write('src/a.ts', "import { b } from './b';\nexport const a = 1;\n");
		await write('src/b.ts', 'export const b = 2;\n');

		await ingest(['src/a.ts']);

		const a = graphQueries.getByPath(PROJECT_ID, 'src/a.ts')!;
		const b = graphQueries.getByPath(PROJECT_ID, 'src/b.ts');
		expect(b).not.toBeNull();
		expect(graphQueries.edgesOf(a.id).some(e => e.srcId === a.id && e.dstId === b!.id && e.rel === 'imports')).toBe(true);
	});

	it('records a real package as a global dependency node', async () => {
		await write('src/uses-pkg.ts', "import merge from 'lodash/merge';\nimport { z } from 'zod';\n");

		await ingest(['src/uses-pkg.ts']);

		const deps = graphQueries
			.list({ projectId: null, kinds: ['structural'] })
			.filter(node => node.subkind === 'dependency')
			.map(node => node.label)
			.sort();

		// Scoped to the package, not the subpath — `lodash/merge` is still lodash.
		expect(deps).toEqual(['lodash', 'zod']);
		// Dependencies are global so the same package links projects together.
		expect(graphQueries.list({ projectId: null }).every(n => n.projectId === null)).toBe(true);
	});

	it('never turns a build-tool path alias into a dependency', async () => {
		await write(
			'src/aliased.ts',
			[
				"import type { X } from '$shared/types';",
				"import { y } from '~/lib/y';",
				"import { z } from '@/utils/z';",
				"import { w } from '#internal/w';",
				"import { real } from 'nanoid';"
			].join('\n')
		);

		await ingest(['src/aliased.ts']);

		const deps = graphQueries
			.list({ projectId: null, kinds: ['structural'] })
			.filter(node => node.subkind === 'dependency')
			.map(node => node.label);

		// Only the genuine package survives. An alias is not a dependency, and
		// inventing one would connect every file that uses it.
		expect(deps).toEqual(['nanoid']);
	});

	it('names exported definitions and links them to their file', async () => {
		await write(
			'src/defs.ts',
			[
				'export function alpha(): void {}',
				'export class Beta {}',
				'export interface Gamma { x: number }',
				'export const delta = 4;',
				'function notExported(): void {}'
			].join('\n')
		);

		await ingest(['src/defs.ts']);

		const file = graphQueries.getByPath(PROJECT_ID, 'src/defs.ts')!;
		const symbols = graphQueries
			.neighbours(file.id, 1)
			.filter(n => n.node.subkind === 'symbol')
			.map(n => n.node.symbol)
			.sort();

		expect(symbols).toEqual(['Beta', 'Gamma', 'alpha', 'delta']);
		// Local helpers are not part of the module's surface, so they are not nodes.
		expect(symbols).not.toContain('notExported');
	});

	it('skips generated and vendored directories', async () => {
		await write('node_modules/pkg/index.js', 'module.exports = 1;\n');
		await write('dist/bundle.js', 'console.log(1);\n');
		await write('src/real.ts', 'export const real = 1;\n');

		const result = await ingest(['node_modules/pkg/index.js', 'dist/bundle.js', 'src/real.ts']);
		expect(result.files).toBe(1);
		expect(graphQueries.getByPath(PROJECT_ID, 'src/real.ts')).not.toBeNull();
	});

	it('re-ingesting the same file reinforces rather than duplicates', async () => {
		await write('src/again.ts', 'export const again = 1;\n');

		await ingest(['src/again.ts']);
		const first = graphQueries.getByPath(PROJECT_ID, 'src/again.ts')!;
		await ingest(['src/again.ts']);
		const second = graphQueries.getByPath(PROJECT_ID, 'src/again.ts')!;

		expect(second.id).toBe(first.id);
		expect(second.weight).toBeGreaterThan(first.weight);
	});

	it('keeps structural nodes out of the vector index', async () => {
		await write('src/vectors.ts', 'export const vectors = 1;\n');
		await ingest(['src/vectors.ts']);
		graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			projectId: PROJECT_ID,
			label: 'Vectors are only computed for prose memories, never for file paths'
		});

		const pending = graphQueries.nodesMissingVectors('test-model', 100);

		// Embedding a path yields a bag of fragments that scores highly against
		// arbitrary questions; names are BM25's job. Only the memory is queued.
		expect(pending).toHaveLength(1);
		expect(pending[0].kind).toBe('episodic');
	});

	it('does not fail on a path that no longer exists', async () => {
		const result = await ingest(['src/deleted.ts']);

		// A file removed during the turn still deserves its node — memories pointing
		// at it remain true history — but nothing may throw on the way there.
		expect(result.files).toBe(1);
		expect(graphQueries.getByPath(PROJECT_ID, 'src/deleted.ts')).not.toBeNull();
	});
});
