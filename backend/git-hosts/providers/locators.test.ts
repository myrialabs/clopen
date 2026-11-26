import { describe, expect, test } from 'bun:test';
import { githubHost } from './github';
import { gitlabHost } from './gitlab';
import { giteaHost } from './gitea';
import { bitbucketHost } from './bitbucket';
import { gitlabWorkAdapter } from '$backend/work/providers/gitlab/adapter';
import { rollUp } from '../ci';

describe('locatorFromRemote', () => {
	test('GitHub takes owner/repo and rejects lookalike hosts', () => {
		expect(githubHost.locatorFromRemote('git@github.com:acme/web.git', {})).toBe('acme/web');
		expect(githubHost.locatorFromRemote('https://evilgithub.com/acme/web.git', {})).toBeNull();
		expect(githubHost.locatorFromRemote('git@github.com:acme/web.git', { baseUrl: 'https://ghe.example.com' })).toBeNull();
	});

	test('GitLab keeps every group level', () => {
		expect(gitlabHost.locatorFromRemote('git@gitlab.com:group/sub/project.git', {})).toBe('group/sub/project');
		expect(gitlabHost.locatorFromRemote('https://gitlab.example.com/a/b.git', { baseUrl: 'gitlab.example.com' })).toBe('a/b');
		expect(gitlabHost.locatorFromRemote('https://gitlab.com/a/b.git', { baseUrl: 'gitlab.example.com' })).toBeNull();
	});

	test('the GitLab work adapter cuts a web page path back to the project', () => {
		expect(gitlabWorkAdapter.locatorFromRemote('https://gitlab.com/group/project/-/tree/main', {})).toBe('group/project');
	});

	test('Gitea served under a sub-path still yields owner/name', () => {
		expect(giteaHost.locatorFromRemote('https://git.example.com/gitea/acme/web.git', { baseUrl: 'https://git.example.com/gitea' })).toBe('acme/web');
	});

	test('Gitea without a server answers for nothing', () => {
		expect(giteaHost.locatorFromRemote('https://git.example.com/acme/web.git', {})).toBeNull();
	});

	test('Bitbucket', () => {
		expect(bitbucketHost.locatorFromRemote('git@bitbucket.org:team/repo.git', {})).toBe('team/repo');
		expect(bitbucketHost.locatorFromRemote('git@github.com:team/repo.git', {})).toBeNull();
	});
});

describe('links', () => {
	test('each service uses its own URL shapes', () => {
		expect(githubHost.links({}, 'acme/web').commit).toBe('https://github.com/acme/web/commit/{sha}');
		expect(gitlabHost.links({}, 'g/p').branch).toBe('https://gitlab.com/g/p/-/tree/{branch}');
		expect(giteaHost.links({ baseUrl: 'https://git.example.com' }, 'a/b').file).toBe('https://git.example.com/a/b/src/branch/{ref}/{path}');
		expect(bitbucketHost.links({}, 'a/b').fileLine).toBe('#lines-{line}');
	});
});

describe('git usernames', () => {
	test('match what each service expects alongside a token', () => {
		expect(githubHost.gitUsername({})).toBe('x-access-token');
		expect(gitlabHost.gitUsername({})).toBe('oauth2');
		expect(giteaHost.gitUsername({ login: 'octocat' })).toBe('octocat');
		expect(bitbucketHost.gitUsername({})).toBe('x-bitbucket-api-token-auth');
	});
});

describe('rollUp', () => {
	test('any failure fails, then any pending is pending', () => {
		expect(rollUp('a', ['success', 'failure', 'pending'], null).state).toBe('failure');
		expect(rollUp('a', ['success', 'pending'], null).state).toBe('pending');
		expect(rollUp('a', ['success', 'success'], null)).toMatchObject({ state: 'success', summary: '2 of 2 checks passed' });
	});

	test('no signals is "none", not a pass', () => {
		expect(rollUp('a', [], 'https://x').state).toBe('none');
	});
});
