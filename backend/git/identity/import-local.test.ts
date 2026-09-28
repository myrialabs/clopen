/**
 * Mirroring the machine's git identity, against a real `git config --global`.
 *
 * Runs in a subprocess with `HOME` pointed at a temporary directory, so the
 * developer's own `~/.gitconfig` is neither read nor written and the result does
 * not depend on how this machine happens to be configured.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const dirs: string[] = [];

afterEach(async () => {
	let dir: string | undefined;
	while ((dir = dirs.pop())) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/**
 * Run `script` inside the repo with an isolated HOME and data directory.
 *
 * The script writes its result to stdout as JSON on the last line; everything
 * else there is Clopen's own startup logging.
 */
async function runInSandbox(
	script: string,
	env: { home: string; dataDir: string }
): Promise<any> {
	const file = join(REPO_ROOT, `.import-local-test-${process.pid}-${dirs.length}.ts`);
	await writeFile(file, script);
	try {
		const proc = Bun.spawn([process.execPath, 'run', file], {
			cwd: REPO_ROOT,
			env: {
				...process.env,
				HOME: env.home,
				// Git also reads the XDG path; pin it inside the sandbox too.
				XDG_CONFIG_HOME: join(env.home, '.config'),
				CLOPEN_DATA_DIR: env.dataDir
			} as Record<string, string>,
			stdout: 'pipe',
			stderr: 'pipe'
		});
		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text()
		]);
		const code = await proc.exited;
		const line = out.trim().split('\n').pop() ?? '';
		if (code !== 0) throw new Error(`sandbox failed (${code}): ${err}\n${out}`);
		return JSON.parse(line);
	} finally {
		await rm(file, { force: true });
	}
}

const PRELUDE = `
	import { initializeDatabase, getDatabase } from '$backend/database';
	import { gitIdentityService } from '$backend/git/identity';
	await initializeDatabase();
	const now = new Date().toISOString();
	getDatabase().prepare(
		\`INSERT INTO users (id, name, color, avatar, role, created_at, updated_at)
		 VALUES ('u1', 'User', '#fff', 'a', 'admin', ?, ?)\`
	).run(now, now);
`;

describe('mirroring the machine git identity', () => {
	test('a configured machine shows up in the list, as the default', async () => {
		const home = await tempDir('clopen-home-');
		const dataDir = await tempDir('clopen-data-');
		await writeFile(
			join(home, '.gitconfig'),
			'[user]\n\tname = Machine User\n\temail = machine@example.com\n'
		);

		const result = await runInSandbox(
			`${PRELUDE}
			const list = await gitIdentityService.list('u1');
			console.log(JSON.stringify(list.map((i) => ({
				label: i.label, name: i.name, email: i.email,
				isDefault: i.isDefault, source: i.source, canDelete: i.canDelete
			}))));`,
			{ home, dataDir }
		);

		expect(result).toEqual([
			{
				label: 'This machine',
				name: 'Machine User',
				email: 'machine@example.com',
				isDefault: true,
				source: 'local-machine',
				canDelete: false
			}
		]);
	}, 120_000);

	test('reading the list twice does not create a second copy', async () => {
		// The import runs on every read, so it has to be idempotent — otherwise
		// the list grows by one every time Settings is opened.
		const home = await tempDir('clopen-home-');
		const dataDir = await tempDir('clopen-data-');
		await writeFile(
			join(home, '.gitconfig'),
			'[user]\n\tname = Machine User\n\temail = machine@example.com\n'
		);

		const result = await runInSandbox(
			`${PRELUDE}
			await gitIdentityService.list('u1');
			await gitIdentityService.list('u1');
			const list = await gitIdentityService.list('u1');
			console.log(JSON.stringify({ count: list.length }));`,
			{ home, dataDir }
		);

		expect(result).toEqual({ count: 1 });
	}, 120_000);

	test('the mirrored account refuses to be deleted', async () => {
		const home = await tempDir('clopen-home-');
		const dataDir = await tempDir('clopen-data-');
		await writeFile(
			join(home, '.gitconfig'),
			'[user]\n\tname = Machine User\n\temail = machine@example.com\n'
		);

		const result = await runInSandbox(
			`${PRELUDE}
			const [mirrored] = await gitIdentityService.list('u1');
			let error = null;
			try { await gitIdentityService.remove('u1', mirrored.id); }
			catch (e) { error = e instanceof Error ? e.message : String(e); }
			const after = await gitIdentityService.list('u1');
			console.log(JSON.stringify({ error, stillThere: after.length }));`,
			{ home, dataDir }
		);

		expect(result.error).toContain('cannot be deleted');
		expect(result.stillThere).toBe(1);
	}, 120_000);

	test('editing it keeps it mirrored, and still undeletable', async () => {
		// An edit is a preference, not a conversion to a manual account — the
		// machine config it reflects has not gone anywhere.
		const home = await tempDir('clopen-home-');
		const dataDir = await tempDir('clopen-data-');
		await writeFile(
			join(home, '.gitconfig'),
			'[user]\n\tname = Machine User\n\temail = machine@example.com\n'
		);

		const result = await runInSandbox(
			`${PRELUDE}
			const [mirrored] = await gitIdentityService.list('u1');
			const updated = await gitIdentityService.update('u1', mirrored.id, {
				label: 'Renamed', name: 'Edited Name', email: 'edited@example.com',
				authMethod: 'none', hosts: []
			});
			console.log(JSON.stringify({
				name: updated.name, source: updated.source, canDelete: updated.canDelete
			}));`,
			{ home, dataDir }
		);

		expect(result).toEqual({
			name: 'Edited Name',
			source: 'local-machine',
			canDelete: false
		});
	}, 120_000);

	test('a machine with no global identity contributes nothing', async () => {
		// Half-configured counts as nothing: git itself refuses to commit with
		// only a name, so mirroring one would create an unusable account.
		const home = await tempDir('clopen-home-');
		const dataDir = await tempDir('clopen-data-');
		await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Only A Name\n');

		const result = await runInSandbox(
			`${PRELUDE}
			const list = await gitIdentityService.list('u1');
			console.log(JSON.stringify({ count: list.length }));`,
			{ home, dataDir }
		);

		expect(result).toEqual({ count: 0 });
	}, 120_000);
});
