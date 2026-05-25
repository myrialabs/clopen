import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Stub settingsQueries before importing the module under test so the file-size
// limit is controllable and never touches a real database during unit tests.
let mockSettingsRow: { key: string; value: string; updated_at: string } | null = null;
await mock.module('../database/queries', () => ({
	settingsQueries: {
		get: (_key: string) => mockSettingsRow,
		getAll: () => [],
		set: () => {},
		delete: () => {}
	}
}));

const { extractZipOperation } = await import('./file-archive');

function setLimitMB(mb: number): void {
	mockSettingsRow = {
		key: 'system:settings',
		value: JSON.stringify({ maxFileSizeMB: mb }),
		updated_at: ''
	};
}

function writeU32(buf: Uint8Array, off: number, val: number): void {
	buf[off] = val & 0xff;
	buf[off + 1] = (val >>> 8) & 0xff;
	buf[off + 2] = (val >>> 16) & 0xff;
	buf[off + 3] = (val >>> 24) & 0xff;
}

function readU32(buf: Uint8Array, off: number): number {
	return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

// Overwrite the uncompressed-size fields in a single-file zip's local and
// central headers with a forged (tiny) value, leaving the compressed data and
// compressed-size fields intact. Models an attacker lying about extracted size
// to slip past any check that trusts the zip metadata. Assumes no archive
// comment (true for fflate's zipSync output).
function forgeUncompressedSizes(zip: Uint8Array, fakeSize: number): Uint8Array {
	const out = zip.slice();
	const eocd = out.length - 22;
	const cdOffset = readU32(out, eocd + 16);
	writeU32(out, cdOffset + 24, fakeSize); // central directory header
	writeU32(out, 22, fakeSize); // local file header (single file at offset 0)
	return out;
}

describe('extractZipOperation — output-size cap', () => {
	let testDir: string;

	beforeEach(async () => {
		mockSettingsRow = null;
		testDir = join(tmpdir(), `clopen-archive-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(testDir, { recursive: true });
	});

	afterEach(async () => {
		mockSettingsRow = null;
		await rm(testDir, { recursive: true, force: true });
	});

	test('extracts a normal archive and writes its contents', async () => {
		const { zipSync } = await import('fflate');
		const zip = zipSync(
			{
				'file1.txt': new TextEncoder().encode('Hello world, this is a test file'),
				'file2.txt': new TextEncoder().encode('Another test file with some content')
			},
			{ level: 6 }
		);
		const archivePath = join(testDir, 'normal.zip');
		const extractDir = join(testDir, 'extracted');
		await Bun.write(archivePath, zip);

		const result = await extractZipOperation(archivePath, extractDir);

		expect(result.entries).toBe(2);
		expect(await Bun.file(join(extractDir, 'file1.txt')).text()).toBe('Hello world, this is a test file');
		expect(await Bun.file(join(extractDir, 'file2.txt')).text()).toBe('Another test file with some content');
	});

	test('rejects when actual decompressed output exceeds the limit', async () => {
		// 4MB of zeros compresses to a few KB, so the compressed archive sails
		// past the compressed-size guard — only the streaming output cap catches it.
		setLimitMB(1);
		const { zipSync } = await import('fflate');
		const zip = zipSync({ 'big.bin': new Uint8Array(4 * 1024 * 1024) }, { level: 9 });
		const archivePath = join(testDir, 'big.zip');
		await Bun.write(archivePath, zip);

		expect(zip.byteLength).toBeLessThan(1024 * 1024); // compressed archive is under the limit

		await expect(extractZipOperation(archivePath, join(testDir, 'out'))).rejects.toThrow(
			/exceeds maximum allowed size/
		);
	});

	test('rejects even when the zip metadata forges a tiny uncompressed size', async () => {
		// The whole point of the reshape: the cap counts ACTUAL decompressed
		// bytes, so lying about the size in the central directory cannot bypass it.
		setLimitMB(1);
		const { zipSync } = await import('fflate');
		const honest = zipSync({ 'bomb.bin': new Uint8Array(4 * 1024 * 1024) }, { level: 9 });
		const forged = forgeUncompressedSizes(honest, 10);

		const eocd = forged.length - 22;
		const cdOffset = readU32(forged, eocd + 16);
		expect(readU32(forged, cdOffset + 24)).toBe(10); // metadata now claims 10 bytes

		const archivePath = join(testDir, 'forged.zip');
		await Bun.write(archivePath, forged);

		await expect(extractZipOperation(archivePath, join(testDir, 'out'))).rejects.toThrow(
			/exceeds maximum allowed size/
		);
	});

	test('rejects path-traversal entries before writing them', async () => {
		const { zipSync } = await import('fflate');
		const zip = zipSync({ '../escape.txt': new TextEncoder().encode('nope') }, { level: 6 });
		const archivePath = join(testDir, 'traversal.zip');
		await Bun.write(archivePath, zip);

		await expect(extractZipOperation(archivePath, join(testDir, 'out'))).rejects.toThrow(/Unsafe path/);
	});
});
