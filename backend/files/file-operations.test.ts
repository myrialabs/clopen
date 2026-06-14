import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { rm, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Stub settingsQueries so the module under test never touches a real database.
await mock.module('../database/queries', () => ({
	settingsQueries: {
		get: () => null,
		getAll: () => [],
		set: () => {},
		delete: () => {}
	}
}));

const { deleteOperation, renameOperation, createDirectoryOperation } = await import('./file-operations');

// Shell-special name that would break cmd /c or rm -f via argument injection.
const SPECIAL_NAME = 'foo & bar.txt';

describe('file-operations — shell-special filenames', () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = join(tmpdir(), `clopen-file-ops-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(testDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	test('deleteOperation removes a file whose name contains shell metacharacters', async () => {
		const filePath = join(testDir, SPECIAL_NAME);
		await Bun.write(filePath, 'contents');

		await expect(deleteOperation(filePath)).resolves.toMatchObject({ message: 'File deleted successfully' });
		await expect(stat(filePath)).rejects.toThrow();
	});

	test('deleteOperation removes an empty directory', async () => {
		const dirPath = join(testDir, 'empty-dir');
		await mkdir(dirPath, { recursive: true });

		await expect(deleteOperation(dirPath)).resolves.toMatchObject({ message: 'Directory deleted successfully' });
		await expect(stat(dirPath)).rejects.toThrow();
	});

	test('deleteOperation force-removes a non-empty directory', async () => {
		const dirPath = join(testDir, 'non-empty-dir');
		await mkdir(dirPath, { recursive: true });
		await Bun.write(join(dirPath, 'child.txt'), 'contents');

		await expect(deleteOperation(dirPath, true)).resolves.toMatchObject({ message: 'Directory deleted successfully' });
		await expect(stat(dirPath)).rejects.toThrow();
	});

	test('renameOperation renames a file whose name contains shell metacharacters', async () => {
		const src = join(testDir, SPECIAL_NAME);
		const dest = join(testDir, 'safe-name.txt');
		await Bun.write(src, 'contents');

		await expect(renameOperation(src, dest)).resolves.toMatchObject({ message: 'File/directory renamed successfully' });
		await expect(stat(dest)).resolves.toBeTruthy();
		await expect(stat(src)).rejects.toThrow();
	});

	test('createDirectoryOperation creates a directory whose name contains shell metacharacters', async () => {
		const dirPath = join(testDir, 'dir & name');

		await expect(createDirectoryOperation(dirPath)).resolves.toMatchObject({ message: 'Directory created successfully' });
		const s = await stat(dirPath);
		expect(s.isDirectory()).toBe(true);
	});
});
