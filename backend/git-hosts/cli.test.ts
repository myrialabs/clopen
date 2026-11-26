import { describe, expect, test } from 'bun:test';
import { parseGhHosts, parseGlabHosts, parseTeaLogins } from './cli';

describe('parseGhHosts', () => {
	test('reads each host and the user signed in to it', () => {
		const text = [
			'github.com:',
			'    users:',
			'        octocat:',
			'    git_protocol: https',
			'    user: octocat',
			'ghe.example.com:',
			'    user: "mona"',
			''
		].join('\n');
		expect(parseGhHosts(text)).toEqual([
			{ host: 'github.com', login: 'octocat' },
			{ host: 'ghe.example.com', login: 'mona' }
		]);
	});

	test('a host with no user line is still listed', () => {
		expect(parseGhHosts('github.com:\n    git_protocol: ssh\n')).toEqual([{ host: 'github.com', login: null }]);
	});

	test('ignores comments and blank lines', () => {
		expect(parseGhHosts('# managed by gh\n\n')).toEqual([]);
	});
});

describe('parseGlabHosts', () => {
	test('reads hosts nested under hosts:, with their user and whether a token is set', () => {
		const text = [
			'git_protocol: ssh',
			'hosts:',
			'    gitlab.com:',
			'        token: glpat-xxxxxxxx',
			'        api_host: gitlab.com',
			'        user: octocat',
			'    gitlab.example.com:',
			'        api_protocol: https',
			'        user: mona',
			'editor: vim',
			''
		].join('\n');
		expect(parseGlabHosts(text)).toEqual([
			{ host: 'gitlab.com', login: 'octocat', hasToken: true },
			{ host: 'gitlab.example.com', login: 'mona', hasToken: false }
		]);
	});

	test('keys outside hosts: are not hosts', () => {
		expect(parseGlabHosts('aliases:\n    co: mr checkout\n')).toEqual([]);
	});
});

describe('parseTeaLogins', () => {
	test('reads every login in the list, with its url, user and token', () => {
		const text = [
			'logins:',
			'- name: work',
			'  url: https://git.example.com/',
			'  token: abc123',
			'  default: true',
			'  user: octocat',
			'- name: codeberg',
			'  url: https://codeberg.org',
			'  user: mona',
			'preferences:',
			'  editor: false',
			''
		].join('\n');
		expect(parseTeaLogins(text)).toEqual([
			{ url: 'https://git.example.com', host: 'git.example.com', login: 'octocat', token: 'abc123' },
			{ url: 'https://codeberg.org', host: 'codeberg.org', login: 'mona', token: null }
		]);
	});

	test('a login with an unparseable url is skipped, not thrown', () => {
		expect(parseTeaLogins('logins:\n- name: x\n  url: not a url\n')).toEqual([]);
	});
});
