/**
 * Local text embedder for the Memory Graph.
 *
 * The model is a *static* embedding table (Model2Vec), so embedding a string is
 * tokenize → look each token's row up → mean-pool → L2-normalize. There is no
 * forward pass, which is why this runs in plain TypeScript on Bun with no ONNX
 * runtime, no WASM and no native binary. A query costs ~0.05 ms.
 *
 * The table is int8-quantized with a per-row scale (see
 * `scripts/build-embedding-artifact.ts`). Rows are dequantized while pooling
 * rather than up front, so only ~39 MB stays resident instead of ~154 MB.
 *
 * Vectors are persisted quantized too — 260 bytes per node instead of 1 KB —
 * because retrieval brute-forces the candidate set and wants it to fit in cache.
 */

import { join } from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import { debug } from '$shared/utils/logger';
import {
	EMBEDDING_VERSION,
	getEmbeddingModelDir,
	isEmbeddingArtifactInstalled,
	type EmbeddingManifest
} from './paths';

const MAGIC = 'CLPEMB\0';
const HEADER_BYTES = 16;

/** Longest input we embed. Static models have no context limit, but pooling a
 * whole file into one 256-dim vector stops being meaningful long before this. */
const MAX_CHARS = 8_000;

interface LoadedModel {
	tokenizer: Tokenizer;
	quant: Int8Array;
	scales: Float32Array;
	rows: number;
	dim: number;
	unkId: number;
}

export interface EmbedderStatus {
	ready: boolean;
	installed: boolean;
	version: string | null;
	dim: number | null;
	rows: number | null;
	error: string | null;
}

class Embedder {
	private model: LoadedModel | null = null;
	private loading: Promise<LoadedModel | null> | null = null;
	private lastError: string | null = null;

	/** Dimensionality of emitted vectors, or null before the model has loaded. */
	get dim(): number | null {
		return this.model?.dim ?? null;
	}

	get ready(): boolean {
		return this.model !== null;
	}

	status(): EmbedderStatus {
		return {
			ready: this.ready,
			installed: isEmbeddingArtifactInstalled(),
			version: isEmbeddingArtifactInstalled() ? EMBEDDING_VERSION : null,
			dim: this.model?.dim ?? null,
			rows: this.model?.rows ?? null,
			error: this.lastError
		};
	}

	/**
	 * Load the artifact if it is installed. Concurrent callers share one load.
	 * Returns null when the artifact is absent or unreadable — callers treat
	 * that as "no vector half this time" rather than an error, so the graph
	 * stays usable while the download is still in flight.
	 */
	async load(): Promise<boolean> {
		if (this.model) return true;
		if (!this.loading) {
			this.loading = this.doLoad().finally(() => {
				this.loading = null;
			});
		}
		return (await this.loading) !== null;
	}

	private async doLoad(): Promise<LoadedModel | null> {
		if (!isEmbeddingArtifactInstalled()) {
			this.lastError = 'embedding artifact is not installed';
			return null;
		}

		const dir = getEmbeddingModelDir();
		try {
			const started = performance.now();

			const manifest = JSON.parse(await Bun.file(join(dir, 'manifest.json')).text()) as EmbeddingManifest;
			const tokenizerJson = JSON.parse(await Bun.file(join(dir, 'tokenizer.json')).text()) as {
				model: { unk_id?: number };
			};
			const tokenizerConfig = JSON.parse(await Bun.file(join(dir, 'tokenizer_config.json')).text()) as Record<
				string,
				unknown
			>;
			const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);

			const buf = await Bun.file(join(dir, 'model.bin')).arrayBuffer();
			const magic = new TextDecoder().decode(new Uint8Array(buf, 0, MAGIC.length));
			if (magic !== MAGIC) throw new Error(`bad magic in model.bin: ${JSON.stringify(magic)}`);

			const view = new DataView(buf);
			const rows = view.getUint32(8, true);
			const dim = view.getUint32(12, true);
			if (rows !== manifest.rows || dim !== manifest.dim) {
				throw new Error(`model.bin (${rows}×${dim}) disagrees with manifest (${manifest.rows}×${manifest.dim})`);
			}

			const scalesEnd = HEADER_BYTES + rows * 4;
			const expected = scalesEnd + rows * dim;
			if (buf.byteLength !== expected) {
				throw new Error(`model.bin is ${buf.byteLength} bytes, expected ${expected}`);
			}

			const model: LoadedModel = {
				tokenizer,
				scales: new Float32Array(buf.slice(HEADER_BYTES, scalesEnd)),
				quant: new Int8Array(buf, scalesEnd),
				rows,
				dim,
				unkId: tokenizerJson.model.unk_id ?? 1
			};

			this.model = model;
			this.lastError = null;
			debug.log(
				'memory',
				`Embedder ready: ${rows.toLocaleString()}×${dim} int8 (${(buf.byteLength / 1e6).toFixed(1)} MB) ` +
					`in ${(performance.now() - started).toFixed(0)} ms`
			);
			return model;
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			debug.error('memory', 'Failed to load embedding artifact', error);
			return null;
		}
	}

	/**
	 * Embed one string. Returns null when the model is not loaded, when the text
	 * has no in-vocabulary tokens, or when it has fewer than `minTokens` of them.
	 *
	 * `minTokens` exists because mean pooling over very few tokens produces an
	 * unstable centroid: measured on this artifact, a two-token label like a bare
	 * package name scores 0.2+ against unrelated sentences, which is higher than
	 * many genuinely correct matches. Such vectors do not encode meaning, they
	 * encode noise, and they outrank real answers. Callers that index short
	 * labels should set a floor and let BM25 handle them — a filename is exactly
	 * what lexical search is best at anyway.
	 */
	embed(text: string, options?: { minTokens?: number }): Float32Array | null {
		const model = this.model;
		if (!model) return null;

		const trimmed = text.trim();
		if (!trimmed) return null;

		// No special tokens: the model pools raw content vectors, and [PAD]/[UNK]
		// would drag every embedding toward a shared centroid.
		const encoded = model.tokenizer.encode(
			trimmed.length > MAX_CHARS ? trimmed.slice(0, MAX_CHARS) : trimmed,
			{ add_special_tokens: false }
		);
		const ids = encoded.ids as ArrayLike<number>;

		const { quant, scales, dim, unkId, rows } = model;
		const out = new Float32Array(dim);
		let used = 0;

		for (let i = 0; i < ids.length; i++) {
			const id = ids[i];
			// Unknown tokens carry no signal, and an out-of-range id would read
			// past the table — both are dropped rather than pooled as zeros.
			if (id === unkId || id < 0 || id >= rows) continue;
			const off = id * dim;
			const scale = scales[id];
			for (let d = 0; d < dim; d++) out[d] += quant[off + d] * scale;
			used++;
		}

		if (used === 0 || used < (options?.minTokens ?? 1)) return null;

		let norm = 0;
		for (let d = 0; d < dim; d++) {
			out[d] /= used;
			norm += out[d] * out[d];
		}
		norm = Math.sqrt(norm);
		if (norm === 0) return null;
		for (let d = 0; d < dim; d++) out[d] /= norm;

		return out;
	}

	/** Embed many strings, preserving positions (null where embedding failed). */
	embedMany(texts: string[]): (Float32Array | null)[] {
		return texts.map(t => this.embed(t));
	}

	/** Drop the loaded table (used after an artifact update). */
	unload(): void {
		this.model = null;
		this.lastError = null;
	}
}

export const embedder = new Embedder();

// ─────────────────────────────────────────────────────────────────────────────
// Persistence helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pack a normalized vector into a compact BLOB: float32 scale followed by int8
 * components. 260 bytes for a 256-dim vector versus 1 KB as float32, which
 * matters because retrieval loads every candidate vector to score it.
 */
export function packVector(vec: Float32Array): Uint8Array {
	let max = 0;
	for (let i = 0; i < vec.length; i++) {
		const v = Math.abs(vec[i]);
		if (v > max) max = v;
	}
	const scale = max / 127 || 1;

	const out = new Uint8Array(4 + vec.length);
	new DataView(out.buffer).setFloat32(0, scale, true);
	const q = new Int8Array(out.buffer, 4);
	for (let i = 0; i < vec.length; i++) q[i] = Math.round(vec[i] / scale);
	return out;
}

/** Inverse of `packVector`. */
export function unpackVector(blob: Uint8Array): Float32Array {
	const scale = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getFloat32(0, true);
	const q = new Int8Array(blob.buffer, blob.byteOffset + 4, blob.byteLength - 4);
	const out = new Float32Array(q.length);
	for (let i = 0; i < q.length; i++) out[i] = q[i] * scale;
	return out;
}

/**
 * Cosine similarity between a query vector and a packed one. Both sides are
 * L2-normalized at creation, so the dot product *is* the cosine and no
 * per-comparison normalization is needed.
 */
export function cosineToPacked(query: Float32Array, blob: Uint8Array): number {
	const scale = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getFloat32(0, true);
	const q = new Int8Array(blob.buffer, blob.byteOffset + 4, blob.byteLength - 4);
	const n = Math.min(query.length, q.length);
	let dot = 0;
	for (let i = 0; i < n; i++) dot += query[i] * q[i];
	return dot * scale;
}
