/**
 * Embedder tests.
 *
 * The weights are an on-demand artifact, so every case here is skipped when it
 * is absent (a fresh checkout, or CI) rather than failing. Build and install it
 * with `bun scripts/build-embedding-artifact.ts --install`.
 *
 * The retrieval case is the one that matters: it asserts the pruned, quantized
 * artifact still answers Indonesian questions about English memories. That is
 * the property the whole pruning trade-off was chosen against, so a regression
 * in the build script should fail here rather than quietly degrade recall.
 */

import { describe, expect, it } from 'bun:test';
import { embedder, packVector, unpackVector, cosineToPacked } from './embedder';
import { isEmbeddingArtifactInstalled } from './paths';

const installed = isEmbeddingArtifactInstalled();
const describeIfInstalled = installed ? describe : describe.skip;

if (!installed) {
	console.warn('embedding artifact not installed — skipping embedder tests');
}

/** English memories, shaped the way the episodic extractor writes them. */
const CORPUS = [
	'Decision: sessions are rejected when the auth token has expired; refresh happens on the WebSocket reconnect path',
	'Failure: bun add -g aborted mid-install because engine SDKs dragged 200-300 MB of native CLI binaries',
	'Decision: engine SDKs are installed on demand into the managed stack directory instead of being bundled',
	'Pattern: the file watcher only runs while the Files panel is mounted, so snapshots scan the disk instead',
	'Failure: Codex CLI exits with code 1 at startup when its home directory does not exist',
	'Decision: MCP OAuth is centralized in Clopen, which injects a Bearer token into every engine',
	'Pattern: Svelte 5 runes are used for state; traditional stores are avoided across the frontend',
	'Failure: the browser preview stayed stuck on Loading because early ICE candidates were not buffered',
	'Decision: chat messages use cursor pagination instead of loading the whole message chain',
	'Decision: a chat session may switch engine mid conversation; the branch is replayed as prompt content',
	'Observation: zstd compression is applied to large WebSocket responses to cut chat bandwidth',
	'Decision: permissions are enforced by a runtime hook because Clopen auto approves everything'
];

/** Indonesian queries paired with the memory they should surface. */
const QUERIES: [string, number][] = [
	['kenapa login-nya rusak?', 0],
	['instalasi global terhenti karena ukuran besar', 1],
	['bagaimana cara SDK engine dipasang?', 2],
	['kenapa snapshot tidak pakai file watcher?', 3],
	['codex error saat pertama dijalankan', 4],
	['siapa yang mengurus otentikasi MCP?', 5],
	['manajemen state di frontend pakai apa?', 6],
	['preview browser nyangkut di loading terus', 7],
	['pesan chat dimuat bertahap atau sekaligus?', 8],
	['bisakah ganti engine di tengah percakapan?', 9],
	['kenapa bandwidth chat dikompres?', 10],
	['izin tool ditegakkan di mana?', 11]
];

describeIfInstalled('embedder', () => {
	it('loads the artifact and reports its shape', async () => {
		expect(await embedder.load()).toBe(true);
		expect(embedder.ready).toBe(true);
		expect(embedder.dim).toBe(256);

		const status = embedder.status();
		expect(status.installed).toBe(true);
		expect(status.error).toBeNull();
		expect(status.rows).toBeGreaterThan(1000);
	});

	it('produces deterministic, L2-normalized vectors', async () => {
		await embedder.load();

		const a = embedder.embed('the auth token has expired');
		const b = embedder.embed('the auth token has expired');
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(Array.from(a!)).toEqual(Array.from(b!));

		let norm = 0;
		for (const v of a!) norm += v * v;
		expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
	});

	it('returns null for text with no usable tokens', async () => {
		await embedder.load();
		expect(embedder.embed('')).toBeNull();
		expect(embedder.embed('   \n  ')).toBeNull();
	});

	it('scores related text above unrelated text', async () => {
		await embedder.load();

		const query = embedder.embed('the session was rejected because the token expired')!;
		const related = embedder.embed(CORPUS[0])!;
		const unrelated = embedder.embed(CORPUS[6])!;

		const dot = (x: Float32Array, y: Float32Array): number => {
			let s = 0;
			for (let i = 0; i < x.length; i++) s += x[i] * y[i];
			return s;
		};
		expect(dot(query, related)).toBeGreaterThan(dot(query, unrelated));
	});

	it('round-trips vectors through the packed representation', async () => {
		await embedder.load();

		const vec = embedder.embed('engine SDKs are installed on demand')!;
		const packed = packVector(vec);
		expect(packed.byteLength).toBe(4 + vec.length);

		const restored = unpackVector(packed);
		for (let i = 0; i < vec.length; i++) expect(restored[i]).toBeCloseTo(vec[i], 2);

		// A packed self-comparison is a cosine of 1 up to quantization error.
		expect(cosineToPacked(vec, packed)).toBeCloseTo(1, 2);
	});

	it('retrieves English memories from Indonesian queries', async () => {
		await embedder.load();

		const docs = CORPUS.map(c => embedder.embed(c)!).map(packVector);
		let hitsAt1 = 0;
		let hitsAt3 = 0;

		for (const [question, gold] of QUERIES) {
			const query = embedder.embed(question)!;
			const ranked = docs
				.map((doc, index) => ({ score: cosineToPacked(query, doc), index }))
				.sort((a, b) => b.score - a.score);

			if (ranked[0].index === gold) hitsAt1++;
			if (ranked.slice(0, 3).some(r => r.index === gold)) hitsAt3++;
		}

		// Thresholds sit below the measured build (10/12 and 12/12) so ordinary
		// quantization jitter does not fail the suite, while a real regression —
		// a broken tokenizer, a mis-sliced table, an over-aggressive prune — will.
		expect(hitsAt3).toBeGreaterThanOrEqual(10);
		expect(hitsAt1).toBeGreaterThanOrEqual(7);
	});
});
