/**
 * Vite build plugin: write `.br` and `.gz` siblings for every compressible
 * asset in the output, so the production server sends compressed bytes without
 * compressing anything at request time (backend/http/static-assets.ts).
 *
 * The frontend bundle is several megabytes of JavaScript and a Wasm engine;
 * sent raw, every page load cost ~8 MB where brotli needs ~1.6 MB.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';

/** Extensions worth compressing; media formats are already compressed. */
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.webmanifest', '.wasm', '.txt', '.xml', '.map']);

/** Below this a compressed copy saves less than its own overhead. */
const MIN_BYTES = 1024;

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(path);
		else yield path;
	}
}

export function precompress(): Plugin {
	let outDir = 'dist';
	return {
		name: 'clopen-precompress',
		apply: 'build',
		configResolved(config) {
			outDir = config.build.outDir;
		},
		closeBundle() {
			for (const path of walk(outDir)) {
				if (!COMPRESSIBLE.has(extname(path)) || statSync(path).size < MIN_BYTES) continue;
				const raw = readFileSync(path);
				const brotli = brotliCompressSync(raw, {
					params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length }
				});
				const gzip = gzipSync(raw, { level: 9 });
				// A copy that is not smaller is never served, so it is not written.
				if (brotli.length < raw.length) writeFileSync(`${path}.br`, brotli);
				if (gzip.length < raw.length) writeFileSync(`${path}.gz`, gzip);
			}
		}
	};
}
