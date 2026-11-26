import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execGit } from '$backend/git/git-executor';
import {
	ignoreScreenshotFolder,
	normalizeScreenshotFolder,
	sanitizeScreenshotFileName,
	saveScreenshotFile,
	uniqueFileName,
	withIgnoredFolder
} from './screenshot-files';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe('normalizeScreenshotFolder', () => {
	test('an empty folder is the default one', () => {
		expect(normalizeScreenshotFolder(undefined)).toBe('screenshots');
		expect(normalizeScreenshotFolder('  ')).toBe('screenshots');
		expect(normalizeScreenshotFolder('./')).toBe('screenshots');
	});

	test('tidies separators and dot segments', () => {
		expect(normalizeScreenshotFolder('docs//images/./shots/')).toBe('docs/images/shots');
		expect(normalizeScreenshotFolder('docs\\images')).toBe('docs/images');
	});

	test('refuses anything outside the project', () => {
		expect(() => normalizeScreenshotFolder('../elsewhere')).toThrow('inside the project');
		expect(() => normalizeScreenshotFolder('a/../../b')).toThrow('inside the project');
		expect(() => normalizeScreenshotFolder('/tmp/shots')).toThrow('inside the project');
		expect(() => normalizeScreenshotFolder('C:/shots')).toThrow('inside the project');
		expect(() => normalizeScreenshotFolder('.git/hooks')).toThrow('.git');
	});
});

describe('sanitizeScreenshotFileName', () => {
	test('keeps a plain name and sets the extension', () => {
		expect(sanitizeScreenshotFileName('localhost-5173-20261126-143005', 'png')).toBe('localhost-5173-20261126-143005.png');
		expect(sanitizeScreenshotFileName('shot.png', 'jpg')).toBe('shot.jpg');
	});

	test('nothing in it can be read as a path', () => {
		expect(sanitizeScreenshotFileName('../../etc/passwd', 'png')).toBe('etc-passwd.png');
		expect(sanitizeScreenshotFileName('a:b*c?', 'png')).toBe('a-b-c-.png');
		expect(sanitizeScreenshotFileName('...', 'png')).toBe('screenshot.png');
	});
});

describe('withIgnoredFolder', () => {
	test('appends a root-anchored entry, on its own line', () => {
		expect(withIgnoredFolder('', 'screenshots')).toBe('/screenshots/\n');
		expect(withIgnoredFolder('node_modules\n', 'screenshots')).toBe('node_modules\n/screenshots/\n');
		expect(withIgnoredFolder('node_modules', 'screenshots')).toBe('node_modules\n/screenshots/\n');
	});

	test('leaves a file that already covers the folder alone', () => {
		expect(withIgnoredFolder('/screenshots/\n', 'screenshots')).toBeNull();
		expect(withIgnoredFolder('screenshots/\n', 'screenshots')).toBeNull();
		expect(withIgnoredFolder('dist\r\nscreenshots\r\n', 'screenshots')).toBeNull();
	});
});

describe('saving into a workspace', () => {
	let root: string;

	async function git(...args: string[]) {
		const result = await execGit(args, root);
		if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
	}

	beforeEach(async () => {
		root = await realpath(await mkdtemp(path.join(tmpdir(), 'clopen-screenshots-')));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('never overwrites an earlier screenshot', async () => {
		const first = await saveScreenshotFile(root, 'shots', 'page', PNG, 'png');
		const second = await saveScreenshotFile(root, 'shots', 'page', PNG, 'png');
		expect(first.path).toBe('shots/page.png');
		expect(second.path).toBe('shots/page-2.png');
		expect(uniqueFileName(path.join(root, 'shots'), 'page.png')).toBe('page-3.png');
	});

	test('outside a repository there is nothing to warn about', async () => {
		const saved = await saveScreenshotFile(root, undefined, 'page', PNG, 'png');
		expect(saved).toEqual({ path: 'screenshots/page.png', folder: 'screenshots', git: 'no-repo' });
	});

	test('reports a file git would track, and ignoring the folder fixes it', async () => {
		await git('init', '-b', 'main', '.');

		const saved = await saveScreenshotFile(root, undefined, 'page', PNG, 'png');
		expect(saved.git).toBe('not-ignored');

		expect(await ignoreScreenshotFolder(root, saved.folder)).toBe('ignored');
		expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe('/screenshots/\n');

		const next = await saveScreenshotFile(root, undefined, 'page', PNG, 'png');
		expect(next.git).toBe('ignored');
	});

	test('a folder the project already ignores is reported as ignored', async () => {
		await git('init', '-b', 'main', '.');
		await writeFile(path.join(root, '.gitignore'), 'screenshots/\n');

		const saved = await saveScreenshotFile(root, undefined, 'page', PNG, 'png');
		expect(saved.git).toBe('ignored');
		// And nothing is added on top of the rule that already covers it.
		await ignoreScreenshotFolder(root, saved.folder);
		expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe('screenshots/\n');
	});
});
