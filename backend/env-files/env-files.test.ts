/**
 * Tests for the shared dotenv module.
 *
 * The cases here are the ones that destroy something when they are wrong:
 *
 *  - A value replaced IN PLACE must stay where it was, and the old one must
 *    survive as a comment. This is someone's configuration file, and the only
 *    reason it is safe to edit is that they can get the previous value back.
 *  - Backups must not stack, or a file written weekly grows a dead line a week.
 *  - A variable the file already has must be replaced WHERE IT IS. Appending a
 *    second copy at the end works — readers take the last assignment — and
 *    reads as if it does not, because the project's own value is still sitting
 *    at the top of the file.
 *  - Everything around either write must survive untouched.
 *  - A tracked file must be REFUSED unless the caller explicitly allows it:
 *    writing one commits a live database password, and for a worktree it also
 *    carries a disposable connection string into the main project.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execGit } from '$backend/git/git-executor';
import { formatEnvLine, isSafeEnvFileName, isValidEnvKey } from './keys';
import { effectiveAssignment, parseDotenv } from './parse';
import { PREVIOUS_VALUE_PREFIX, removeEnvKeys, upsertEnvKeys } from './edit';
import { listDotenvFiles, listEnvFileEntries } from './discovery';
import { clearWorktreeEnv, planEnvWrite, writeEnvVars, writeWorktreeEnv } from './write';

const URI = 'postgresql://owner:pw@ep-x.eu-central-1.aws.neon.tech/neondb?sslmode=require';

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), 'clopen-envfile-'));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function initRepo(): Promise<void> {
	await execGit(['init'], root);
	await execGit(['config', 'user.email', 'test@example.com'], root);
	await execGit(['config', 'user.name', 'Test'], root);
}

describe('formatEnvLine', () => {
	it('leaves a connection URI unquoted', () => {
		// A URI is percent-encoded, so the common case needs no quoting — and an
		// unquoted value is what a human expects to read.
		expect(formatEnvLine('DATABASE_URL', URI)).toBe(`DATABASE_URL=${URI}`);
	});

	it('quotes a value that would otherwise become a comment', () => {
		expect(formatEnvLine('K', 'a#b')).toBe('K="a#b"');
		expect(formatEnvLine('K', 'has space')).toBe('K="has space"');
		expect(formatEnvLine('K', '')).toBe('K=""');
	});

	it('escapes what the quotes would otherwise end', () => {
		expect(formatEnvLine('K', 'say "hi"')).toBe('K="say \\"hi\\""');
		expect(formatEnvLine('K', 'back\\slash')).toBe('K="back\\\\slash"');
	});
});

describe('isValidEnvKey', () => {
	it('accepts shell-legal names and refuses the rest', () => {
		expect(isValidEnvKey('DATABASE_URL')).toBe(true);
		expect(isValidEnvKey('_x1')).toBe(true);
		expect(isValidEnvKey('1DB')).toBe(false);
		expect(isValidEnvKey('DB-URL')).toBe(false);
		expect(isValidEnvKey('')).toBe(false);
	});
});

describe('parseDotenv', () => {
	it('records where each assignment lives, and how far it runs', () => {
		const content = ['A=1', 'export B="two"', 'C=3'].join('\n');
		const parsed = parseDotenv(content);

		expect(parsed.map((entry) => entry.key)).toEqual(['A', 'B', 'C']);
		expect(parsed[1]).toMatchObject({ value: 'two', line: 1, lineCount: 1, exported: true });
		expect(parsed[2].line).toBe(2);
	});

	it('reads a quoted value that runs past its first line', () => {
		// A multi-line certificate or private key is the real case, and a parser
		// that stopped at the newline would report the next line as a new key.
		const content = 'KEY="line one\nline two"\nAFTER=1';
		const parsed = parseDotenv(content);

		expect(parsed[0]).toMatchObject({ key: 'KEY', value: 'line one\nline two', lineCount: 2 });
		expect(parsed[1]).toMatchObject({ key: 'AFTER', line: 2 });
	});

	it('strips an inline comment from an unquoted value but not a quoted one', () => {
		expect(parseDotenv('A=1 # why')[0].value).toBe('1');
		expect(parseDotenv('A="1 # why"')[0].value).toBe('1 # why');
	});

	it('marks a commented assignment instead of ignoring it', () => {
		// `.env.example` documents optional settings as `# REDIS_URL=`, and that
		// file is often the only record of the names a project expects.
		const parsed = parseDotenv('# REDIS_URL=redis://localhost\nA=1');
		expect(parsed[0]).toMatchObject({ key: 'REDIS_URL', commented: true });
		expect(parsed[1]).toMatchObject({ key: 'A', commented: false });
	});

	it('does not read prose as an assignment', () => {
		expect(parseDotenv('# the value = whatever you like')).toEqual([]);
	});

	it('takes the LAST uncommented assignment as the effective one', () => {
		// Which is what every reader in common use does, and therefore what
		// decides whether writing a variable has any effect at all.
		const parsed = parseDotenv('A=first\n# A=commented\nA=second');
		expect(effectiveAssignment(parsed, 'A')?.value).toBe('second');
		expect(effectiveAssignment(parsed, 'MISSING')).toBe(null);
	});
});

describe('upsertEnvKeys — in place', () => {
	it('replaces the value where it stands and keeps the old one as a comment', () => {
		const existing = ['# my config', 'DATABASE_URL=postgres://old', 'OTHER=1'].join('\n');
		const result = upsertEnvKeys(existing, { DATABASE_URL: URI });

		expect(result.updated).toEqual(['DATABASE_URL']);
		expect(result.appended).toEqual([]);
		// Still on the same line, still between the comment and OTHER.
		const lines = result.text.split('\n');
		expect(lines[0]).toBe('# my config');
		expect(lines[1]).toBe(`${PREVIOUS_VALUE_PREFIX}DATABASE_URL=postgres://old`);
		expect(lines[2]).toBe(`DATABASE_URL=${URI}`);
		expect(result.text).toContain('OTHER=1');
		// Nothing was appended, so the file did not grow a second section.
		expect(result.text.split('\n')).toHaveLength(4);
	});

	it('does not stack a second backup on the next write', () => {
		const once = upsertEnvKeys('DATABASE_URL=one', { DATABASE_URL: 'two' });
		const twice = upsertEnvKeys(once.text, { DATABASE_URL: 'three' });

		expect(twice.text.match(new RegExp(PREVIOUS_VALUE_PREFIX, 'g'))).toHaveLength(1);
		expect(twice.text).toContain('DATABASE_URL=three');
		expect(twice.text).toContain(`${PREVIOUS_VALUE_PREFIX}DATABASE_URL=two`);
		expect(twice.text).not.toContain('DATABASE_URL=one');
	});

	it('leaves a backup belonging to a key it is not writing', () => {
		const existing = [
			`${PREVIOUS_VALUE_PREFIX}REDIS_URL=redis://old`,
			'REDIS_URL=redis://new',
			'DATABASE_URL=one'
		].join('\n');
		const result = upsertEnvKeys(existing, { DATABASE_URL: 'two' });

		expect(result.text).toContain(`${PREVIOUS_VALUE_PREFIX}REDIS_URL=redis://old`);
	});

	it('reports a key that already holds the value and touches nothing', () => {
		const existing = 'DATABASE_URL=same\n';
		const result = upsertEnvKeys(existing, { DATABASE_URL: 'same' });

		expect(result.unchanged).toEqual(['DATABASE_URL']);
		expect(result.text).toBe(existing);
	});

	it('updates the LAST assignment, which is the one that wins', () => {
		const result = upsertEnvKeys('DB=first\nDB=second', { DB: 'third' });

		expect(result.text).toContain('DB=first');
		expect(result.text).toContain('DB=third');
		expect(result.text.indexOf('DB=third')).toBeGreaterThan(result.text.indexOf('DB=first'));
	});

	it('ignores a commented assignment and appends instead', () => {
		// `# DATABASE_URL=` is documentation. Uncommenting it would turn a note
		// into configuration the user never asked to switch on.
		const result = upsertEnvKeys('# DATABASE_URL=postgres://example', { DATABASE_URL: URI });

		expect(result.appended).toEqual(['DATABASE_URL']);
		expect(result.text).toContain('# DATABASE_URL=postgres://example');
		expect(result.text).toContain(`DATABASE_URL=${URI}`);
	});

	it('replaces a multi-line quoted value without eating the line after it', () => {
		const existing = 'CERT="a\nb"\nDATABASE_URL=old\nKEEP=1';
		const result = upsertEnvKeys(existing, { DATABASE_URL: 'new' });

		expect(result.text).toContain('CERT="a\nb"');
		expect(result.text).toContain('DATABASE_URL=new');
		expect(result.text).toContain('KEEP=1');
	});

	it('splits a mixed write between replacing and appending', () => {
		const result = upsertEnvKeys(
			'DB_HOST=localhost',
			{ DB_HOST: 'db.example.com', DB_PASSWORD: 'pw' },
			{ note: 'from DB Client' }
		);

		expect(result.updated).toEqual(['DB_HOST']);
		expect(result.appended).toEqual(['DB_PASSWORD']);
		expect(result.text).toContain('DB_HOST=db.example.com');
		expect(result.text).toContain('# from DB Client');
		expect(result.text).toContain('DB_PASSWORD=pw');
	});
});

describe('Windows line endings', () => {
	it('parses a CRLF file at all', () => {
		// `.` does not match `\r` in JavaScript, so a pattern ending in `.*$` matched
		// NOTHING on a file written on Windows — detection found no variables and
		// every write appended a duplicate of a key that was already there.
		const parsed = parseDotenv('APP=1\r\nDATABASE_URL=postgres://old\r\n');
		expect(parsed.map((entry) => [entry.key, entry.value])).toEqual([
			['APP', '1'],
			['DATABASE_URL', 'postgres://old']
		]);
	});

	it('keeps CRLF through a write and an undo', () => {
		const original = 'APP=1\r\nDATABASE_URL=postgres://old\r\n';
		const written = upsertEnvKeys(original, { DATABASE_URL: URI });

		expect(written.updated).toEqual(['DATABASE_URL']);
		expect(written.text).not.toMatch(/[^\r]\n/);
		expect(removeEnvKeys(written.text, ['DATABASE_URL'])).toBe(original);
	});
});

describe('upsertEnvKeys — appending', () => {
	it('appends plain lines, with nothing announcing itself', () => {
		// What a dotenv file should look like after a variable is added to it is a
		// dotenv file with the variable in it. The markers exist to tell Clopen's
		// lines from the user's, and removal keeps that guarantee without them.
		const result = upsertEnvKeys('APP=1\n', { DATABASE_URL: URI });

		expect(result.appended).toEqual(['DATABASE_URL']);
		expect(result.text).toBe(`APP=1\n\nDATABASE_URL=${URI}\n`);
		expect(result.text).not.toContain('>>>');
	});

	it('writes into an empty file without a leading blank line', () => {
		expect(upsertEnvKeys('', { A: '1' }).text).toBe('A=1\n');
	});

	it('still replaces in place, so nothing is duplicated', () => {
		const result = upsertEnvKeys('DATABASE_URL=old\nAPP=1\n', { DATABASE_URL: 'new' });

		expect(result.updated).toEqual(['DATABASE_URL']);
		expect(result.text).toContain('DATABASE_URL=new');
		expect(result.text.match(/^DATABASE_URL=/gm)).toHaveLength(1);
	});
});

describe('removeEnvKeys', () => {
	it('removes what it appended and restores what it replaced', () => {
		const original = 'APP=1\nDATABASE_URL=postgres://mine\n';
		const written = upsertEnvKeys(original, {
			DATABASE_URL: URI,
			REDIS_URL: 'redis://x'
		});

		const restored = removeEnvKeys(written.text, ['DATABASE_URL', 'REDIS_URL'], {
			values: { DATABASE_URL: URI, REDIS_URL: 'redis://x' }
		});

		expect(restored).toContain('DATABASE_URL=postgres://mine');
		expect(restored).not.toContain('REDIS_URL');
		expect(restored).not.toContain(URI);
		expect(restored).toContain('APP=1');
		expect(restored).not.toContain(PREVIOUS_VALUE_PREFIX);
	});

	it('LEAVES a value the user has edited since', () => {
		// Without the block there is no marker saying the line is ours, so the
		// value is the evidence. One the user has changed is theirs now, and
		// deleting it would be this taking away a variable it did not put there.
		const written = upsertEnvKeys('APP=1\n', { REDIS_URL: 'redis://ours' });
		const edited = written.text.replace('redis://ours', 'redis://theirs');

		const result = removeEnvKeys(edited, ['REDIS_URL'], {
			values: { REDIS_URL: 'redis://ours' }
		});

		expect(result).toContain('REDIS_URL=redis://theirs');
	});

	it('does not touch a key it was never given a value for', () => {
		const content = 'DATABASE_URL=postgres://theirs\n';
		expect(removeEnvKeys(content, ['DATABASE_URL'])).toBe(content);
	});
});

describe('listEnvFileEntries / listDotenvFiles', () => {
	it('puts the highest-precedence file first', async () => {
		await fs.writeFile(path.join(root, '.env'), 'A=1');
		await fs.writeFile(path.join(root, '.env.local'), 'A=2');

		expect(await listDotenvFiles(root)).toEqual(['.env.local', '.env']);
	});

	it('leaves templates out of the writable list but reports them separately', async () => {
		await fs.writeFile(path.join(root, '.env'), 'A=1');
		await fs.writeFile(path.join(root, '.env.example'), 'A=');

		expect(await listDotenvFiles(root)).toEqual(['.env']);
		expect(await listEnvFileEntries(root)).toEqual([
			{ name: '.env', isTemplate: false },
			{ name: '.env.example', isTemplate: true }
		]);
	});

	it('answers empty for a directory that does not exist', async () => {
		expect(await listDotenvFiles(path.join(root, 'nope'))).toEqual([]);
	});
});

describe('writeEnvVars', () => {
	it('writes, and reports the file as unchanged on a second identical write', async () => {
		await initRepo();
		await fs.writeFile(path.join(root, '.gitignore'), '.env\n');

		const first = await writeEnvVars({
			root,
			fileName: '.env',
			vars: { DATABASE_URL: URI },
			note: 'DB Client'
		});
		expect(first.status).toBe('written');
		expect(first.appended).toEqual(['DATABASE_URL']);

		const second = await writeEnvVars({
			root,
			fileName: '.env',
			vars: { DATABASE_URL: URI },
			note: 'DB Client'
		});
		expect(second.status).toBe('unchanged');
	});

	it('REFUSES a file git tracks, and says why', async () => {
		await initRepo();
		await fs.writeFile(path.join(root, '.env'), 'KEEP=me\n');
		await execGit(['add', '.env'], root);
		await execGit(['commit', '-m', 'add env'], root);

		const result = await writeEnvVars({
			root,
			fileName: '.env',
			vars: { DATABASE_URL: URI },
		});

		expect(result.status).toBe('skipped-tracked');
		expect(result.detail).toContain('.gitignore');
		// Untouched — the refusal is the point.
		expect(await fs.readFile(path.join(root, '.env'), 'utf-8')).toBe('KEEP=me\n');
	});

	it('writes a tracked file when the caller explicitly allows it', async () => {
		await initRepo();
		await fs.writeFile(path.join(root, '.env'), 'KEEP=me\n');
		await execGit(['add', '.env'], root);
		await execGit(['commit', '-m', 'add env'], root);

		const result = await writeEnvVars({
			root,
			fileName: '.env',
			vars: { DATABASE_URL: URI },
			allowTracked: true
		});

		expect(result.status).toBe('written');
		expect(await fs.readFile(path.join(root, '.env'), 'utf-8')).toContain(URI);
	});

	it('refuses an unsafe file name without touching the disk', async () => {
		const result = await writeEnvVars({
			root,
			fileName: '../escape',
			vars: { K: 'V' },
		});

		expect(result.status).toBe('failed');
		await expect(fs.access(path.join(root, '..', 'escape'))).rejects.toThrow();
	});
});

describe('planEnvWrite', () => {
	it('describes the write without performing it', async () => {
		await fs.writeFile(path.join(root, '.env'), 'DATABASE_URL=old\n');

		const plan = await planEnvWrite({
			root,
			fileName: '.env',
			vars: { DATABASE_URL: URI },
		});

		expect(plan.exists).toBe(true);
		expect(plan.updated).toEqual(['DATABASE_URL']);
		expect(plan.next).toContain(URI);
		// The file itself is still as it was.
		expect(await fs.readFile(path.join(root, '.env'), 'utf-8')).toBe('DATABASE_URL=old\n');
	});
});

describe('writeWorktreeEnv', () => {
	it('writes the block and preserves the rest of the file', async () => {
		await initRepo();
		await fs.writeFile(path.join(root, '.gitignore'), '.env\n');
		await fs.writeFile(path.join(root, '.env'), 'KEEP=me\n');

		const result = await writeWorktreeEnv({
			worktreeRoot: root,
			fileName: '.env',
			vars: { DATABASE_URL: URI },
			note: 'Neon branch "clopen/acme/x"'
		});

		expect(result.status).toBe('written');
		const contents = await fs.readFile(path.join(root, '.env'), 'utf-8');
		expect(contents).toContain('KEEP=me');
		expect(contents).toContain(`DATABASE_URL=${URI}`);
		expect(contents).toContain('Neon branch');
	});

	it('REPLACES the inherited copy rather than appending past it', async () => {
		// A worktree is a FILE COPY of the project and carries the project's own
		// `DATABASE_URL`. An earlier version appended a block at the end and let
		// the last-assignment rule win: it worked, and it read as if it did not,
		// because the project's own database was still the first thing in the
		// file. The value is replaced where it stands and the old one survives as
		// the comment above it.
		await initRepo();
		await fs.writeFile(path.join(root, '.gitignore'), '.env\n');
		await fs.writeFile(
			path.join(root, '.env'),
			'# Database\nDATABASE_URL=postgres://main\nPORT=3000\n'
		);

		await writeWorktreeEnv({
			worktreeRoot: root,
			fileName: '.env',
			vars: { DATABASE_URL: URI }
		});

		const contents = await fs.readFile(path.join(root, '.env'), 'utf-8');
		expect(contents).toBe(
			`# Database\n${PREVIOUS_VALUE_PREFIX}DATABASE_URL=postgres://main\nDATABASE_URL=${URI}\nPORT=3000\n`
		);
		// Nothing announcing itself, and nothing appended past the end.
		expect(contents).not.toContain('>>>');
	});

	it('REFUSES a file git tracks, with the reason branching cares about', async () => {
		await initRepo();
		await fs.writeFile(path.join(root, '.env'), 'KEEP=me\n');
		await execGit(['add', '.env'], root);
		await execGit(['commit', '-m', 'add env'], root);

		const result = await writeWorktreeEnv({
			worktreeRoot: root,
			fileName: '.env',
			vars: { DATABASE_URL: URI }
		});

		expect(result.status).toBe('skipped-tracked');
		expect(result.detail).toContain('main project');
		expect(await fs.readFile(path.join(root, '.env'), 'utf-8')).toBe('KEEP=me\n');
	});

	it('reports an identical rewrite as written, not as something to retry', async () => {
		await initRepo();
		await fs.writeFile(path.join(root, '.gitignore'), '.env\n');

		const vars = { DATABASE_URL: URI };
		await writeWorktreeEnv({ worktreeRoot: root, fileName: '.env', vars });
		const again = await writeWorktreeEnv({ worktreeRoot: root, fileName: '.env', vars });

		expect(again.status).toBe('written');
	});

	it('refuses an unsafe file name without touching the disk', async () => {
		const result = await writeWorktreeEnv({
			worktreeRoot: root,
			fileName: '../escape',
			vars: { K: 'V' }
		});

		expect(result.status).toBe('failed');
		await expect(fs.access(path.join(root, '..', 'escape'))).rejects.toThrow();
	});
});

describe('clearWorktreeEnv', () => {
	it('puts the project’s own value back', async () => {
		await initRepo();
		await fs.writeFile(path.join(root, '.gitignore'), '.env\n');
		const target = path.join(root, '.env');
		await fs.writeFile(target, 'KEEP=me\nDATABASE_URL=postgres://main\n');
		await writeWorktreeEnv({ worktreeRoot: root, fileName: '.env', vars: { DATABASE_URL: URI } });

		await clearWorktreeEnv(root, '.env', { DATABASE_URL: URI });

		expect(await fs.readFile(target, 'utf-8')).toBe('KEEP=me\nDATABASE_URL=postgres://main\n');
	});

	it('does nothing when there is no file', async () => {
		await clearWorktreeEnv(root, '.env');
		await expect(fs.access(path.join(root, '.env'))).rejects.toThrow();
	});
});
