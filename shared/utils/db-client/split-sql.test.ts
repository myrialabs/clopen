import { describe, expect, test } from 'bun:test';
import { splitSqlStatements } from './split-sql';

describe('splitSqlStatements', () => {
	test('returns a single statement unchanged (no trailing semicolon)', () => {
		expect(splitSqlStatements('SELECT 1')).toEqual(['SELECT 1']);
	});

	test('trims and drops empty statements', () => {
		expect(splitSqlStatements('  SELECT 1 ;  ; SELECT 2 ;')).toEqual(['SELECT 1', 'SELECT 2']);
	});

	test('splits multiple statements', () => {
		expect(splitSqlStatements('SELECT 1; DELETE FROM users')).toEqual([
			'SELECT 1',
			'DELETE FROM users'
		]);
	});

	test('ignores semicolons inside single-quoted strings', () => {
		expect(splitSqlStatements("SELECT ';'; SELECT 'a;b'")).toEqual([
			"SELECT ';'",
			"SELECT 'a;b'"
		]);
	});

	test('handles doubled single-quote escapes', () => {
		expect(splitSqlStatements("SELECT 'O''Brien; Jr'; SELECT 2")).toEqual([
			"SELECT 'O''Brien; Jr'",
			'SELECT 2'
		]);
	});

	test('handles MySQL backslash escapes inside strings', () => {
		expect(splitSqlStatements("SELECT 'a\\';b'; SELECT 2")).toEqual([
			"SELECT 'a\\';b'",
			'SELECT 2'
		]);
	});

	test('ignores semicolons inside double-quoted identifiers', () => {
		expect(splitSqlStatements('SELECT "a;b" FROM t; SELECT 2')).toEqual([
			'SELECT "a;b" FROM t',
			'SELECT 2'
		]);
	});

	test('ignores semicolons inside backtick identifiers', () => {
		expect(splitSqlStatements('SELECT `a;b` FROM t; SELECT 2')).toEqual([
			'SELECT `a;b` FROM t',
			'SELECT 2'
		]);
	});

	test('ignores semicolons inside line comments', () => {
		expect(splitSqlStatements('SELECT 1 -- a; b\n; SELECT 2')).toEqual([
			'SELECT 1 -- a; b',
			'SELECT 2'
		]);
	});

	test('ignores semicolons inside block comments', () => {
		expect(splitSqlStatements('SELECT 1 /* a; b */; SELECT 2')).toEqual([
			'SELECT 1 /* a; b */',
			'SELECT 2'
		]);
	});

	test('ignores semicolons inside Postgres dollar-quoted bodies', () => {
		const sql = `CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; PERFORM 2; END; $$ LANGUAGE plpgsql; SELECT 1`;
		expect(splitSqlStatements(sql)).toEqual([
			'CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; PERFORM 2; END; $$ LANGUAGE plpgsql',
			'SELECT 1'
		]);
	});

	test('handles tagged dollar quotes', () => {
		const sql = `DO $body$ BEGIN RAISE NOTICE 'x;y'; END $body$; SELECT 1`;
		expect(splitSqlStatements(sql)).toEqual([
			"DO $body$ BEGIN RAISE NOTICE 'x;y'; END $body$",
			'SELECT 1'
		]);
	});

	test('splits on blank lines only when splitOnBlankLine is enabled', () => {
		expect(splitSqlStatements('SELECT 1\n\nSELECT 2', { splitOnBlankLine: true })).toEqual([
			'SELECT 1',
			'SELECT 2'
		]);
	});

	test('keeps a blank line inside a single statement intact by default', () => {
		expect(splitSqlStatements('SELECT id, name\nFROM users\n\nWHERE active = 1')).toEqual([
			'SELECT id, name\nFROM users\n\nWHERE active = 1'
		]);
	});

	test('returns empty array for whitespace / comment only input', () => {
		expect(splitSqlStatements('   ;  ')).toEqual([]);
	});
});
