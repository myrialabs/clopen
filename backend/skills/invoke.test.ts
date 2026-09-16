/**
 * Slash invocation is the seam where a user's `/review-pr 123` becomes the
 * prompt an engine actually runs. Two properties have to hold without a database
 * or an engine in the loop, and both are easy to break silently:
 *
 *   1. RECOGNITION — a message is only an invocation when it really is one. The
 *      pattern has to reject `/usr/bin/env`, a bare `/`, and a URL path, or an
 *      ordinary message gets swallowed and replaced by a skill body.
 *   2. SUBSTITUTION — the `$ARGUMENTS` / `$1`…`$9` contract users know from
 *      `.claude/commands/*.md`. Getting `consumed` wrong is what decides whether
 *      typed arguments reach the model at all.
 */

import { describe, expect, test } from 'bun:test';
import { parseSlashInvocation, substituteArgs } from './invoke';
import { parseTriggers, stringifyTriggers, parseUses } from '$backend/database/queries';

describe('parseSlashInvocation', () => {
	test('recognises a bare command', () => {
		expect(parseSlashInvocation('/review-pr')).toEqual({ slug: 'review-pr', args: '' });
	});

	test('recognises a command with arguments', () => {
		expect(parseSlashInvocation('/review-pr 123 --deep')).toEqual({ slug: 'review-pr', args: '123 --deep' });
	});

	test('tolerates leading whitespace and a trailing newline', () => {
		expect(parseSlashInvocation('  /deploy staging\n')).toEqual({ slug: 'deploy', args: 'staging' });
	});

	test('keeps multi-line arguments intact', () => {
		const parsed = parseSlashInvocation('/summarise first line\nsecond line');
		expect(parsed?.slug).toBe('summarise');
		expect(parsed?.args).toBe('first line\nsecond line');
	});

	test('is not fooled by a path', () => {
		expect(parseSlashInvocation('/usr/bin/env python')).toBeNull();
		expect(parseSlashInvocation('/')).toBeNull();
		expect(parseSlashInvocation('/Users/me/notes.md')).toBeNull();
	});

	test('ignores a slash that is not at the start of the message', () => {
		expect(parseSlashInvocation('run /review-pr for me')).toBeNull();
	});

	test('rejects slugs outside the skill slug grammar', () => {
		expect(parseSlashInvocation('/Review-PR')).toBeNull();
		expect(parseSlashInvocation('/review_pr')).toBeNull();
		expect(parseSlashInvocation('/-leading')).toBeNull();
	});
});

describe('substituteArgs', () => {
	test('replaces $ARGUMENTS with the whole argument string', () => {
		const result = substituteArgs('Review PR $ARGUMENTS now.', '123 --deep');
		expect(result.text).toBe('Review PR 123 --deep now.');
		expect(result.consumed).toBe(true);
	});

	test('replaces positional arguments', () => {
		const result = substituteArgs('Compare $1 against $2.', 'main feature-x');
		expect(result.text).toBe('Compare main against feature-x.');
		expect(result.consumed).toBe(true);
	});

	test('renders a missing positional as empty rather than leaving the placeholder', () => {
		const result = substituteArgs('Deploy $1 to $2.', 'app');
		expect(result.text).toBe('Deploy app to .');
		expect(result.consumed).toBe(true);
	});

	test('reports nothing consumed when the body has no placeholder', () => {
		// The caller relies on this to append the arguments explicitly — otherwise
		// what the user typed after the command would vanish.
		const result = substituteArgs('Run the standard review.', '123');
		expect(result.text).toBe('Run the standard review.');
		expect(result.consumed).toBe(false);
	});

	test('leaves a bare dollar amount alone', () => {
		const result = substituteArgs('It costs $10 and $ARGUMENTSX stays.', 'x');
		expect(result.text).toBe('It costs $10 and $ARGUMENTSX stays.');
		expect(result.consumed).toBe(false);
	});
});

describe('trigger and uses parsing', () => {
	test('an unset or unrecognised trigger list falls back to auto', () => {
		// A skill with no invocable trigger would be dead weight nobody can reach,
		// so the parser refuses to produce that state.
		expect(parseTriggers(null)).toEqual(['auto']);
		expect(parseTriggers('')).toEqual(['auto']);
		expect(parseTriggers('nonsense')).toEqual(['auto']);
	});

	test('parses and de-duplicates a trigger list', () => {
		expect(parseTriggers('slash')).toEqual(['slash']);
		expect(parseTriggers(' auto , slash , auto ')).toEqual(['auto', 'slash']);
	});

	test('serializes triggers in canonical order', () => {
		expect(stringifyTriggers(['slash', 'auto'])).toBe('auto,slash');
		expect(stringifyTriggers([])).toBe('auto');
		expect(stringifyTriggers(undefined)).toBe('auto');
	});

	test('tolerates a corrupt uses column', () => {
		expect(parseUses('["a","b","a"]')).toEqual(['a', 'b']);
		expect(parseUses('not json')).toEqual([]);
		expect(parseUses(null)).toEqual([]);
		expect(parseUses('{"a":1}')).toEqual([]);
	});
});
