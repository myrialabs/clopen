/**
 * Reading `owner/repo` off a git remote.
 *
 * This is half of how a deployment binding is detected, and it is the half that
 * can be wrong silently: match the wrong remote and a project is bound to
 * someone else's deploy target, where "redeploy" and "roll back" both mean
 * something nobody asked for.
 *
 * Host-agnostic on purpose — a deploy target reports `acme/web` without saying
 * which host it is on, and the account that reaches it already decided the host.
 */

import { describe, it, expect } from 'bun:test';

import { repoPathOf } from './bindings';

describe('repoPathOf', () => {
	it('reads an scp-style remote', () => {
		expect(repoPathOf('git@github.com:acme/web.git')).toBe('acme/web');
	});

	it('reads an https remote, with or without .git', () => {
		expect(repoPathOf('https://github.com/acme/web.git')).toBe('acme/web');
		expect(repoPathOf('https://github.com/acme/web')).toBe('acme/web');
	});

	it('reads an ssh:// remote', () => {
		expect(repoPathOf('ssh://git@github.com/acme/web.git')).toBe('acme/web');
	});

	it('keeps a nested group path, which GitLab has and GitHub does not', () => {
		expect(repoPathOf('git@gitlab.com:acme/team/web.git')).toBe('acme/team/web');
	});

	it('lowercases, so a case difference is not a failed match', () => {
		expect(repoPathOf('https://github.com/Acme/Web.git')).toBe('acme/web');
	});

	it('answers null for something that is not a remote', () => {
		expect(repoPathOf('')).toBeNull();
		expect(repoPathOf('not a url')).toBeNull();
	});
});
