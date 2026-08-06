import { describe, it, expect } from 'bun:test';
import { applyAutoLimitMssql } from './query-executor';

describe('applyAutoLimitMssql', () => {
	it('injects TOP into a plain SELECT', () => {
		expect(applyAutoLimitMssql('SELECT * FROM users', 500)).toBe('SELECT TOP (500) * FROM users');
	});

	it('injects TOP after DISTINCT', () => {
		expect(applyAutoLimitMssql('SELECT DISTINCT name FROM users', 500)).toBe(
			'SELECT DISTINCT TOP (500) name FROM users'
		);
	});

	it('strips a trailing semicolon before injecting', () => {
		expect(applyAutoLimitMssql('SELECT id FROM t;', 100)).toBe('SELECT TOP (100) id FROM t');
	});

	it('leaves a query that already has TOP untouched', () => {
		expect(applyAutoLimitMssql('SELECT TOP 10 * FROM users', 500)).toBe('SELECT TOP 10 * FROM users');
	});

	it('leaves an OFFSET/FETCH paged query untouched', () => {
		const q = 'SELECT * FROM users ORDER BY id OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY';
		expect(applyAutoLimitMssql(q, 500)).toBe(q);
	});

	it('does not touch WITH / CTE queries', () => {
		const q = 'WITH cte AS (SELECT 1 AS n) SELECT * FROM cte';
		expect(applyAutoLimitMssql(q, 500)).toBe(q);
	});

	it('does not touch non-SELECT statements', () => {
		expect(applyAutoLimitMssql('UPDATE users SET name = 1', 500)).toBe('UPDATE users SET name = 1');
	});

	it('injects TOP even when the SELECT is preceded by a comment', () => {
		expect(applyAutoLimitMssql('-- fetch users\nSELECT * FROM users', 500)).toBe(
			'-- fetch users\nSELECT TOP (500) * FROM users'
		);
	});
});
