#!/usr/bin/env bun
/**
 * Build the Memory Graph embedding artifact (published as a GitHub release).
 *
 * The Memory Graph embeds text locally so retrieval never needs an API key or a
 * network round trip. The source model is `minishlab/potion-multilingual-128M`
 * (MIT) — a model2vec *static* embedding model, which at inference time is a
 * plain token → vector lookup plus mean pooling. That is why Clopen needs no
 * ONNX, no WASM and no native binary to run it.
 *
 * Shipping it as published is not an option: the raw table is 500,353 × 256
 * float32 = 512 MB. This script shrinks it ~12× with no meaningful quality loss:
 *
 *   1. Drop every token whose surface form is not Latin/ASCII. XLM-RoBERTa's
 *      vocabulary covers 101 languages; CJK, Cyrillic, Arabic, Devanagari and
 *      friends are dead weight for a graph of Indonesian/English prose and
 *      source code — 46% of the table.
 *   2. Keep the highest-scoring VOCAB_LIMIT survivors, ranked by the Unigram
 *      log-probability the vocabulary already carries (higher = more frequent).
 *      The tokenizer is rebuilt over exactly this vocabulary, so Viterbi
 *      re-segments honestly into tokens that still exist.
 *   3. Quantize each row to int8 with its own scale. Measured on a 32-doc /
 *      35-query Indonesian→English retrieval set, int8 is free: MRR 0.877 vs
 *      0.876 for float32.
 *
 * Measured trade-off (same eval set), so the constant below can be moved with
 * eyes open:
 *
 *   float32, full vocab   512.4 MB   recall@1 80%   recall@3 94%   MRR 0.876
 *   int8, 270k tokens      73.6 MB   recall@1 80%   recall@3 94%   MRR 0.877
 *   int8, 150k tokens      40.8 MB   recall@1 77%   recall@3 91%   MRR 0.853  ← shipped
 *   int8, 100k tokens      27.1 MB   recall@1 74%   recall@3 91%   MRR 0.832
 *   int8,  60k tokens      16.2 MB   recall@1 69%   recall@3 83%   MRR 0.787
 *   int8,  40k tokens      10.8 MB   recall@1 57%   recall@3 83%   MRR 0.707
 *
 * recall@3 matters more than recall@1 here because vector hits are fused with
 * BM25 through RRF rather than used alone — see backend/memory/retrieval.ts.
 *
 * Usage:
 *   bun scripts/build-embedding-artifact.ts [--cache <dir>] [--out <dir>] [--vocab <n>] [--install]
 *
 * `--cache` holds the downloaded upstream files so repeat builds skip the
 * 512 MB fetch. The emitted `model/` directory holds the release assets; it is
 * generated, so it is gitignored and produced at release time.
 *
 * `--install` additionally copies the result into the local Clopen stack
 * directories (both `~/.clopen` and `~/.clopen-dev`), which is how the artifact
 * is exercised before a release is cut. At runtime Clopen downloads the same
 * files from a GitHub release asset and verifies them against the checksums this
 * script prints — paste those into `EMBEDDING_ASSETS` in
 * `backend/memory/embedding/paths.ts` when publishing.
 */

import { mkdir, writeFile, readFile, stat, cp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = 'minishlab/potion-multilingual-128M';
const FILES = ['model.safetensors', 'tokenizer.json', 'tokenizer_config.json'] as const;
const DIM = 256;

/** Must match EMBEDDING_VERSION in backend/memory/embedding/paths.ts. */
const EMBEDDING_VERSION = '0.0.1';

/** Latin letters, ASCII punctuation/digits, Latin-1/Extended-A and Latin Extended Additional, plus the Metaspace marker. */
const LATIN_ONLY = /^[▁ -~À-ɏḀ-ỿ]+$/;

interface Args { cache: string; out: string; vocabLimit: number; install: boolean }

function parseArgs(): Args {
	const argv = Bun.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i === -1 ? undefined : argv[i + 1];
	};
	return {
		cache: resolve(get('--cache') ?? join(import.meta.dir, '..', '.cache', 'embedding-src')),
		out: resolve(get('--out') ?? join(import.meta.dir, '..', 'packages', 'clopen-embedding')),
		vocabLimit: Number(get('--vocab') ?? 150_000),
		install: argv.includes('--install')
	};
}

/**
 * Copy the built files into the local Clopen stack directories so a dev machine
 * can exercise the runtime path before a release exists.
 *
 * BOTH `~/.clopen` and `~/.clopen-dev` are written. They are separate data
 * directories chosen by NODE_ENV, and installing into only the one that happened
 * to match this script's environment is exactly how the artifact ended up
 * invisible to a `bun run dev` session once already.
 */
async function installLocally(out: string, version: string): Promise<void> {
	for (const dirName of ['.clopen', '.clopen-dev']) {
		const dest = join(homedir(), dirName, 'stack', 'embedding', version);
		await rm(dest, { recursive: true, force: true });
		await mkdir(dest, { recursive: true });
		await cp(join(out, 'model'), dest, { recursive: true });
		console.log(`installed: ${dest}`);
	}
}

async function download(cacheDir: string, file: string): Promise<string> {
	const dest = join(cacheDir, file);
	try {
		const s = await stat(dest);
		if (s.size > 0) {
			console.log(`  cached  ${file} (${(s.size / 1e6).toFixed(1)} MB)`);
			return dest;
		}
	} catch {
		// not cached yet
	}

	const url = `https://huggingface.co/${REPO}/resolve/main/${file}`;
	process.stdout.write(`  fetch   ${file} … `);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
	const buf = new Uint8Array(await res.arrayBuffer());
	await writeFile(dest, buf);
	console.log(`${(buf.byteLength / 1e6).toFixed(1)} MB`);
	return dest;
}

/** Read the `embeddings` tensor out of a safetensors file. */
async function readEmbeddings(path: string): Promise<{ weights: Float32Array; rows: number }> {
	const f = Bun.file(path);
	const headerLen = Number(new DataView(await f.slice(0, 8).arrayBuffer()).getBigUint64(0, true));
	const header = JSON.parse(await f.slice(8, 8 + headerLen).text()) as Record<
		string,
		{ dtype: string; shape: number[]; data_offsets: [number, number] }
	>;
	const tensor = header.embeddings;
	if (!tensor) throw new Error('safetensors file has no "embeddings" tensor');
	if (tensor.dtype !== 'F32') throw new Error(`expected F32 embeddings, got ${tensor.dtype}`);
	const [rows, dim] = tensor.shape;
	if (dim !== DIM) throw new Error(`expected ${DIM} dimensions, got ${dim}`);

	const [start, end] = tensor.data_offsets;
	const bytes = await f.slice(8 + headerLen + start, 8 + headerLen + end).arrayBuffer();
	return { weights: new Float32Array(bytes), rows };
}

async function main(): Promise<void> {
	const { cache, out, vocabLimit, install } = parseArgs();
	console.log(`building embedding artifact v${EMBEDDING_VERSION} (vocab limit ${vocabLimit.toLocaleString()})\n`);

	await mkdir(cache, { recursive: true });
	console.log(`source: ${REPO}`);
	const paths: Record<string, string> = {};
	for (const file of FILES) paths[file] = await download(cache, file);

	const tokenizer = JSON.parse(await readFile(paths['tokenizer.json'], 'utf8')) as {
		model: { type: string; vocab: [string, number][]; unk_id?: number };
	};
	if (tokenizer.model.type !== 'Unigram') {
		throw new Error(`expected a Unigram tokenizer, got ${tokenizer.model.type}`);
	}
	const vocab = tokenizer.model.vocab;
	const { weights, rows } = await readEmbeddings(paths['model.safetensors']);
	if (rows !== vocab.length) {
		throw new Error(`vocab/row mismatch: ${vocab.length} tokens vs ${rows} rows`);
	}
	console.log(`\nupstream: ${rows.toLocaleString()} rows × ${DIM} dims (${(weights.byteLength / 1e6).toFixed(1)} MB)`);

	// ── select the vocabulary to keep ──────────────────────────────────────
	// Ids 0 and 1 are [PAD] and [UNK]; keeping them at their original indices
	// preserves the tokenizer's unk_id, so the rebuilt config stays valid.
	const RESERVED = 2;
	const candidates: number[] = [];
	for (let i = RESERVED; i < vocab.length; i++) {
		if (LATIN_ONLY.test(vocab[i][0])) candidates.push(i);
	}
	console.log(`latin-script tokens: ${candidates.length.toLocaleString()} (${(candidates.length / vocab.length * 100).toFixed(1)}%)`);

	candidates.sort((a, b) => vocab[b][1] - vocab[a][1]);
	const keep = [0, 1, ...candidates.slice(0, Math.max(0, vocabLimit - RESERVED))];
	console.log(`keeping:             ${keep.length.toLocaleString()}`);

	// ── quantize: int8 per row, one float32 scale per row ──────────────────
	const kept = keep.length;
	const quant = new Int8Array(kept * DIM);
	const scales = new Float32Array(kept);
	for (let r = 0; r < kept; r++) {
		const src = keep[r] * DIM;
		let max = 0;
		for (let d = 0; d < DIM; d++) {
			const v = Math.abs(weights[src + d]);
			if (v > max) max = v;
		}
		const scale = max / 127 || 1;
		scales[r] = scale;
		const dst = r * DIM;
		for (let d = 0; d < DIM; d++) quant[dst + d] = Math.round(weights[src + d] / scale);
	}

	// ── emit ──────────────────────────────────────────────────────────────
	// model.bin layout (all little-endian):
	//   magic "CLPEMB\0\1" (8 bytes) | rows u32 | dim u32 | scales f32[rows] | quant i8[rows*dim]
	const header = new ArrayBuffer(16);
	const hv = new DataView(header);
	new Uint8Array(header, 0, 8).set(new TextEncoder().encode('CLPEMB\0'));
	hv.setUint32(8, kept, true);
	hv.setUint32(12, DIM, true);

	const modelDir = join(out, 'model');
	await mkdir(modelDir, { recursive: true });

	await Bun.write(join(modelDir, 'model.bin'), new Blob([header, scales.buffer, quant.buffer]));

	const prunedTokenizer = { ...tokenizer, model: { ...tokenizer.model, vocab: keep.map(i => vocab[i]) } };
	await writeFile(join(modelDir, 'tokenizer.json'), JSON.stringify(prunedTokenizer));
	await writeFile(join(modelDir, 'tokenizer_config.json'), await readFile(paths['tokenizer_config.json'], 'utf8'));

	const modelBytes = (await stat(join(modelDir, 'model.bin'))).size;
	const tokBytes = (await stat(join(modelDir, 'tokenizer.json'))).size;

	await writeFile(
		join(modelDir, 'manifest.json'),
		JSON.stringify(
			{
				source: REPO,
				sourceLicense: 'MIT',
				rows: kept,
				dim: DIM,
				quantization: 'int8-per-row',
				vocabLimit,
				builtFrom: { rows, dim: DIM }
			},
			null,
			'\t'
		) + '\n'
	);

	console.log(`\nwrote ${out}`);
	console.log(`  model.bin        ${(modelBytes / 1e6).toFixed(1)} MB`);
	console.log(`  tokenizer.json   ${(tokBytes / 1e6).toFixed(1)} MB`);
	console.log(`  total            ${((modelBytes + tokBytes) / 1e6).toFixed(1)} MB`);

	// Checksums for `EMBEDDING_ASSETS` in backend/memory/embedding/paths.ts. The
	// runtime refuses to download without them, so a release is not publishable
	// until these are pasted in.
	console.log('\nEMBEDDING_ASSETS (paste into backend/memory/embedding/paths.ts):');
	const assets: { file: string; sha256: string; bytes: number }[] = [];
	for (const file of ['model.bin', 'tokenizer.json', 'tokenizer_config.json', 'manifest.json']) {
		const bytes = new Uint8Array(await readFile(join(modelDir, file)));
		assets.push({ file, sha256: Bun.SHA256.hash(bytes, 'hex'), bytes: bytes.byteLength });
	}
	for (const asset of assets) {
		console.log(`\t{ file: '${asset.file}', sha256: '${asset.sha256}', bytes: ${asset.bytes} },`);
	}
	await writeFile(join(out, 'checksums.json'), JSON.stringify(assets, null, '\t') + '\n');

	if (install) await installLocally(out, EMBEDDING_VERSION);
}

await main();
