/**
 * Which kind of token is in play.
 *
 * This drives the only useful part of a "Not Found" — GitHub reports a missing
 * repository and an unpermitted one identically, and the prefix is the only
 * signal available for telling the user WHY. Getting it wrong means handing
 * someone the wrong instruction, which is worse than the generic message.
 */

import { describe, it, expect } from 'bun:test';

import { tokenKindOf } from './client';

describe('tokenKindOf', () => {
	it('recognises a fine-grained token', () => {
		expect(tokenKindOf('github_pat_11ABCDEFG0abcdefghij')).toBe('fine-grained');
	});

	it('recognises a classic token', () => {
		expect(tokenKindOf('ghp_abcdefghijklmnopqrstuvwxyz')).toBe('classic');
	});

	it('treats OAuth and app tokens as classic', () => {
		// They carry scopes rather than a resource owner, so the same advice
		// applies to all of them.
		expect(tokenKindOf('gho_abcdefghij')).toBe('classic');
		expect(tokenKindOf('ghs_abcdefghij')).toBe('classic');
		expect(tokenKindOf('ghu_abcdefghij')).toBe('classic');
	});

	it('does not mistake a fine-grained token for a classic one', () => {
		// `github_pat_` also begins with `gh`, so a loose prefix test would
		// classify every fine-grained token as classic and give exactly the wrong
		// advice to the people who need it most.
		expect(tokenKindOf('github_pat_x')).not.toBe('classic');
	});

	it('says unknown rather than guessing', () => {
		expect(tokenKindOf('')).toBe('unknown');
		expect(tokenKindOf('40charhexlegacytoken')).toBe('unknown');
	});
});
