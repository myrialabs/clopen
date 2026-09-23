/**
 * The helper's input parsing, which authentication depends on.
 *
 * Git speaks a line protocol on stdin and reads the answer on stdout, so a
 * mis-parse does not fail loudly — it produces a helper that silently answers
 * nothing, and a push that asks for a password nobody typed.
 */

import { describe, expect, test } from 'bun:test';
import { identityIdFrom, parseCredentialRequest } from './cli';

describe('parseCredentialRequest', () => {
	test('reads the key=value lines git sends', () => {
		expect(
			parseCredentialRequest('protocol=https\nhost=github.com\npath=owner/repo.git\n\n')
		).toEqual({
			protocol: 'https',
			host: 'github.com',
			path: 'owner/repo.git'
		});
	});

	test('keeps a value containing "=" intact', () => {
		// Only the FIRST `=` separates; a token or query string would otherwise
		// arrive truncated at its first equals sign.
		expect(parseCredentialRequest('password=abc=def=ghi\n')).toEqual({
			password: 'abc=def=ghi'
		});
	});

	test('ignores blank lines and malformed rows rather than failing', () => {
		expect(parseCredentialRequest('\nhost=github.com\n\n=novalue\ngarbage\n')).toEqual({
			host: 'github.com'
		});
	});

	test('an empty value is a value, not a missing key', () => {
		expect(parseCredentialRequest('username=\n')).toEqual({ username: '' });
	});

	test('empty input yields no fields', () => {
		expect(parseCredentialRequest('')).toEqual({});
	});
});

describe('identityIdFrom', () => {
	test('finds the flag among git-appended arguments', () => {
		// Git appends the operation after our own arguments.
		expect(identityIdFrom(['--identity=abc-123', 'get'])).toBe('abc-123');
		expect(identityIdFrom(['get', '--identity=abc-123'])).toBe('abc-123');
	});

	test('a missing or empty flag yields null, so the helper declines', () => {
		expect(identityIdFrom(['get'])).toBeNull();
		expect(identityIdFrom(['--identity=', 'get'])).toBeNull();
		expect(identityIdFrom([])).toBeNull();
	});
});
