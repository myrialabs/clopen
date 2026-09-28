/**
 * The terminal's config file, checked against real git.
 *
 * This file exists because the mechanism has one dangerous failure mode:
 * `GIT_CONFIG_GLOBAL` REPLACES `~/.gitconfig`. Get the `[include]` wrong and
 * every terminal silently loses the user's aliases, diff tool and everything
 * else they have configured — while the identity part still looks correct.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderScopeConfig } from './scope-config';

const dirs: string[] = [];
const originalXdg = process.env.XDG_CONFIG_HOME;

afterEach(async () => {
	let dir: string | undefined;
	while ((dir = dirs.pop())) await rm(dir, { recursive: true, force: true });
	if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalXdg;
});

/** A fake XDG git config the generated file should include. */
async function withUserConfig(contents: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'clopen-xdg-'));
	dirs.push(dir);
	await mkdir(join(dir, 'git'), { recursive: true });
	await writeFile(join(dir, 'git', 'config'), contents);
	process.env.XDG_CONFIG_HOME = dir;
	return dir;
}

async function writeGenerated(pairs: Array<[string, string]>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'clopen-scope-'));
	dirs.push(dir);
	const path = join(dir, 'generated.gitconfig');
	await writeFile(path, renderScopeConfig(pairs));
	return path;
}

async function gitConfig(key: string, configPath: string, cwd: string): Promise<string> {
	const proc = Bun.spawn(['git', 'config', '--get', key], {
		cwd,
		env: { ...process.env, GIT_CONFIG_GLOBAL: configPath, GIT_CONFIG_SYSTEM: '/dev/null' } as Record<
			string,
			string
		>,
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out.trim();
}

async function tempRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'clopen-scope-repo-'));
	dirs.push(dir);
	const proc = Bun.spawn(['git', 'init', '-q', '.'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
	await proc.exited;
	return dir;
}

describe('renderScopeConfig', () => {
	test('git reads the identity out of it', async () => {
		await withUserConfig('[alias]\n\tlg = log --oneline\n');
		const path = await writeGenerated([
			['user.name', 'Ada Lovelace'],
			['user.email', 'ada@example.com']
		]);
		const repo = await tempRepo();

		expect(await gitConfig('user.name', path, repo)).toBe('Ada Lovelace');
		expect(await gitConfig('user.email', path, repo)).toBe('ada@example.com');
	}, 60_000);

	test("the user's own global config survives", async () => {
		// The dangerous failure: GIT_CONFIG_GLOBAL replaces ~/.gitconfig, so
		// without the include the alias below would simply vanish in terminals.
		await withUserConfig('[alias]\n\tlg = log --oneline\n[core]\n\tpager = delta\n');
		const path = await writeGenerated([['user.email', 'ada@example.com']]);
		const repo = await tempRepo();

		expect(await gitConfig('alias.lg', path, repo)).toBe('log --oneline');
		expect(await gitConfig('core.pager', path, repo)).toBe('delta');
	}, 60_000);

	test('our value wins over the same key in the user config', async () => {
		// The include comes first precisely so this ordering holds.
		await withUserConfig('[user]\n\temail = machine@example.com\n');
		const path = await writeGenerated([['user.email', 'chosen@example.com']]);
		const repo = await tempRepo();

		expect(await gitConfig('user.email', path, repo)).toBe('chosen@example.com');
	}, 60_000);

	test('a URL subsection key survives verbatim', async () => {
		// `credential.https://host.username` has dots and slashes inside the
		// subsection; splitting it wrong is how the credential silently stops
		// matching the host.
		const path = await writeGenerated([
			['credential.https://github.com.username', 'ada'],
			['user.email', 'ada@example.com']
		]);
		const repo = await tempRepo();

		expect(await gitConfig('credential.https://github.com.username', path, repo)).toBe('ada');
	}, 60_000);

	test('a value with quotes and backslashes round-trips', async () => {
		const weird = `ssh -i "/keys/it's odd\\path" -o IdentitiesOnly=yes`;
		const path = await writeGenerated([['core.sshCommand', weird]]);
		const repo = await tempRepo();

		expect(await gitConfig('core.sshCommand', path, repo)).toBe(weird);
	}, 60_000);

	test('a multi-valued key keeps both entries in order', async () => {
		// The empty-then-helper pair that stops the machine's keychain answering.
		const path = await writeGenerated([
			['credential.helper', ''],
			['credential.helper', '!clopen-helper']
		]);
		const repo = await tempRepo();

		const proc = Bun.spawn(['git', 'config', '--get-all', 'credential.helper'], {
			cwd: repo,
			env: { ...process.env, GIT_CONFIG_GLOBAL: path, GIT_CONFIG_SYSTEM: '/dev/null' } as Record<
				string,
				string
			>,
			stdout: 'pipe',
			stderr: 'pipe'
		});
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		expect(out.split('\n').filter((l) => l !== '' || true).slice(0, 2)).toEqual([
			'',
			'!clopen-helper'
		]);
	}, 60_000);
});
