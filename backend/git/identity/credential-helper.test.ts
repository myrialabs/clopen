/**
 * The credential path, end to end, against real git.
 *
 * Unit tests cover the shape of the environment; they cannot catch what this
 * file exists for. Two bugs got through them and were only found by running
 * git:
 *
 *  1. `credential.helper` is a MULTI-VALUE key. The user's global config
 *     normally names one (osxkeychain, libsecret, manager), it is consulted
 *     before ours, and first answer wins — so choosing the "Work" account and
 *     pushing authenticated with whatever the system keychain volunteered. It
 *     failed silently: the push succeeded, under the wrong account.
 *  2. Connecting the database manager is not the same as registering it, so the
 *     helper threw `Database not initialized` and answered nothing, which git
 *     reports as "could not read Password".
 *
 * Everything runs in its own data directory and its own repository, so the
 * developer's real `~/.clopen` and git config are never touched. A system
 * credential helper being configured on the machine is not a problem for this
 * test — it is the thing being tested against.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildGitIdentityEnv } from './env';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const CLI_ENTRY = join(REPO_ROOT, 'bin/clopen.ts');

let dataDir = '';
let repoDir = '';

/** Identity env as the real builder produces it, pointed at the real CLI. */
function identityEnv(): Record<string, string> {
	return buildGitIdentityEnv(
		{
			id: 'id-test',
			name: 'Ada Lovelace',
			email: 'ada@example.com',
			httpsUsername: 'ada',
			credentialHosts: ['github.com']
		},
		{ runtime: process.execPath, script: CLI_ENTRY }
	);
}

async function run(
	cmd: string[],
	options: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
	const proc = Bun.spawn(cmd, {
		cwd: options.cwd ?? repoDir,
		env: { ...process.env, ...(options.env ?? {}) } as Record<string, string>,
		stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text()
	]);
	return { stdout, stderr, code: await proc.exited };
}

beforeAll(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'clopen-cred-data-'));
	repoDir = await mkdtemp(join(tmpdir(), 'clopen-cred-repo-'));
	await run(['git', 'init', '-q', '.']);

	// Seed an identity in the isolated data directory, through the real query
	// layer so the token is sealed exactly as it is in production.
	const seed = `
		import { initializeDatabase, getDatabase } from '$backend/database';
		import { gitIdentityQueries } from '$backend/database/queries';
		await initializeDatabase();
		const now = new Date().toISOString();
		getDatabase().prepare(
			\`INSERT INTO users (id, name, color, avatar, role, created_at, updated_at)
			 VALUES ('u-test', 'Ada', '#fff', 'a', 'admin', ?, ?)\`
		).run(now, now);
		gitIdentityQueries.create('id-test', 'u-test', {
			label: 'Work',
			name: 'Ada Lovelace',
			email: 'ada@example.com',
			authMethod: 'https-token',
			hosts: ['github.com'],
			httpsUsername: 'ada',
			httpsToken: 'test-token-value'
		});
	`;
	const seedFile = join(REPO_ROOT, `.seed-identity-${process.pid}.ts`);
	await Bun.write(seedFile, seed);
	try {
		const result = await run([process.execPath, 'run', seedFile], {
			cwd: REPO_ROOT,
			env: { CLOPEN_DATA_DIR: dataDir }
		});
		if (result.code !== 0) throw new Error(`seeding failed: ${result.stderr}`);
	} finally {
		await rm(seedFile, { force: true });
	}
}, 120_000);

afterAll(async () => {
	await rm(dataDir, { recursive: true, force: true });
	await rm(repoDir, { recursive: true, force: true });
});

describe('the git credential helper', () => {
	test('answers with the identity\'s credential for a claimed host', async () => {
		const result = await run([process.execPath, CLI_ENTRY, 'git-credential', '--identity=id-test', 'get'], {
			env: { CLOPEN_DATA_DIR: dataDir },
			stdin: 'protocol=https\nhost=github.com\npath=owner/repo.git\n\n'
		});
		expect(result.stdout).toContain('username=ada');
		expect(result.stdout).toContain('password=test-token-value');
	}, 60_000);

	test('declines for a host the identity does not claim', async () => {
		// Otherwise a repository whose remote moved to another host would be
		// handed this account's token.
		const result = await run([process.execPath, CLI_ENTRY, 'git-credential', '--identity=id-test', 'get'], {
			env: { CLOPEN_DATA_DIR: dataDir },
			stdin: 'protocol=https\nhost=gitlab.com\n\n'
		});
		expect(result.stdout.trim()).toBe('');
	}, 60_000);

	test('writes nothing but the protocol to stdout', async () => {
		// Git parses stdout. A stray log line there corrupts the answer, which is
		// why the helper silences routine logging.
		const result = await run([process.execPath, CLI_ENTRY, 'git-credential', '--identity=id-test', 'get'], {
			env: { CLOPEN_DATA_DIR: dataDir },
			stdin: 'protocol=https\nhost=github.com\n\n'
		});
		const lines = result.stdout.trim().split('\n');
		expect(lines).toEqual(['username=ada', 'password=test-token-value']);
	}, 60_000);

	test('ignores store and erase, leaving Clopen the owner of the credential', async () => {
		for (const operation of ['store', 'erase']) {
			const result = await run([process.execPath, CLI_ENTRY, 'git-credential', '--identity=id-test', operation], {
				env: { CLOPEN_DATA_DIR: dataDir },
				stdin: 'protocol=https\nhost=github.com\nusername=x\npassword=y\n\n'
			});
			expect(result.code).toBe(0);
			expect(result.stdout.trim()).toBe('');
		}
		// The stored token is untouched by either.
		const after = await run([process.execPath, CLI_ENTRY, 'git-credential', '--identity=id-test', 'get'], {
			env: { CLOPEN_DATA_DIR: dataDir },
			stdin: 'protocol=https\nhost=github.com\n\n'
		});
		expect(after.stdout).toContain('password=test-token-value');
	}, 120_000);
});

describe('git consuming the identity environment', () => {
	test('uses our helper rather than the machine\'s configured one', async () => {
		const result = await run(['git', 'credential', 'fill'], {
			env: { ...identityEnv(), CLOPEN_DATA_DIR: dataDir },
			stdin: 'protocol=https\nhost=github.com\n\n'
		});
		expect(result.stdout).toContain('username=ada');
		expect(result.stdout).toContain('password=test-token-value');
	}, 60_000);

	test('a helper already configured on the machine cannot answer first', async () => {
		// The regression guard for bug (1), made deterministic: rather than relying
		// on whatever credential helper this machine happens to have, the test
		// repository configures one of its own. Local config is read before the
		// environment's, so without the empty-value reset this intruder answers
		// first and the push authenticates as the wrong account — silently, since
		// the push still succeeds.
		//
		// The identity here has NO username, which is the vulnerable shape: a
		// `credential.<url>.username` narrows the lookup enough that a real
		// keychain often misses and hides the bug.
		const repoWithHelper = await mkdtemp(join(tmpdir(), 'clopen-cred-intruder-'));
		try {
			await run(['git', 'init', '-q', '.'], { cwd: repoWithHelper });
			await run(
				[
					'git',
					'config',
					'--local',
					'credential.helper',
					'!f() { echo username=intruder; echo password=wrong-token; }; f'
				],
				{ cwd: repoWithHelper }
			);

			// The developer's own global config is pinned out of the way, so the
			// test asserts against a known helper instead of whatever this machine
			// happens to have installed. (Which, notably, wins over local config —
			// that is how the original bug reached a real push.)
			const isolate = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

			// Sanity check: the intruder does answer when we are not involved.
			const withoutUs = await run(['git', 'credential', 'fill'], {
				cwd: repoWithHelper,
				env: isolate,
				stdin: 'protocol=https\nhost=github.com\n\n'
			});
			expect(withoutUs.stdout).toContain('password=wrong-token');

			const env = buildGitIdentityEnv(
				{
					id: 'id-test',
					name: 'Ada Lovelace',
					email: 'ada@example.com',
					credentialHosts: ['github.com']
				},
				{ runtime: process.execPath, script: CLI_ENTRY }
			);

			const withUs = await run(['git', 'credential', 'fill'], {
				cwd: repoWithHelper,
				env: { ...env, ...isolate, CLOPEN_DATA_DIR: dataDir },
				stdin: 'protocol=https\nhost=github.com\n\n'
			});
			expect(withUs.stdout).not.toContain('wrong-token');
			expect(withUs.stdout).not.toContain('intruder');
			expect(withUs.stdout).toContain('password=test-token-value');
		} finally {
			await rm(repoWithHelper, { recursive: true, force: true });
		}
	}, 120_000);

	test('leaves a host the identity does not claim to the machine', async () => {
		// The reset is scoped by the helper itself declining, not by removing the
		// user's helpers for every host — so an unclaimed host still has no
		// Clopen-supplied credential.
		const result = await run(['git', 'credential', 'fill'], {
			env: { ...identityEnv(), CLOPEN_DATA_DIR: dataDir, GIT_TERMINAL_PROMPT: '0' },
			stdin: 'protocol=https\nhost=gitlab.com\n\n'
		});
		expect(result.stdout).not.toContain('test-token-value');
	}, 60_000);
});
