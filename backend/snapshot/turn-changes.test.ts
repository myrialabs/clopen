/**
 * Turning a checkpoint's stored hashes into a file list.
 *
 * This is what every AI-change surface counts on: the dot in Files, the gutter
 * in the editor, and the Changes tab all describe the same turn, so a file that
 * this function drops is a change the user is never told about. The cases that
 * matter are the ones where a side is absent — a creation, a deletion, a blob
 * the store no longer has — because each of those used to be either invisible
 * or a diff of nothing.
 */

import { describe, it, expect } from 'bun:test';

import {
	buildTurnFiles,
	statusOf,
	isBinaryBuffer,
	summariseTurnFiles,
	excerptPrompt
} from './turn-changes';

/** Blob reader over an in-memory store, so the tests own their failure modes. */
function readerFor(blobs: Record<string, string | Buffer>) {
	return async (hash: string): Promise<Buffer> => {
		const value = blobs[hash];
		if (value === undefined) throw new Error(`missing blob ${hash}`);
		return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
	};
}

describe('statusOf', () => {
	it('reads a missing old side as a creation and a missing new side as a deletion', () => {
		expect(statusOf('', 'new')).toBe('added');
		expect(statusOf('old', '')).toBe('deleted');
		expect(statusOf('old', 'new')).toBe('modified');
	});
});

describe('isBinaryBuffer', () => {
	it('calls a NUL byte binary and plain text not', () => {
		expect(isBinaryBuffer(Buffer.from([0x68, 0x00, 0x69]))).toBe(true);
		expect(isBinaryBuffer(Buffer.from('hello\nworld', 'utf8'))).toBe(false);
	});
});

describe('buildTurnFiles', () => {
	it('counts a modification with the lines that actually changed', async () => {
		const files = await buildTurnFiles(
			{ 'src/a.ts': { oldHash: 'h1', newHash: 'h2' } },
			readerFor({ h1: 'a\nb\nc\n', h2: 'a\nB\nc\n' })
		);

		expect(files).toEqual([
			{
				path: 'src/a.ts',
				status: 'modified',
				insertions: 1,
				deletions: 1,
				isBinary: false,
				contentAvailable: true
			}
		]);
	});

	it('counts a created file as all insertions', async () => {
		const [file] = await buildTurnFiles(
			{ 'src/new.ts': { oldHash: '', newHash: 'h2' } },
			readerFor({ h2: 'one\ntwo\n' })
		);

		expect(file.status).toBe('added');
		expect(file.insertions).toBe(2);
		expect(file.deletions).toBe(0);
	});

	it('reports a deleted file, which a tool-call reading could never see', async () => {
		const [file] = await buildTurnFiles(
			{ 'src/gone.ts': { oldHash: 'h1', newHash: '' } },
			readerFor({ h1: 'one\ntwo\nthree\n' })
		);

		expect(file.status).toBe('deleted');
		expect(file.insertions).toBe(0);
		expect(file.deletions).toBe(3);
	});

	it('keeps a binary file in the list but does not pretend to count its lines', async () => {
		const [file] = await buildTurnFiles(
			{ 'assets/logo.png': { oldHash: 'h1', newHash: 'h2' } },
			readerFor({ h1: Buffer.from([0x89, 0x00, 0x01]), h2: Buffer.from([0x89, 0x00, 0x02]) })
		);

		expect(file.isBinary).toBe(true);
		expect(file.insertions).toBe(0);
		expect(file.deletions).toBe(0);
		expect(file.contentAvailable).toBe(true);
	});

	it('keeps the row when a blob is gone, flagged so the UI can say why', async () => {
		const [file] = await buildTurnFiles(
			{ 'src/a.ts': { oldHash: 'missing', newHash: 'h2' } },
			readerFor({ h2: 'a\n' })
		);

		expect(file.status).toBe('modified');
		expect(file.contentAvailable).toBe(false);
		expect(file.insertions).toBe(0);
		expect(file.deletions).toBe(0);
	});

	it('orders files by path, so a refetch does not move rows under the cursor', async () => {
		const files = await buildTurnFiles(
			{
				'src/z.ts': { oldHash: '', newHash: 'h' },
				'src/a.ts': { oldHash: '', newHash: 'h' },
				'README.md': { oldHash: '', newHash: 'h' }
			},
			readerFor({ h: 'x\n' })
		);

		expect(files.map((f) => f.path)).toEqual(['README.md', 'src/a.ts', 'src/z.ts']);
	});

	it('answers an empty turn with an empty list', async () => {
		expect(await buildTurnFiles({}, readerFor({}))).toEqual([]);
	});
});

describe('summariseTurnFiles', () => {
	it('adds up a turn for its header', async () => {
		const files = await buildTurnFiles(
			{
				'src/a.ts': { oldHash: 'h1', newHash: 'h2' },
				'src/b.ts': { oldHash: '', newHash: 'h3' }
			},
			readerFor({ h1: 'a\n', h2: 'b\n', h3: 'c\nd\n' })
		);

		expect(summariseTurnFiles(files)).toEqual({
			filesChanged: 2,
			insertions: 3,
			deletions: 1
		});
	});
});

describe('excerptPrompt', () => {
	it('returns a short prompt whole, trimmed', () => {
		expect(excerptPrompt('  make the theme green  ', 20)).toBe('make the theme green');
	});

	it('marks a cut prompt, so a row never reads as the whole question', () => {
		expect(excerptPrompt('abcdefghij', 5)).toBe('abcde…');
	});

	it('does not leave the ellipsis hanging off a space', () => {
		expect(excerptPrompt('abc def ghi', 4)).toBe('abc…');
	});

	it('answers empty for an empty prompt', () => {
		expect(excerptPrompt('   ', 10)).toBe('');
	});
});
