import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

import { precompress } from './vite-precompress';

const dir = mkdtempSync(join(tmpdir(), 'clopen-precompress-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('writes .br and .gz for compressible assets only, and they decode to the original', () => {
	mkdirSync(join(dir, 'assets'));
	const js = 'export const x = 1;\n'.repeat(500);
	writeFileSync(join(dir, 'assets', 'main-abc12345.js'), js);
	writeFileSync(join(dir, 'assets', 'tiny.css'), 'a{}');
	writeFileSync(join(dir, 'sound.ogg'), Buffer.alloc(4096, 7));

	const plugin = precompress() as any;
	plugin.configResolved({ build: { outDir: dir } });
	plugin.closeBundle();

	const base = join(dir, 'assets', 'main-abc12345.js');
	expect(brotliDecompressSync(readFileSync(`${base}.br`)).toString()).toBe(js);
	expect(gunzipSync(readFileSync(`${base}.gz`)).toString()).toBe(js);
	expect(existsSync(join(dir, 'assets', 'tiny.css.br'))).toBe(false); // under 1 KB
	expect(existsSync(join(dir, 'sound.ogg.br'))).toBe(false); // already compressed media
});
