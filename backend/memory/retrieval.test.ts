/**
 * Memory Graph schema + retrieval tests.
 *
 * These run against a REAL in-memory SQLite database with migration 066 applied,
 * rather than a hand-mocked query surface. The interesting behaviour here lives
 * in the SQL — the COALESCE-based digest uniqueness, the FTS5 mirror, the
 * cross-project filters — and a mock would assert the test's own idea of that
 * SQL instead of the database's.
 *
 * The vector channel needs the on-demand artifact, so tests that depend on it
 * are skipped when it is absent; the lexical, graph and fusion behaviour is
 * covered regardless.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
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

const { graphQueries, deriveDigest } = await import('$backend/database/queries/graph-queries');
const { retrieve, markConsulted, profileQuery } = await import('./retrieval');
const { embedder } = await import('./embedding');
const { isEmbeddingArtifactInstalled } = await import('./embedding/paths');

const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';

function resetDatabase(): void {
	db = new Database(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	migration066.up(db as unknown as DatabaseConnection);
}

beforeEach(() => {
	resetDatabase();
});

describe('graph schema', () => {
	it('upserts on digest instead of duplicating, and reinforces weight', () => {
		const first = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			projectId: PROJECT_A,
			label: 'Engine SDKs install on demand',
			body: 'They are not bundled into the global install.'
		});
		const second = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			projectId: PROJECT_A,
			label: 'Engine SDKs install on demand',
			body: 'They are not bundled into the global install.'
		});

		expect(second.id).toBe(first.id);
		expect(second.weight).toBeGreaterThan(first.weight);
		expect(graphQueries.count({ projectId: PROJECT_A })).toBe(1);
	});

	it('treats the same claim in two projects as two nodes', () => {
		const input = {
			kind: 'episodic' as const,
			subkind: 'pattern' as const,
			label: 'Runes are used for state',
			body: 'Traditional stores are avoided.'
		};
		const a = graphQueries.upsert({ ...input, projectId: PROJECT_A });
		const b = graphQueries.upsert({ ...input, projectId: PROJECT_B });

		expect(a.id).not.toBe(b.id);
		expect(a.digest).toBe(b.digest);
	});

	it('de-duplicates global nodes even though project_id is NULL', () => {
		// SQLite counts every NULL as distinct in a UNIQUE index, so this only
		// works because the index keys on COALESCE(project_id, '').
		const input = {
			kind: 'episodic' as const,
			subkind: 'preference' as const,
			scope: 'global' as const,
			projectId: null,
			label: 'All PR-facing text is written in English'
		};
		graphQueries.upsert(input);
		graphQueries.upsert(input);

		expect(graphQueries.count({ projectId: null })).toBe(1);
	});

	it('never lets an automatic write overwrite user-authored text', () => {
		const node = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			projectId: PROJECT_A,
			label: 'Original label',
			source: 'user'
		});

		graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			projectId: PROJECT_A,
			label: 'Machine-rewritten label',
			digest: node.digest,
			source: 'agent'
		});

		expect(graphQueries.getById(node.id)!.label).toBe('Original label');
	});

	it('re-derives the digest after a manual edit so extraction cannot revert it', () => {
		const node = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'observation',
			projectId: PROJECT_A,
			label: 'Snapshots use the file watcher'
		});

		graphQueries.update(node.id, { label: 'Snapshots scan the disk, not the watcher' });
		const edited = graphQueries.getById(node.id)!;
		expect(edited.digest).not.toBe(node.digest);

		// The original claim now hashes to a free digest, so re-extracting it adds a
		// new node rather than overwriting the correction.
		graphQueries.upsert({
			kind: 'episodic',
			subkind: 'observation',
			projectId: PROJECT_A,
			label: 'Snapshots use the file watcher'
		});
		expect(graphQueries.getById(node.id)!.label).toBe('Snapshots scan the disk, not the watcher');
		expect(graphQueries.count({ projectId: PROJECT_A })).toBe(2);
	});

	it('gives each dependency its own identity', () => {
		// Dependencies carry no path or symbol, so without a name-based fallback they
		// all hash to the same digest and each new package overwrites the last.
		const lodash = deriveDigest({ kind: 'structural', subkind: 'dependency', label: 'lodash' });
		const zod = deriveDigest({ kind: 'structural', subkind: 'dependency', label: 'zod' });
		expect(lodash).not.toBe(zod);
	});

	it('keeps structural identity tied to path and symbol', () => {
		const a = deriveDigest({ kind: 'structural', subkind: 'file', label: 'x', path: 'backend/a.ts' });
		const b = deriveDigest({ kind: 'structural', subkind: 'file', label: 'totally different label', path: 'backend/a.ts' });
		const c = deriveDigest({ kind: 'structural', subkind: 'file', label: 'x', path: 'backend/b.ts' });

		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});
});

describe('graph edges', () => {
	it('rejects self-loops and strengthens repeated links', () => {
		const a = graphQueries.upsert({ kind: 'episodic', subkind: 'decision', projectId: PROJECT_A, label: 'A' });
		const b = graphQueries.upsert({ kind: 'structural', subkind: 'file', projectId: PROJECT_A, label: 'b.ts', path: 'b.ts' });

		expect(graphQueries.link({ srcId: a.id, dstId: a.id, rel: 'about' })).toBeNull();

		const first = graphQueries.link({ srcId: a.id, dstId: b.id, rel: 'about' })!;
		const second = graphQueries.link({ srcId: a.id, dstId: b.id, rel: 'about' })!;
		expect(second.id).toBe(first.id);
		expect(second.weight).toBeGreaterThan(first.weight);
	});

	it('cascades edges when a node is hard-deleted', () => {
		const a = graphQueries.upsert({ kind: 'episodic', subkind: 'decision', projectId: PROJECT_A, label: 'A' });
		const b = graphQueries.upsert({ kind: 'structural', subkind: 'file', projectId: PROJECT_A, label: 'b.ts', path: 'b.ts' });
		graphQueries.link({ srcId: a.id, dstId: b.id, rel: 'about' });

		graphQueries.remove(b.id);
		expect(graphQueries.edgesOf(a.id)).toHaveLength(0);
	});

	it('walks multiple hops and reports distance', () => {
		const a = graphQueries.upsert({ kind: 'episodic', subkind: 'decision', projectId: PROJECT_A, label: 'A' });
		const b = graphQueries.upsert({ kind: 'structural', subkind: 'file', projectId: PROJECT_A, label: 'b.ts', path: 'b.ts' });
		const c = graphQueries.upsert({ kind: 'structural', subkind: 'file', projectId: PROJECT_A, label: 'c.ts', path: 'c.ts' });
		graphQueries.link({ srcId: a.id, dstId: b.id, rel: 'about' });
		graphQueries.link({ srcId: b.id, dstId: c.id, rel: 'imports' });

		const oneHop = graphQueries.neighbours(a.id, 1);
		expect(oneHop.map(n => n.node.id)).toEqual([b.id]);

		const twoHops = graphQueries.neighbours(a.id, 2);
		expect(twoHops.find(n => n.node.id === c.id)?.hops).toBe(2);
	});

	it('bridges episodic and structural memory through `about`', () => {
		const decision = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			projectId: PROJECT_A,
			label: 'Credentials are read from the database, never from env vars'
		});
		const file = graphQueries.upsert({
			kind: 'structural',
			subkind: 'file',
			projectId: PROJECT_A,
			label: 'engine-queries.ts',
			path: 'backend/database/queries/engine-queries.ts'
		});
		graphQueries.link({ srcId: decision.id, dstId: file.id, rel: 'about' });

		// Arriving from the code should reach the decision made about it.
		const fromCode = graphQueries.neighbours(file.id, 1);
		expect(fromCode.map(n => n.node.id)).toContain(decision.id);
	});
});

describe('lexical retrieval', () => {
	beforeEach(() => {
		graphQueries.upsert({
			kind: 'episodic',
			subkind: 'failure',
			projectId: PROJECT_A,
			label: 'Codex exits with code 1 when its home directory is missing',
			body: 'getCodexHomeDir now creates the directory on access.'
		});
		graphQueries.upsert({
			kind: 'structural',
			subkind: 'file',
			projectId: PROJECT_A,
			label: 'sdk-loader.ts',
			path: 'backend/engine/sdk-loader.ts'
		});
		graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			projectId: PROJECT_B,
			label: 'Preview capture uses fitScale times device pixel ratio'
		});
	});

	it('finds a memory by an identifier in its body', () => {
		const result = retrieve({ query: 'getCodexHomeDir', projectId: PROJECT_A, expandHops: 0 });
		expect(result.hits[0].node.label).toContain('Codex exits with code 1');
	});

	it('matches a path fragment, because paths are indexed split as well as whole', () => {
		const result = retrieve({ query: 'sdk loader', projectId: PROJECT_A, expandHops: 0 });
		expect(result.hits.map(h => h.node.path)).toContain('backend/engine/sdk-loader.ts');
	});

	it('scopes results to one project but still admits global memories', () => {
		graphQueries.upsert({
			kind: 'episodic',
			subkind: 'preference',
			scope: 'global',
			projectId: null,
			label: 'Preview quality is preferred over frame rate'
		});

		const scoped = retrieve({ query: 'preview', projectId: PROJECT_A, expandHops: 0 });
		const labels = scoped.hits.map(h => h.node.label);
		expect(labels).toContain('Preview quality is preferred over frame rate');
		expect(labels).not.toContain('Preview capture uses fitScale times device pixel ratio');
	});

	it('searches across every project when no project is given', () => {
		const all = retrieve({ query: 'preview', expandHops: 0 });
		expect(all.hits.map(h => h.node.projectId)).toContain(PROJECT_B);
	});

	it('survives punctuation-only and empty queries', () => {
		expect(retrieve({ query: '' }).hits).toHaveLength(0);
		expect(retrieve({ query: '   ??? ' }).hits).toHaveLength(0);
		expect(() => retrieve({ query: 'a" OR "b' })).not.toThrow();
	});

	it('drops archived nodes from the index and restores them on demand', () => {
		const node = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'observation',
			projectId: PROJECT_A,
			label: 'Zstd compresses large WebSocket responses'
		});

		graphQueries.archive(node.id);
		expect(retrieve({ query: 'zstd', projectId: PROJECT_A, expandHops: 0 }).hits).toHaveLength(0);

		graphQueries.restore(node.id);
		expect(retrieve({ query: 'zstd', projectId: PROJECT_A, expandHops: 0 }).hits).toHaveLength(1);
	});
});

describe('graph expansion', () => {
	it('surfaces a neighbour of a match that the query itself never mentions', () => {
		const file = graphQueries.upsert({
			kind: 'structural',
			subkind: 'file',
			projectId: PROJECT_A,
			label: 'snapshot-service.ts',
			path: 'backend/snapshot/snapshot-service.ts'
		});
		const decision = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			projectId: PROJECT_A,
			label: 'The disk is the source of truth, not the watcher dirty set'
		});
		graphQueries.link({ srcId: decision.id, dstId: file.id, rel: 'about' });

		const direct = retrieve({ query: 'snapshot-service', projectId: PROJECT_A, expandHops: 0 });
		expect(direct.hits.map(h => h.node.id)).not.toContain(decision.id);

		const expanded = retrieve({ query: 'snapshot-service', projectId: PROJECT_A, expandHops: 1 });
		const hit = expanded.hits.find(h => h.node.id === decision.id);
		expect(hit).toBeDefined();
		expect(hit!.channel).toBe('graph');
		expect(hit!.hops).toBe(1);
	});

	it('ranks an expanded neighbour below the direct match that produced it', () => {
		const file = graphQueries.upsert({
			kind: 'structural',
			subkind: 'file',
			projectId: PROJECT_A,
			label: 'stream-manager.ts',
			path: 'backend/chat/stream-manager.ts'
		});
		const note = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'observation',
			projectId: PROJECT_A,
			label: 'Unrelated wording entirely'
		});
		graphQueries.link({ srcId: note.id, dstId: file.id, rel: 'about' });

		const result = retrieve({ query: 'stream-manager', projectId: PROJECT_A, expandHops: 1 });
		expect(result.hits[0].node.id).toBe(file.id);
	});
});

describe('ranking priors', () => {
	it('prefers a pinned memory over an equally-matching unpinned one', () => {
		graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			projectId: PROJECT_A,
			label: 'Compression applies to websocket responses'
		});
		const pinned = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			projectId: PROJECT_A,
			label: 'Compression applies to websocket payloads',
			pinned: true
		});

		const result = retrieve({ query: 'compression websocket', projectId: PROJECT_A, expandHops: 0 });
		expect(result.hits[0].node.id).toBe(pinned.id);
	});

	/**
	 * Retrieval used to count its own results as accesses, and that number then fed
	 * back into the prior that produced them. Automatic injection retrieves on every
	 * single turn, so the loop had nothing to do with whether a memory was any good:
	 * whatever ranked highly ranked more highly next time. Only a DELIBERATE
	 * consultation counts now.
	 */
	it('does not count an access merely for retrieving a node', () => {
		const node = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			projectId: PROJECT_A,
			label: 'Cursor pagination replaced full chain loading'
		});

		retrieve({ query: 'cursor pagination', projectId: PROJECT_A, expandHops: 0 });
		expect(graphQueries.getById(node.id)!.accessCount).toBe(0);
	});

	it('counts an access when a caller says the result was consulted', () => {
		const node = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			projectId: PROJECT_A,
			label: 'Cursor pagination replaced full chain loading'
		});

		const result = retrieve({ query: 'cursor pagination', projectId: PROJECT_A, expandHops: 0 });
		markConsulted(result.hits);
		expect(graphQueries.getById(node.id)!.accessCount).toBe(1);
	});
});

const describeIfEmbedding = isEmbeddingArtifactInstalled() ? describe : describe.skip;

describeIfEmbedding('vector retrieval', () => {
	it('answers an Indonesian question about an English memory', async () => {
		await embedder.load();

		const target = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'failure',
			projectId: PROJECT_A,
			label: 'The browser preview stayed stuck on Loading because early ICE candidates were not buffered'
		});
		graphQueries.upsert({
			kind: 'episodic',
			subkind: 'pattern',
			projectId: PROJECT_A,
			label: 'Svelte runes are used for state management across the frontend'
		});
		graphQueries.upsert({
			kind: 'episodic',
			subkind: 'observation',
			projectId: PROJECT_A,
			label: 'SQLite migrations are numbered sequentially and seeders run after them'
		});

		// Vectors are written by the indexer, which is what retrieval reads.
		const { drain } = await import('./indexer');
		await drain();

		// Not one word of this query appears in any stored memory, so BM25 returns
		// nothing at all and anything that comes back came from the vector channel.
		const result = retrieve({ query: 'halaman tidak mau tampil', projectId: PROJECT_A, expandHops: 0 });
		expect(result.vectorUsed).toBe(true);
		expect(result.hits[0].node.id).toBe(target.id);
		expect(result.hits[0].channel).toBe('vector');
		expect(result.hits[0].lexicalRank).toBeNull();
	});

	it('lets the lexical channel correct a vector mistake', async () => {
		await embedder.load();

		const target = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			projectId: PROJECT_A,
			label: 'Permissions are enforced by a runtime hook because Clopen auto approves everything'
		});
		// Measured against this artifact, "izin tool ditegakkan di mana?" scores
		// this unrelated memory (0.204) ABOVE the correct one (0.107) — mean-pooled
		// static embeddings put short texts closer together than their meanings do.
		// A vector-only retriever would answer wrongly here.
		graphQueries.upsert({
			kind: 'episodic',
			subkind: 'observation',
			projectId: PROJECT_A,
			label: 'The git panel actions stay visible regardless of repository state'
		});

		const { drain } = await import('./indexer');
		await drain();

		// With one shared term ("permissions") BM25 has a say, and fusion puts the
		// right memory back on top. This is the case that justifies running both
		// channels on every query rather than picking one.
		const result = retrieve({ query: 'permissions ditegakkan di mana?', projectId: PROJECT_A, expandHops: 0 });
		expect(result.hits[0].node.id).toBe(target.id);
	});

	it('finds every memory about one subject through the entity index', async () => {
		await embedder.load();

		// Three statements about one person, phrased differently. They used to be
		// connected by similarity linking, which on a real corpus of "X is a project
		// that does Y" sentences produced 144 edges that were mostly nonsense — every
		// pair was similar in SHAPE rather than in SUBJECT. The entities a memory
		// names answer the same question directly, and exactly.
		const arga = [
			'Arga is a full-stack developer working in the JavaScript and TypeScript ecosystem',
			'Arga is a full-stack developer with five years of experience based in Indonesia',
			'Arga is the user of this workspace: a JavaScript and TypeScript full-stack developer'
		].map(label => graphQueries.upsert({ kind: 'episodic', subkind: 'entity', projectId: PROJECT_A, label }));
		for (const node of arga) graphQueries.setEntities(node.id, [{ key: 'arga', name: 'Arga' }]);

		const unrelated = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'observation',
			projectId: PROJECT_A,
			label: 'Zstd compression is applied to large WebSocket responses'
		});

		const about = graphQueries.memoriesAboutEntity('arga').map(n => n.id);
		for (const node of arga) expect(about).toContain(node.id);
		expect(about).not.toContain(unrelated.id);
	});

	it('connects memories that name the same subject, without storing an edge', () => {
		// Removing similarity linking took a real graph from 371 edges to 6 and left
		// the view a field of disconnected dots. What was wrong with those edges was
		// that COSINE chose them — two memories are related when they are about the
		// same THING, which extraction already records.
		const a = graphQueries.upsert({ kind: 'episodic', subkind: 'observation', projectId: PROJECT_A, label: 'TunnelKit exposes three tunnel modes' });
		const b = graphQueries.upsert({ kind: 'episodic', subkind: 'decision', projectId: PROJECT_A, label: 'TunnelKit was extracted into its own library' });
		const unrelated = graphQueries.upsert({ kind: 'episodic', subkind: 'observation', projectId: 'project-z', label: 'Something else entirely' });
		graphQueries.setEntities(a.id, [{ key: 'tunnelkit', name: 'TunnelKit' }]);
		graphQueries.setEntities(b.id, [{ key: 'tunnelkit', name: 'TunnelKit' }]);

		const derived = graphQueries.derivedEdges([a.id, b.id, unrelated.id]);
		expect(derived.some(e => e.via === 'subject' && [e.srcId, e.dstId].includes(a.id) && [e.srcId, e.dstId].includes(b.id))).toBe(true);

		// Derived, not stored: nothing was written that could outlive the claim.
		expect(graphQueries.edgesOf(a.id)).toHaveLength(0);
	});

	it('reaches a memory about the same subject in one traversal hop', () => {
		const a = graphQueries.upsert({ kind: 'episodic', subkind: 'observation', projectId: PROJECT_A, label: 'First note about the subject' });
		const b = graphQueries.upsert({ kind: 'episodic', subkind: 'observation', projectId: PROJECT_A, label: 'Second note about the subject' });
		graphQueries.setEntities(a.id, [{ key: 'ptykit', name: 'PtyKit' }]);
		graphQueries.setEntities(b.id, [{ key: 'ptykit', name: 'PtyKit' }]);

		expect(graphQueries.neighbours(a.id, 1).map(n => n.node.id)).toContain(b.id);
	});

	it('does not connect a subject shared by too much of the graph', () => {
		// A word everyone uses is not a relationship. Connecting forty memories
		// through "TypeScript" would recreate the fabricated structure that
		// similarity linking produced, from a different cause.
		const ids: string[] = [];
		for (let i = 0; i < 30; i++) {
			const node = graphQueries.upsert({ kind: 'episodic', subkind: 'observation', projectId: PROJECT_A, label: `Note ${i}` });
			graphQueries.setEntities(node.id, [{ key: 'typescript', name: 'TypeScript' }]);
			ids.push(node.id);
		}
		expect(graphQueries.derivedEdges(ids).some(e => e.via === 'subject')).toBe(false);
	});

	it('never invents an edge between two memories', async () => {
		await embedder.load();

		// Similarity linking is gone. Nothing writes `relates_to` automatically any
		// more, so a graph of related-sounding memories has no edges at all until a
		// person or a model draws one deliberately.
		const nodes = [
			'This repository is a Vantum monorepo at phase 1.8 containing core and CLI',
			'ChatKit runs on Node.js 18 and Bun with its design tokens kept local',
			'CommonForms Detection Service is a FastAPI PDF pipeline',
			'Programmer Finder uses Flutter for the app and Elixir for the API'
		].map(label => graphQueries.upsert({ kind: 'episodic', subkind: 'observation', projectId: PROJECT_A, label }));

		for (const node of nodes) {
			expect(graphQueries.edgesOf(node.id).filter(e => e.rel === 'relates_to')).toHaveLength(0);
		}
	});

	it('marks a hit found by both channels as `both`', async () => {
		await embedder.load();

		graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			projectId: PROJECT_A,
			label: 'Engine SDKs are installed on demand into the managed stack directory'
		});

		const { drain } = await import('./indexer');
		await drain();

		const result = retrieve({ query: 'engine SDK installed on demand', projectId: PROJECT_A, expandHops: 0 });
		expect(result.hits[0].channel).toBe('both');
		expect(result.hits[0].lexicalRank).not.toBeNull();
		expect(result.hits[0].vectorRank).not.toBeNull();
	});
});

describe('query profiling', () => {
	/**
	 * The two channels are not equally good at the two kinds of question, and which
	 * kind a query is can be told from its surface without a model. Getting this
	 * wrong in either direction is expensive: weighting vectors on an identifier
	 * buries the exact match, and weighting lexical on a paraphrase leaves the
	 * cross-language case with nothing.
	 */
	it.each([
		['backend/memory/retrieval.ts', 'code'],
		['EngineNotReadyError', 'code'],
		['stream_manager.captureSnapshot()', 'code'],
		['kenapa kita memilih SQLite daripada Postgres', 'prose'],
		['what did we decide about authentication', 'prose']
	] as const)('reads %s as %s', (query, shape) => {
		expect(profileQuery(query).shape).toBe(shape);
	});

	it('tilts fusion toward the channel that suits the query', () => {
		const code = profileQuery('backend/memory/retrieval.ts');
		const prose = profileQuery('why do we keep memories in one graph');

		expect(code.lexicalWeight).toBeGreaterThan(code.vectorWeight);
		expect(prose.vectorWeight).toBeGreaterThan(prose.lexicalWeight);
	});

	it('reports the profile it used, so ranking stays explainable', () => {
		const result = retrieve({ query: 'backend/memory/retrieval.ts', projectId: PROJECT_A });
		expect(result.profile.shape).toBe('code');
	});
});

describe('graph expansion', () => {
	/**
	 * Edges deliberately cross project boundaries — that is what lets a pattern
	 * proven in one repository be reused in another. Traversal therefore has to
	 * re-apply the scope filter, or one hop from a shared dependency node reaches
	 * another project's files and, through them, another project's memories — into a
	 * block that is about to be injected into THIS project's prompt.
	 */
	it('does not cross into another project through a shared node', () => {
		const shared = graphQueries.upsert({
			kind: 'structural',
			subkind: 'dependency',
			scope: 'global',
			projectId: null,
			label: 'zod'
		});
		const mine = graphQueries.upsert({
			kind: 'structural',
			subkind: 'file',
			projectId: PROJECT_A,
			label: 'mine.ts',
			path: 'mine.ts'
		});
		const theirs = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			projectId: PROJECT_B,
			label: 'Another team decided to validate every boundary with zod'
		});
		graphQueries.link({ srcId: mine.id, dstId: shared.id, rel: 'imports' });
		graphQueries.link({ srcId: theirs.id, dstId: shared.id, rel: 'about' });

		const hits = retrieve({ query: 'zod', projectId: PROJECT_A, expandHops: 2 }).hits;
		expect(hits.map(h => h.node.id)).not.toContain(theirs.id);
	});

	it('does not leak another session\'s private memories', () => {
		const shared = graphQueries.upsert({
			kind: 'structural',
			subkind: 'file',
			projectId: PROJECT_A,
			label: 'shared.ts',
			path: 'shared.ts'
		});
		const priv = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'observation',
			scope: 'session',
			projectId: PROJECT_A,
			sessionId: 'other-session',
			label: 'Private to another conversation entirely'
		});
		graphQueries.link({ srcId: priv.id, dstId: shared.id, rel: 'about' });

		const hits = retrieve({
			query: 'shared.ts',
			projectId: PROJECT_A,
			sessionId: 'my-session',
			expandHops: 2
		}).hits;
		expect(hits.map(h => h.node.id)).not.toContain(priv.id);
	});

	it('reaches a memory through the file the turn is working in', () => {
		// The "continue" case: the query says nothing, the working set says plenty.
		const target = graphQueries.upsert({
			kind: 'structural',
			subkind: 'file',
			projectId: PROJECT_A,
			label: 'auth.ts',
			path: 'backend/auth.ts'
		});
		const lesson = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'failure',
			projectId: PROJECT_A,
			label: 'Rotating the signing key without a grace period logged everyone out'
		});
		graphQueries.link({ srcId: lesson.id, dstId: target.id, rel: 'about' });

		const hits = retrieve({
			query: 'lanjutkan',
			projectId: PROJECT_A,
			anchorPaths: ['backend/auth.ts'],
			expandHops: 1
		}).hits;
		expect(hits.map(h => h.node.id)).toContain(lesson.id);
	});

	it('does not let a hub node drown the result in its neighbours', () => {
		// Activation is divided by the neighbour count, so a forty-edge hub passes
		// almost nothing to any one of them. A flat per-hop bonus — what a plain BFS
		// expansion gives — has exactly the opposite behaviour.
		const hub = graphQueries.upsert({
			kind: 'structural',
			subkind: 'file',
			projectId: PROJECT_A,
			label: 'hub.ts',
			path: 'hub.ts'
		});
		const direct = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			projectId: PROJECT_A,
			label: 'hub.ts is the shared barrel export for the module'
		});
		graphQueries.link({ srcId: direct.id, dstId: hub.id, rel: 'about' });
		for (let i = 0; i < 30; i++) {
			const leaf = graphQueries.upsert({
				kind: 'episodic',
				subkind: 'observation',
				projectId: PROJECT_A,
				label: `Unrelated note number ${i} about nothing in particular`
			});
			graphQueries.link({ srcId: leaf.id, dstId: hub.id, rel: 'about' });
		}

		const hits = retrieve({ query: 'hub.ts barrel export', projectId: PROJECT_A, expandHops: 1 }).hits;
		expect(hits[0].node.id).toBe(direct.id);
	});
});

describe('lexical query building', () => {
	it('splits identifiers on punctuation instead of stripping it', () => {
		// Copying the message index's behaviour turned `stream-manager` into
		// `streammanager`, which matches nothing. Prose and code need opposite
		// treatment.
		expect(graphQueries.buildFtsQuery('stream-manager')).toBe('"stream"* OR "manager"*');
	});

	it('caps the term count, because two callers pass long text', () => {
		// A user pasting a stack trace, and belief revision, which queries with four
		// thousand characters of transcript. Hundreds of OR-ed prefix terms is a parse
		// tree deep enough to hit SQLite's expression limit — which throws, is caught,
		// and silently removes the lexical channel from exactly the queries that had
		// the most to say.
		const long = Array.from({ length: 400 }, (_, i) => `term${i}`).join(' ');
		const query = graphQueries.buildFtsQuery(long)!;

		expect(query.split(' OR ')).toHaveLength(32);
	});

	it('answers a query of nothing but punctuation with null', () => {
		expect(graphQueries.buildFtsQuery('--- ... ###')).toBeNull();
	});
});

describe('multi-project scoping', () => {
	function memoryIn(projectId: string | null, label: string) {
		return graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			scope: projectId ? 'project' : 'global',
			projectId,
			label,
			body: 'shared vocabulary distinctivetoken'
		});
	}

	it('covers every named project plus the globals that apply inside them', () => {
		const a = memoryIn(PROJECT_A, 'A decision in project A');
		const b = memoryIn(PROJECT_B, 'A decision in project B');
		const global = memoryIn(null, 'A decision that holds everywhere');
		const other = memoryIn('project-c', 'A decision in project C');

		const ids = retrieve({
			query: 'distinctivetoken',
			projectIds: [PROJECT_A, PROJECT_B],
			expandHops: 0
		}).hits.map(hit => hit.node.id);

		expect(ids).toContain(a.id);
		expect(ids).toContain(b.id);
		expect(ids).toContain(global.id);
		expect(ids).not.toContain(other.id);
	});

	it('reads an empty selection as global only', () => {
		// Nothing selected is a narrowing, not the absence of one: the user has
		// deselected every repository, and what remains is what was never a
		// repository's to begin with.
		const scoped = memoryIn(PROJECT_A, 'A decision in project A');
		const global = memoryIn(null, 'A decision that holds everywhere');

		const ids = retrieve({ query: 'distinctivetoken', projectIds: [], expandHops: 0 }).hits.map(
			hit => hit.node.id
		);

		expect(ids).toContain(global.id);
		expect(ids).not.toContain(scoped.id);
	});

	it('keeps expansion inside the selection', () => {
		// Edges deliberately cross projects, so one hop from a shared dependency used
		// to reach another project's files and, through them, another project's
		// memories — into a block about to be injected into this project's prompt.
		const mine = memoryIn(PROJECT_A, 'Uses the shared queue distinctivetoken');
		const theirs = memoryIn('project-c', 'Also uses the shared queue');
		const shared = graphQueries.upsert({
			kind: 'structural',
			subkind: 'dependency',
			scope: 'global',
			projectId: null,
			label: 'shared-queue'
		});
		graphQueries.link({ srcId: mine.id, dstId: shared.id, rel: 'about' });
		graphQueries.link({ srcId: theirs.id, dstId: shared.id, rel: 'about' });

		const ids = retrieve({
			query: 'distinctivetoken',
			projectIds: [PROJECT_A],
			expandHops: 2
		}).hits.map(hit => hit.node.id);

		expect(ids).toContain(mine.id);
		expect(ids).not.toContain(theirs.id);
	});
});

describe('memory that crosses projects', () => {
	/**
	 * The capability one shared graph exists for, and the thing that made it
	 * impossible: `project_id` was answering two questions at once — where a memory
	 * was learned, and where it applies. Measured on a seeded three-project corpus,
	 * automatic injection delivered 1 of 7 cross-project answers while the ranker
	 * already had 5 of them at rank one. The filter was discarding what retrieval
	 * had found.
	 */
	function travelling(projectId: string, label: string, body = '') {
		return graphQueries.upsert({
			kind: 'episodic',
			subkind: 'pattern',
			scope: 'project',
			projectId,
			label,
			body,
			reach: 'anywhere',
			confidence: 0.9
		});
	}

	function local(projectId: string, label: string, body = '') {
		return graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			scope: 'project',
			projectId,
			label,
			body,
			reach: 'here',
			confidence: 0.9
		});
	}

	it('reaches a technology insight learned in another project', () => {
		const gotcha = travelling(
			'project-b',
			'Bun suppresses crashes when an unhandledRejection listener is registered',
			'The Web-API addEventListener with preventDefault does not.'
		);

		const ids = retrieve({
			query: 'unhandledRejection listener suppresses crashes bun',
			projectId: PROJECT_A,
			crossProject: true,
			expandHops: 0
		}).hits.map(hit => hit.node.id);

		expect(ids).toContain(gotcha.id);
	});

	it('leaves another project\'s own answer at home', () => {
		// The risk of lifting the filter, and why `reach` and not a flat discount is
		// what does it: every project answers "where does this deploy" differently,
		// and being handed another project's answer is worse than being handed none.
		const theirs = local('project-b', 'This project deploys to Vercel on every merge');
		const mine = local(PROJECT_A, 'This project deploys to Fly.io for the private network');

		const ids = retrieve({
			query: 'where does this project deploy',
			projectId: PROJECT_A,
			crossProject: true,
			expandHops: 0
		}).hits.map(hit => hit.node.id);

		expect(ids).toContain(mine.id);
		expect(ids).not.toContain(theirs.id);
	});

	it('never lets another project\'s files travel', () => {
		// `reach` is forced to `here` for structural nodes on insert, so a path from
		// another repository cannot arrive however the caller asks. This is the leak
		// the blanket project filter was originally added to stop, kept.
		graphQueries.upsert({
			kind: 'structural',
			subkind: 'file',
			scope: 'project',
			projectId: 'project-b',
			label: 'packages/distinctivemodule/index.ts',
			path: 'packages/distinctivemodule/index.ts',
			reach: 'anywhere'
		});

		const hits = retrieve({
			query: 'distinctivemodule',
			projectId: PROJECT_A,
			crossProject: true,
			expandHops: 1
		}).hits;

		expect(hits.filter(hit => hit.node.kind === 'structural')).toHaveLength(0);
	});

	it('ranks a local memory above an equally-matching travelled one', () => {
		const foreign = travelling('project-b', 'Guard factories keep authorisation off route files');
		const here = travelling(PROJECT_A, 'Guard factories keep authorisation off route files here');

		const hits = retrieve({
			query: 'guard factories authorisation route files',
			projectId: PROJECT_A,
			crossProject: true,
			expandHops: 0
		}).hits;

		const homeRank = hits.findIndex(hit => hit.node.id === here.id);
		const awayRank = hits.findIndex(hit => hit.node.id === foreign.id);
		expect(homeRank).toBeGreaterThanOrEqual(0);
		expect(awayRank).toBeGreaterThan(homeRank);
	});

	it('does not cross projects unless asked', () => {
		const gotcha = travelling('project-b', 'Tailwind v4 moves configuration into distinctivetoken CSS');

		const ids = retrieve({ query: 'distinctivetoken', projectId: PROJECT_A, expandHops: 0 }).hits.map(
			hit => hit.node.id
		);
		expect(ids).not.toContain(gotcha.id);
	});
});

describe('conflicting memories', () => {
	/**
	 * Belief revision now happens HERE rather than at write time. The write path
	 * records that two memories disagree; this decides which one is current, on
	 * every turn, under a rule with no model in it.
	 */
	function preference(label: string, overrides: Record<string, unknown> = {}) {
		return graphQueries.upsert({
			kind: 'episodic',
			subkind: 'preference',
			scope: 'global',
			projectId: null,
			label,
			confidence: 0.9,
			...overrides
		} as Parameters<typeof graphQueries.upsert>[0]);
	}

	it('hands over what the user said, not what a model inferred', () => {
		const stated = preference('Never use the distinctivetoken tool', { assertedBy: 'user' });
		const inferred = preference('The distinctivetoken tool is appropriate here', { assertedBy: 'inferred' });
		graphQueries.contradict(inferred.id, stated.id);

		const ids = retrieve({ query: 'distinctivetoken tool', expandHops: 0 }).hits.map(hit => hit.node.id);
		expect(ids).toContain(stated.id);
		expect(ids).not.toContain(inferred.id);
	});

	it('prefers a standing rule to a one-off instruction', () => {
		const standing = preference('Always run the distinctivetoken checks', { assertedBy: 'user' });
		const oneOff = preference('Skip the distinctivetoken checks for this task', {
			assertedBy: 'user',
			scope: 'session'
		});
		graphQueries.contradict(oneOff.id, standing.id);

		const ids = retrieve({ query: 'distinctivetoken checks', expandHops: 0 }).hits.map(hit => hit.node.id);
		expect(ids).toContain(standing.id);
		expect(ids).not.toContain(oneOff.id);
	});

	it('prefers the later statement when nothing else separates them', () => {
		const older = preference('Deploy distinctivetoken builds on Friday', { assertedBy: 'user' });
		const newer = preference('Never deploy distinctivetoken builds on Friday', { assertedBy: 'user' });
		db.prepare(`UPDATE graph_nodes SET updated_at = datetime('now', '-3 days') WHERE id = ?`).run(older.id);
		graphQueries.contradict(newer.id, older.id);

		const ids = retrieve({ query: 'distinctivetoken builds friday', expandHops: 0 }).hits.map(hit => hit.node.id);
		expect(ids).toContain(newer.id);
		expect(ids).not.toContain(older.id);
	});

	it('leaves the loser in the graph, not out of it', () => {
		// The point of deciding at read time: a wrong call costs one line, and the
		// memory is still there when the evidence changes.
		const stated = preference('Never use the distinctivetoken tool', { assertedBy: 'user' });
		const inferred = preference('The distinctivetoken tool is appropriate here', { assertedBy: 'inferred' });
		graphQueries.contradict(inferred.id, stated.id);

		expect(graphQueries.getById(inferred.id)!.supersededBy).toBeNull();
		expect(graphQueries.getById(inferred.id)!.archivedAt).toBeNull();
		expect(graphQueries.list({ projectId: null }).map(n => n.id)).toContain(inferred.id);
	});

	it('says nothing when only one side of a disagreement is in the results', () => {
		// A contradiction with something the query never surfaced is not this turn's
		// argument to settle, and silently dropping a hit because of an absent rival
		// would make results depend on rows nobody asked about.
		const shown = preference('Use distinctivetoken formatting everywhere', { assertedBy: 'inferred' });
		const absent = preference('Whitespace is settled by the editor configuration', { assertedBy: 'user' });
		graphQueries.contradict(absent.id, shown.id);

		const ids = retrieve({ query: 'distinctivetoken formatting', expandHops: 0 }).hits.map(hit => hit.node.id);
		expect(ids).toContain(shown.id);
	});
});
