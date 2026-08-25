/**
 * Retrieval evaluation harness.
 *
 * Every constant in the ranker was tuned against a measurement that was taken
 * once, by hand, and then thrown away: the RRF damping, the minimum token count
 * for a vector, the z-threshold for linking, the channel weights. That is fine
 * for arriving at a number and useless for keeping it. The next change to any of
 * them — and there will be many, because ranking is never finished — has nothing
 * to check itself against.
 *
 * So the golden set lives here. It is small on purpose: a fixture that takes ten
 * minutes to run gets skipped, and thirty queries over forty memories is enough
 * to catch a regression that matters. What it asserts is a FLOOR, not an exact
 * ordering — ranking legitimately shifts when the corpus or the weights change,
 * and a test that pins the precise order would fail on every improvement as
 * readily as on every regression.
 *
 * The vector channel needs the on-demand artifact. Without it the harness still
 * runs and asserts the lexical floor, which is lower and stated separately —
 * being honest about the degraded mode is the point of measuring it.
 */

import { beforeAll, describe, expect, it, mock } from 'bun:test';
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

const { graphQueries } = await import('$backend/database/queries/graph-queries');
const { retrieve } = await import('./retrieval');
const { embedder } = await import('./embedding');
const { isEmbeddingArtifactInstalled } = await import('./embedding/paths');

const PROJECT = 'eval-project';

/**
 * The corpus. Deliberately drawn from real decisions in this repository, because
 * a synthetic corpus of maximally-distinct sentences makes any ranker look good —
 * the hard part is separating memories that are genuinely about neighbouring
 * topics, which is what a real graph is full of.
 */
const CORPUS: { key: string; subkind: string; label: string; body: string }[] = [
	{
		key: 'runtime',
		subkind: 'decision',
		label: 'Clopen runs only on Bun; Node.js and Deno are not supported',
		body: 'Runtime checks in the CLI entry point reject other runtimes rather than degrading quietly.'
	},
	{
		key: 'runes',
		subkind: 'pattern',
		label: 'Frontend state uses Svelte 5 runes rather than traditional stores',
		body: 'State is expressed with $state and $derived; writable stores are not used in new code.'
	},
	{
		key: 'pinning',
		subkind: 'decision',
		label: 'Runtime dependencies are pinned to exact versions in package.json',
		body: 'The published manifest is the only resolution source for a global install, so a floating range lets an incompatible version in.'
	},
	{
		key: 'snapshot',
		subkind: 'decision',
		label: 'Structural memory is derived from the disk diff rather than from tool calls',
		body: 'Agents rewrite files through the shell, codemods and formatters, none of which appear as an edit tool call.'
	},
	{
		key: 'embedding',
		subkind: 'decision',
		label: 'Embeddings are computed locally from a static Model2Vec table',
		body: 'A token lookup plus mean pooling, so there is no API key, no network call and no native binary.'
	},
	{
		key: 'fusion',
		subkind: 'decision',
		label: 'Retrieval fuses BM25 and vector ranks with Reciprocal Rank Fusion',
		body: 'The two scores are not comparable quantities, so ranks are fused instead of blending raw values.'
	},
	{
		key: 'compression',
		subkind: 'decision',
		label: 'Large WebSocket responses are compressed with zstd to cut chat bandwidth',
		body: 'Scoped to the request path so navigation and virtual scrolling are untouched.'
	},
	{
		key: 'pagination',
		subkind: 'decision',
		label: 'Chat messages load by cursor pagination instead of the full chain',
		body: 'Two nested windows: the data tail and the virtual-scroll DOM window.'
	},
	{
		key: 'english',
		subkind: 'preference',
		label: 'All durable text is written in English even when the conversation is not',
		body: 'A corpus in mixed languages neither compares nor de-duplicates.'
	},
	{
		key: 'commits',
		subkind: 'preference',
		label: 'Commit subjects are imperative, lowercase, and at most 72 characters',
		body: 'Branches are type slash kebab-case description.'
	},
	{
		key: 'oauth',
		subkind: 'decision',
		label: 'Clopen is the OAuth client for MCP servers and injects the bearer token per engine',
		body: 'Discovery, dynamic registration and PKCE happen centrally rather than per engine.'
	},
	{
		key: 'codex-home',
		subkind: 'failure',
		label: 'The Codex CLI exits immediately when its CODEX_HOME directory does not exist',
		body: 'The directory has to be created on access, not assumed.'
	},
	{
		key: 'ice',
		subkind: 'failure',
		label: 'Preview stayed stuck on Loading because early ICE candidates were not buffered',
		body: 'A just-opened data channel must also request a refresh frame.'
	},
	{
		key: 'reducer',
		subkind: 'failure',
		label: 'Hovering a graph node rebuilt the whole visualization because a reducer read a rune',
		body: 'Sigma calls reducers synchronously from setGraph, so reading state records it as a dependency.'
	},
	{
		key: 'binary',
		subkind: 'decision',
		label: 'Compiling to a standalone binary was abandoned in favour of a bundled script plus a shipped runtime',
		body: 'A compiled binary cannot resolve the transitive dependencies of packages loaded from disk.'
	}
];

/**
 * The queries. Each names the ONE memory it should reach. Several are phrased in
 * Indonesian against an English corpus, because that is the case the whole vector
 * channel exists for and the one a lexical-only ranker cannot answer at all.
 */
const QUERIES: { query: string; expect: string; needsVector?: boolean }[] = [
	{ query: 'which runtime does this project support', expect: 'runtime' },
	{ query: 'bun only no node', expect: 'runtime' },
	{ query: 'how is frontend state managed', expect: 'runes' },
	{ query: 'svelte runes', expect: 'runes' },
	{ query: 'why are dependency versions exact', expect: 'pinning' },
	{ query: 'where do code entities come from', expect: 'snapshot' },
	{ query: 'disk diff instead of tool calls', expect: 'snapshot' },
	{ query: 'how are embeddings computed', expect: 'embedding' },
	{ query: 'model2vec static table', expect: 'embedding' },
	{ query: 'reciprocal rank fusion', expect: 'fusion' },
	{ query: 'how are the two search channels combined', expect: 'fusion' },
	{ query: 'zstd websocket compression', expect: 'compression' },
	{ query: 'cursor pagination for messages', expect: 'pagination' },
	{ query: 'what language should memories be written in', expect: 'english' },
	{ query: 'commit message conventions', expect: 'commits' },
	{ query: 'who handles MCP oauth', expect: 'oauth' },
	{ query: 'CODEX_HOME missing directory', expect: 'codex-home' },
	{ query: 'preview stuck loading ICE candidates', expect: 'ice' },
	{ query: 'sigma reducer rune hover bug', expect: 'reducer' },
	{ query: 'why not a standalone compiled binary', expect: 'binary' },
	// Cross-language: no shared token with the memory that answers them.
	{ query: 'runtime apa yang dipakai proyek ini', expect: 'runtime', needsVector: true },
	{ query: 'bagaimana state frontend dikelola', expect: 'runes', needsVector: true },
	{ query: 'kenapa versi dependensi dikunci persis', expect: 'pinning', needsVector: true },
	{ query: 'bahasa apa yang dipakai untuk menulis memori', expect: 'english', needsVector: true }
];

/**
 * Floors, not targets.
 *
 * Lexical-only is genuinely worse and the number says so: BM25 cannot answer a
 * question that shares no word with its answer, which is most of the
 * cross-language set. Recording both means a change that trades one mode for the
 * other is visible instead of averaging out.
 */
const LEXICAL_FLOOR_AT_3 = 0.6;
const HYBRID_FLOOR_AT_3 = 0.75;
const HYBRID_FLOOR_AT_1 = 0.55;

const byKey = new Map<string, string>();

beforeAll(async () => {
	db = new Database(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	migration066.up(db as unknown as DatabaseConnection);

	for (const entry of CORPUS) {
		const node = graphQueries.upsert({
			kind: 'episodic',
			subkind: entry.subkind as 'decision',
			projectId: PROJECT,
			label: entry.label,
			body: entry.body,
			confidence: 0.8
		});
		byKey.set(entry.key, node.id);
	}

	if (isEmbeddingArtifactInstalled()) {
		await embedder.load();
		const { drain } = await import('./indexer');
		await drain();
	}
});

/** Rank of the expected memory in a query's results, or Infinity when absent. */
function rankOf(query: string, expectedKey: string): number {
	const hits = retrieve({ query, projectId: PROJECT, limit: 10, expandHops: 0 }).hits;
	const index = hits.findIndex(hit => hit.node.id === byKey.get(expectedKey));
	return index === -1 ? Infinity : index + 1;
}

function measure(queries: typeof QUERIES): { at1: number; at3: number; mrr: number; misses: string[] } {
	const misses: string[] = [];
	let at1 = 0;
	let at3 = 0;
	let reciprocal = 0;

	for (const entry of queries) {
		const rank = rankOf(entry.query, entry.expect);
		if (rank === 1) at1++;
		if (rank <= 3) at3++;
		else misses.push(`${entry.query} → rank ${rank === Infinity ? 'absent' : rank}`);
		reciprocal += rank === Infinity ? 0 : 1 / rank;
	}

	return {
		at1: at1 / queries.length,
		at3: at3 / queries.length,
		mrr: reciprocal / queries.length,
		misses
	};
}

describe('retrieval quality', () => {
	it(`answers same-language questions with recall@3 ≥ ${LEXICAL_FLOOR_AT_3}`, () => {
		// Restricted to queries that share vocabulary with their answer, so this
		// holds whether or not the embedding artifact is installed.
		const result = measure(QUERIES.filter(entry => !entry.needsVector));
		if (result.at3 < LEXICAL_FLOOR_AT_3) console.error('misses:', result.misses);
		expect(result.at3).toBeGreaterThanOrEqual(LEXICAL_FLOOR_AT_3);
	});

	it('never returns a memory from another project', () => {
		graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			projectId: 'someone-elses-project',
			label: 'Clopen runs only on Bun; Node.js and Deno are not supported',
			body: 'An identical claim, recorded elsewhere.'
		});

		const hits = retrieve({ query: 'which runtime does this project support', projectId: PROJECT }).hits;
		expect(hits.every(hit => hit.node.projectId === PROJECT || hit.node.projectId === null)).toBe(true);
	});

	it('stays well inside the per-turn latency this can afford', () => {
		// Injection runs on every turn, so retrieval has to be cheap enough that
		// nobody ever has to think about whether to switch it off.
		const started = performance.now();
		for (const entry of QUERIES) retrieve({ query: entry.query, projectId: PROJECT });
		const perQuery = (performance.now() - started) / QUERIES.length;
		expect(perQuery).toBeLessThan(30);
	});
});

const describeIfEmbedding = isEmbeddingArtifactInstalled() ? describe : describe.skip;

describeIfEmbedding('retrieval quality (hybrid)', () => {
	it(`answers every query with recall@3 ≥ ${HYBRID_FLOOR_AT_3}`, () => {
		const result = measure(QUERIES);
		if (result.at3 < HYBRID_FLOOR_AT_3) console.error('misses:', result.misses);
		expect(result.at3).toBeGreaterThanOrEqual(HYBRID_FLOOR_AT_3);
	});

	it(`answers every query with recall@1 ≥ ${HYBRID_FLOOR_AT_1}`, () => {
		expect(measure(QUERIES).at1).toBeGreaterThanOrEqual(HYBRID_FLOOR_AT_1);
	});

	it('answers Indonesian questions about English memories', () => {
		// The single clearest justification for carrying a 41 MB artifact: these
		// queries share no token at all with the memory that answers them.
		const result = measure(QUERIES.filter(entry => entry.needsVector));
		if (result.at3 < 0.75) console.error('cross-language misses:', result.misses);
		expect(result.at3).toBeGreaterThanOrEqual(0.75);
	});
});
