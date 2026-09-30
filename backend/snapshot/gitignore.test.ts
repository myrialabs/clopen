/**
 * The non-git scan: what it skips, and what it admits it could not read.
 *
 * A directory the scan could not list is not a directory whose files were
 * deleted, and the snapshot can only tell the two apart if the scan says so.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanSnapshotFiles } from './gitignore';

let root: string;

async function write(file: string, content = 'x'): Promise<void> {
	await mkdir(path.dirname(path.join(root, file)), { recursive: true });
	await writeFile(path.join(root, file), content);
}

const relative = (files: string[]) => files.map((f) => path.relative(root, f).replace(/\\/g, '/')).sort();

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'clopen-scan-'));
});

afterEach(async () => {
	await chmod(path.join(root, 'locked'), 0o755).catch(() => {});
	await rm(root, { recursive: true, force: true });
});

describe('scanSnapshotFiles without git', () => {
	it('prunes generated directories by name, by manifest and by signature', async () => {
		await write('src/app.ts');
		await write('dist/app.js');
		await write('Cargo.toml');
		await write('target/debug/app');
		await write('env/pyvenv.cfg');
		await write('env/lib/site.py');

		const { files } = await scanSnapshotFiles(root, { pruneGenerated: true });
		expect(relative(files)).toEqual(['Cargo.toml', 'src/app.ts']);
	});

	it('keeps them when not asked to prune', async () => {
		await write('src/app.ts');
		await write('dist/app.js');

		const { files } = await scanSnapshotFiles(root);
		expect(relative(files)).toEqual(['dist/app.js', 'src/app.ts']);
	});

	it('reports a directory it could not read', async () => {
		await write('src/app.ts');
		await write('locked/secret.ts');
		await chmod(path.join(root, 'locked'), 0o000);

		const scan = await scanSnapshotFiles(root, { pruneGenerated: true });
		expect(relative(scan.files)).toEqual(['src/app.ts']);
		expect(scan.incomplete).toEqual(['locked/']);
	});
});
