/**
 * Turning Vercel's vocabulary into the surface's.
 *
 * The two cases worth guarding are the ones where being wrong is silent rather
 * than loud: a state that maps to the wrong category keeps the poller running
 * forever (or stops it on a build that is still going), and `isCurrent` decides
 * whether the panel tells someone a build is serving production traffic.
 */

import { describe, it, expect } from 'bun:test';

import { isLive, toDeployment, toEnvironment, toState } from './normalise';
import type { VercelDeployment } from './types';

describe('toState', () => {
	it('maps the states that mean "not started yet" onto queued', () => {
		expect(toState('QUEUED')).toBe('queued');
		expect(toState('INITIALIZING')).toBe('queued');
		// A build held by a blocking check has not started and still may.
		expect(toState('BLOCKED')).toBe('queued');
	});

	it('maps the terminal states', () => {
		expect(toState('READY')).toBe('ready');
		expect(toState('ERROR')).toBe('error');
		expect(toState('CANCELED')).toBe('canceled');
	});

	it('treats an unknown state as an error rather than as ready', () => {
		// Guessing "ready" for something we do not recognise would show a green
		// row for a build that may have failed. Guessing "error" is the safe way
		// to be wrong, because it is visible.
		expect(toState('SOMETHING_NEW')).toBe('error');
		expect(toState(undefined)).toBe('error');
	});

	it('keeps polling only for states the provider can still change', () => {
		expect(isLive('queued')).toBe(true);
		expect(isLive('building')).toBe(true);
		expect(isLive('ready')).toBe(false);
		expect(isLive('error')).toBe(false);
		expect(isLive('canceled')).toBe(false);
	});
});

describe('toEnvironment', () => {
	it('reads production from the target', () => {
		expect(toEnvironment({ target: 'production' } as VercelDeployment)).toBe('production');
	});

	it('treats a null target as preview, because there is no preview target', () => {
		expect(toEnvironment({ target: null } as VercelDeployment)).toBe('preview');
		expect(toEnvironment({} as VercelDeployment)).toBe('preview');
	});

	it('keeps a custom environment out of preview', () => {
		const raw = { target: null, customEnvironment: { id: 'env_1', slug: 'staging' } } as VercelDeployment;
		expect(toEnvironment(raw)).toBe('custom');
	});
});

const base: VercelDeployment = {
	uid: 'dpl_1',
	name: 'web',
	url: 'web-abc.vercel.app',
	readyState: 'READY',
	target: 'production',
	createdAt: 1_700_000_000_000
};

describe('toDeployment', () => {
	it('is only "current" when the project says this is what is live', () => {
		expect(toDeployment(base, 'dpl_1').isCurrent).toBe(true);
		// Ready, production, and superseded. Without the project's answer this
		// row would claim to be serving traffic it lost.
		expect(toDeployment(base, 'dpl_2').isCurrent).toBe(false);
		expect(toDeployment(base, null).isCurrent).toBe(false);
	});

	it('finds git metadata whatever provider prefixed it', () => {
		const withGithub = toDeployment(
			{ ...base, meta: { githubCommitRef: 'main', githubCommitSha: 'abc123', githubCommitMessage: 'fix: thing' } },
			null
		);
		expect(withGithub.branch).toBe('main');
		expect(withGithub.commitSha).toBe('abc123');
		expect(withGithub.commitMessage).toBe('fix: thing');

		// Same deployment from GitLab, same fields on the surface.
		const withGitlab = toDeployment({ ...base, meta: { gitlabCommitRef: 'trunk' } }, null);
		expect(withGitlab.branch).toBe('trunk');
	});

	it('keeps the provider word alongside the normalised state', () => {
		const row = toDeployment({ ...base, readyState: 'BLOCKED' }, null);
		expect(row.state).toBe('queued');
		expect(row.stateDetail).toBe('BLOCKED');
	});

	it('reports a still-uploading deployment as having no URL', () => {
		expect(toDeployment({ ...base, url: null }, null).url).toBeNull();
		// An empty string is the same fact and must not become "https://".
		expect(toDeployment({ ...base, url: '' }, null).url).toBeNull();
	});

	it('keeps "not a candidate" and "did not say" apart', () => {
		// Three answers, not two. Collapsing the missing one into `false` hid the
		// rollback action on every listing that omitted the field — the action
		// existed and was simply unreachable.
		expect(toDeployment(base, null).isRollbackCandidate).toBeNull();
		expect(toDeployment({ ...base, isRollbackCandidate: null }, null).isRollbackCandidate).toBeNull();
		expect(toDeployment({ ...base, isRollbackCandidate: false }, null).isRollbackCandidate).toBe(false);
		expect(toDeployment({ ...base, isRollbackCandidate: true }, null).isRollbackCandidate).toBe(true);
	});
});
