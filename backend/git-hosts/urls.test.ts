import { describe, expect, test } from 'bun:test';
import { normaliseBaseUrl, parseRemoteUrl, withoutUserInfo } from './urls';

describe('parseRemoteUrl', () => {
	test('scp-style', () => {
		expect(parseRemoteUrl('git@github.com:acme/web.git')).toEqual({ host: 'github.com', path: 'acme/web' });
	});

	test('https with credentials and a trailing slash', () => {
		expect(parseRemoteUrl('https://user@GitLab.com/group/sub/project.git/')).toEqual({ host: 'gitlab.com', path: 'group/sub/project' });
	});

	test('ssh:// with a port keeps only the hostname', () => {
		expect(parseRemoteUrl('ssh://git@git.example.com:2222/acme/web.git')).toEqual({ host: 'git.example.com', path: 'acme/web' });
	});

	test('a local path has no host', () => {
		expect(parseRemoteUrl('/srv/repos/web.git')).toBeNull();
		expect(parseRemoteUrl('file:///srv/repos/web.git')).toBeNull();
		expect(parseRemoteUrl('')).toBeNull();
	});
});

describe('normaliseBaseUrl', () => {
	test('adds a scheme and drops trailing slashes and API suffixes', () => {
		expect(normaliseBaseUrl('git.example.com/')).toBe('https://git.example.com');
		expect(normaliseBaseUrl('https://ghe.example.com/api/v3')).toBe('https://ghe.example.com');
		expect(normaliseBaseUrl('https://gitlab.example.com/api/v4/')).toBe('https://gitlab.example.com');
		expect(normaliseBaseUrl('http://localhost:3000/gitea')).toBe('http://localhost:3000/gitea');
	});

	test('empty stays empty — it means the cloud host', () => {
		expect(normaliseBaseUrl('  ')).toBe('');
		expect(normaliseBaseUrl(undefined)).toBe('');
	});
});

describe('withoutUserInfo', () => {
	test('a clone link never carries a username into .git/config', () => {
		expect(withoutUserInfo('https://octocat@bitbucket.org/acme/web.git')).toBe('https://bitbucket.org/acme/web.git');
	});
});
