/**
 * Branch naming for "start work".
 *
 * This is the piece of the flow with no network and no database, and it is also
 * the piece that produces a value git either accepts or refuses. A template that
 * renders to something git rejects turns the whole action into a worktree on a
 * detached HEAD, so the cases below are the ones that would produce a bad ref.
 */

import { describe, it, expect } from 'bun:test';

import { renderBranchName } from './start-work';
import { DEFAULT_BRANCH_TEMPLATE } from '$shared/types/work';

const issue = (title: string, identifier = '123') => ({
	kind: 'issue' as const,
	identifier,
	title
});

describe('renderBranchName', () => {
	it('fills the default template', () => {
		expect(renderBranchName(DEFAULT_BRANCH_TEMPLATE, issue('Sessions drop on reconnect')))
			.toBe('issue/123-sessions-drop-on-reconnect');
	});

	it('calls a pull request pr, not pull-request', () => {
		expect(
			renderBranchName(DEFAULT_BRANCH_TEMPLATE, {
				kind: 'pull-request',
				identifier: '9',
				title: 'Retry the handshake'
			})
		).toBe('pr/9-retry-the-handshake');
	});

	it('strips characters git refuses in a ref name', () => {
		// Spaces, `~`, `^`, `:` and `..` are all rejected by git; the slug reduces
		// to [a-z0-9-], which is a strict subset of what it accepts.
		const branch = renderBranchName(DEFAULT_BRANCH_TEMPLATE, issue('Fix: crash on ~/.. paths ^HEAD'));
		expect(branch).toMatch(/^issue\/123-[a-z0-9-]+$/);
		expect(branch).not.toContain('..');
	});

	it('keeps a non-numeric identifier like a tracker key', () => {
		expect(renderBranchName(DEFAULT_BRANCH_TEMPLATE, issue('Add audit log', 'ENG-45')))
			.toBe('issue/eng-45-add-audit-log');
	});

	it('never emits a trailing separator when the title slugifies to nothing', () => {
		const branch = renderBranchName(DEFAULT_BRANCH_TEMPLATE, issue('!!! ???'));
		expect(branch).toBe('issue/123');
		expect(branch.endsWith('-')).toBe(false);
		expect(branch.endsWith('/')).toBe(false);
	});

	it('falls back rather than returning an empty ref', () => {
		// `git checkout -b ""` is the failure this guards: a template of only
		// `{slug}` against an unslugifiable title renders to nothing.
		expect(renderBranchName('{slug}', issue('———'))).toBe('work/123');
	});

	it('honours a custom template', () => {
		expect(renderBranchName('feat/{identifier}', issue('Anything'))).toBe('feat/123');
	});

	it('collapses repeated separators left by an empty placeholder', () => {
		expect(renderBranchName('{kind}/{slug}--{identifier}', issue('Cache miss')))
			.toBe('issue/cache-miss-123');
	});
});
