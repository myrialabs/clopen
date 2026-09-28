import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGitConfigPairs, buildGitIdentityEnv, remoteHost } from './env';

const helper = { runtime: '/usr/local/bin/bun', script: '/opt/clopen/index.js' };

function pairsOf(env: Record<string, string>): Array<[string, string]> {
	const count = Number(env.GIT_CONFIG_COUNT ?? 0);
	return Array.from({ length: count }, (_, i) => [
		env[`GIT_CONFIG_KEY_${i}`]!,
		env[`GIT_CONFIG_VALUE_${i}`]!
	]);
}

describe('buildGitIdentityEnv', () => {
	test('no identity yields no variables, so callers can merge unconditionally', () => {
		expect(buildGitIdentityEnv(null)).toEqual({});
	});

	test('emits a well-formed GIT_CONFIG_* block', () => {
		const env = buildGitIdentityEnv({ id: 'i1', name: 'Ada', email: 'ada@example.com' });
		expect(env.GIT_CONFIG_COUNT).toBe('2');
		expect(pairsOf(env)).toEqual([
			['user.name', 'Ada'],
			['user.email', 'ada@example.com']
		]);
	});

	test('the index is contiguous from zero — git stops reading at the first gap', () => {
		const env = buildGitIdentityEnv(
			{
				id: 'i1',
				name: 'Ada',
				email: 'ada@example.com',
				sshKeyPath: '/keys/id_ed25519',
				credentialHosts: ['github.com'],
				httpsUsername: 'ada'
			},
			helper
		);
		const count = Number(env.GIT_CONFIG_COUNT);
		for (let i = 0; i < count; i++) {
			expect(env[`GIT_CONFIG_KEY_${i}`]).toBeString();
			expect(env[`GIT_CONFIG_VALUE_${i}`]).toBeString();
		}
		expect(env[`GIT_CONFIG_KEY_${count}`]).toBeUndefined();
	});

	test('ssh keys are pinned with IdentitiesOnly', () => {
		// Without this the agent still offers every other key and the push can
		// silently authenticate as the wrong account.
		const pairs = buildGitConfigPairs({
			id: 'i1',
			name: 'Ada',
			email: 'ada@example.com',
			sshKeyPath: '/keys/id_ed25519'
		});
		const ssh = pairs.find(([k]) => k === 'core.sshCommand')?.[1];
		expect(ssh).toContain('-o IdentitiesOnly=yes');
		expect(ssh).toContain(`-i '/keys/id_ed25519'`);
	});

	test('a key path with shell metacharacters cannot break out', () => {
		const pairs = buildGitConfigPairs({
			id: 'i1',
			name: 'Ada',
			email: 'ada@example.com',
			sshKeyPath: "/keys/'; rm -rf /; echo '"
		});
		const ssh = pairs.find(([k]) => k === 'core.sshCommand')?.[1] ?? '';
		// Every embedded quote is escaped, so the payload stays one argument.
		expect(ssh).toContain(`'\\''`);
		expect(ssh.startsWith('ssh -i ')).toBe(true);
	});

	test('the credential helper is only wired when a host is claimed', () => {
		const withoutHosts = buildGitConfigPairs(
			{ id: 'i1', name: 'Ada', email: 'ada@example.com', credentialHosts: [] },
			helper
		);
		expect(withoutHosts.some(([k]) => k === 'credential.helper')).toBe(false);

		const withHosts = buildGitConfigPairs(
			{ id: 'i1', name: 'Ada', email: 'ada@example.com', credentialHosts: ['github.com'] },
			helper
		);
		const cred = withHosts.filter(([k]) => k === 'credential.helper').map(([, v]) => v);

		// Two entries, in this order, and the order is the whole point: the empty
		// value clears the helpers the machine already configured, so ours is the
		// only one git asks. Reversed or missing, a system keychain answers first
		// and the push authenticates as the wrong account.
		expect(cred.length).toBe(2);
		expect(cred[0]).toBe('');
		expect(cred[1]!.startsWith('!')).toBe(true);
		expect(cred[1]).toContain('git-credential');
		expect(cred[1]).toContain('--identity=i1');
	});

	test('no secret is ever placed in the environment', () => {
		const env = buildGitIdentityEnv(
			{
				id: 'i1',
				name: 'Ada',
				email: 'ada@example.com',
				sshKeyPath: '/keys/id_ed25519',
				needsPassphrase: true,
				httpsUsername: 'ada',
				credentialHosts: ['github.com']
			},
			helper
		);
		// argv and the environment are readable; the helpers exist so secrets
		// travel over stdout instead.
		const blob = JSON.stringify(env);
		expect(blob).not.toContain('PRIVATE KEY');
		expect(blob).not.toContain('passphrase');
		expect(blob).not.toContain('token');
	});

	test('a passphrased key forces askpass so a PTY shell cannot hang on the prompt', () => {
		const env = buildGitIdentityEnv(
			{
				id: 'i1',
				name: 'Ada',
				email: 'ada@example.com',
				sshKeyPath: '/keys/id_ed25519',
				needsPassphrase: true
			},
			helper
		);
		expect(env.SSH_ASKPASS).toContain('git-askpass');
		expect(env.SSH_ASKPASS_REQUIRE).toBe('force');
		expect(env.DISPLAY).toBeTruthy();
	});

	test('a key without a passphrase does not drag askpass in', () => {
		const env = buildGitIdentityEnv(
			{ id: 'i1', name: 'Ada', email: 'ada@example.com', sshKeyPath: '/keys/id_ed25519' },
			helper
		);
		expect(env.SSH_ASKPASS).toBeUndefined();
	});
});

describe('remoteHost', () => {
	test('reads scp-like remotes, where the colon is a path and not a port', () => {
		expect(remoteHost('git@github.com:owner/repo.git')).toBe('github.com');
		expect(remoteHost('github.com:owner/repo.git')).toBe('github.com');
	});

	test('reads URL remotes', () => {
		expect(remoteHost('https://github.com/owner/repo.git')).toBe('github.com');
		expect(remoteHost('ssh://git@git.example.com:2222/owner/repo.git')).toBe('git.example.com');
		expect(remoteHost('https://GitHub.com/owner/repo')).toBe('github.com');
	});

	test('local paths have no host', () => {
		expect(remoteHost('/srv/repos/thing.git')).toBeNull();
		expect(remoteHost('file:///srv/repos/thing.git')).toBeNull();
		expect(remoteHost('')).toBeNull();
	});
});

describe('the env block against real git', () => {
	test('a commit made with it carries the identity, and the repo stays clean', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'clopen-git-identity-'));
		try {
			const git = async (args: string[], env: Record<string, string> = {}) => {
				const proc = Bun.spawn(['git', ...args], {
					cwd: dir,
					env: { ...process.env, ...env } as Record<string, string>,
					stdout: 'pipe',
					stderr: 'pipe'
				});
				const [out, err] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text()
				]);
				const code = await proc.exited;
				if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${err}`);
				return out.trim();
			};

			await git(['init', '-q', '.']);
			await Bun.write(join(dir, 'a.txt'), 'hello');
			await git(['add', 'a.txt']);

			const env = buildGitIdentityEnv({
				id: 'i1',
				name: 'Grace Hopper',
				email: 'grace@example.com'
			});
			await git(['commit', '-m', 'test'], env);

			// Both halves: git records the identity as author AND committer.
			expect(await git(['log', '-1', '--format=%an <%ae>'])).toBe(
				'Grace Hopper <grace@example.com>'
			);
			expect(await git(['log', '-1', '--format=%cn <%ce>'])).toBe(
				'Grace Hopper <grace@example.com>'
			);

			// The whole point of the env route: the user's repository is untouched,
			// so their own CLI outside Clopen sees no Clopen-written identity.
			const config = await Bun.file(join(dir, '.git', 'config')).text();
			expect(config).not.toContain('grace@example.com');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
