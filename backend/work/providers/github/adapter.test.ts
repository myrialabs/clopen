/**
 * Turning a git remote into a repository locator.
 *
 * This is what makes the binding automatic, and it is the one place where being
 * wrong is silently destructive rather than loudly broken: bind to the wrong
 * repository and "start work" opens someone else's issue, while a pull request
 * targets a repository nobody meant.
 *
 * The Enterprise Server cases matter as much as the github.com ones, because a
 * host check that ignores the account's base URL would claim every remote on
 * earth.
 */

import { describe, it, expect } from 'bun:test';

import { githubWorkAdapter } from './adapter';

const dotCom: Record<string, string> = {};
const enterprise: Record<string, string> = { baseUrl: 'https://ghe.example.com' };

const parse = (url: string, credentials = dotCom) =>
	githubWorkAdapter.locatorFromRemote(url, credentials);

describe('locatorFromRemote — github.com', () => {
	it('reads an scp-style remote', () => {
		expect(parse('git@github.com:acme/web.git')).toBe('acme/web');
	});

	it('reads an https remote, with or without .git', () => {
		expect(parse('https://github.com/acme/web.git')).toBe('acme/web');
		expect(parse('https://github.com/acme/web')).toBe('acme/web');
	});

	it('reads an ssh:// remote', () => {
		expect(parse('ssh://git@github.com/acme/web.git')).toBe('acme/web');
	});

	it('tolerates a trailing slash', () => {
		expect(parse('https://github.com/acme/web/')).toBe('acme/web');
	});

	it('keeps only owner/repo from a deeper URL', () => {
		expect(parse('https://github.com/acme/web/tree/main/src')).toBe('acme/web');
	});

	it('rejects a URL that names no repository', () => {
		expect(parse('https://github.com/acme')).toBeNull();
	});

	it('rejects another vendor', () => {
		expect(parse('git@gitlab.com:acme/web.git')).toBeNull();
		expect(parse('https://bitbucket.org/acme/web.git')).toBeNull();
	});

	it('rejects a host that merely ends with the right name', () => {
		// `evilgithub.com` must not match `github.com` — a suffix check here would
		// bind a project to an attacker-controlled remote.
		expect(parse('https://evilgithub.com/acme/web.git')).toBeNull();
	});

	it('rejects rubbish rather than throwing', () => {
		expect(parse('')).toBeNull();
		expect(parse('not a url')).toBeNull();
	});
});

describe('locatorFromRemote — Enterprise Server', () => {
	it('reads a remote on the configured instance', () => {
		expect(parse('git@ghe.example.com:acme/web.git', enterprise)).toBe('acme/web');
		expect(parse('https://ghe.example.com/acme/web.git', enterprise)).toBe('acme/web');
	});

	it('does not claim github.com remotes', () => {
		// An enterprise account has no business answering for a public repo: its
		// token cannot read it, and binding would produce 404s that read as
		// permission problems.
		expect(parse('git@github.com:acme/web.git', enterprise)).toBeNull();
	});

	it('accepts a base URL that already points at the API root', () => {
		expect(parse('git@ghe.example.com:acme/web.git', { baseUrl: 'https://ghe.example.com/api/v3' }))
			.toBe('acme/web');
	});

	it('is case-insensitive about the host', () => {
		expect(parse('git@GitHub.com:acme/web.git')).toBe('acme/web');
	});
});
