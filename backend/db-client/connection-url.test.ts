/**
 * Tests for the one connection URL builder.
 *
 * These lock the strings the DRIVERS produce, not just the ones a user copies.
 * Four adapters were folded onto this function, and a regression here does not
 * fail a type check — it fails a connection, or worse, connects to the wrong
 * database. The tunnel cases matter most: the drivers rewrite host and port to
 * the local end of an SSH tunnel, and the environment variable must never.
 */

import { describe, it, expect } from 'bun:test';
import type { DbClientConnection, DbDriver } from '$shared/types/db-client';
import { buildConnectionUrl } from './connection-url';

function connection(overrides: Partial<DbClientConnection> & { driver: DbDriver }): DbClientConnection {
	return {
		id: 'c1',
		name: 'Test',
		host: 'db.example.com',
		port: null,
		username: 'app',
		password: 'pa ss/word',
		database: 'shop',
		sslMode: 'disable',
		sslCa: null,
		ssh: {
			enabled: false,
			connectionId: null,
			host: '',
			port: 22,
			username: '',
			authMethod: 'password'
		},
		options: {},
		color: null,
		createdAt: '',
		updatedAt: '',
		lastUsedAt: null,
		...overrides
	};
}

describe('buildConnectionUrl', () => {
	it('percent-encodes a password that would otherwise break the URL', () => {
		// The whole reason this is one function: a `/` in a password silently
		// becomes a path segment, and the driver then reports "database not found".
		const url = buildConnectionUrl(connection({ driver: 'postgres' }));
		expect(url).toBe('postgresql://app:pa%20ss%2Fword@db.example.com:5432/shop');
	});

	it('uses the scheme Bun.sql wants when asked, and the readable one otherwise', () => {
		const conn = connection({ driver: 'postgres' });
		expect(buildConnectionUrl(conn, { scheme: 'postgres' })).toStartWith('postgres://');
		expect(buildConnectionUrl(conn)).toStartWith('postgresql://');
	});

	it('adds sslmode only when SSL is actually on', () => {
		expect(buildConnectionUrl(connection({ driver: 'postgres', sslMode: 'require' }))).toContain(
			'?sslmode=require'
		);
		expect(buildConnectionUrl(connection({ driver: 'postgres' }))).not.toContain('sslmode');
	});

	it('substitutes the fallback database only where the caller asks for one', () => {
		const conn = connection({ driver: 'postgres', database: null });
		expect(buildConnectionUrl(conn, { fallbackDatabase: 'postgres' })).toEndWith('/postgres');
		expect(buildConnectionUrl(conn)).toEndWith(':5432');
	});

	it('rewrites host and port for a tunnel, which the env variable must not do', () => {
		const conn = connection({ driver: 'mysql', port: 3306 });
		expect(buildConnectionUrl(conn, { tunnelPort: 54321 })).toBe(
			'mysql://app:pa%20ss%2Fword@127.0.0.1:54321/shop'
		);
		expect(buildConnectionUrl(conn)).toContain('db.example.com:3306');
	});

	it('drops the password when there is no username to carry it', () => {
		// Legal in Redis and nowhere else, which is where `omitUsername` is used.
		const conn = connection({ driver: 'postgres', username: null });
		expect(buildConnectionUrl(conn)).toBe('postgresql://db.example.com:5432/shop');
	});

	it('keeps Mongo authSource, defaulting to admin only when a user is set', () => {
		expect(buildConnectionUrl(connection({ driver: 'mongodb' }))).toContain('?authSource=admin');
		expect(
			buildConnectionUrl(connection({ driver: 'mongodb', options: { authSource: 'shop' } }))
		).toContain('?authSource=shop');
		expect(
			buildConnectionUrl(connection({ driver: 'mongodb', username: null, password: null }))
		).toBe('mongodb://db.example.com:27017/shop');
	});

	it('builds Redis with the password but no username, and only a numeric index', () => {
		expect(buildConnectionUrl(connection({ driver: 'redis', database: '3' }))).toBe(
			'redis://:pa%20ss%2Fword@db.example.com:6379/3'
		);
		// A non-numeric value means the connection names no index, not a database
		// called that.
		expect(buildConnectionUrl(connection({ driver: 'redis', database: 'cache' }))).toBe(
			'redis://:pa%20ss%2Fword@db.example.com:6379'
		);
	});

	it('answers with a file: path for SQLite, which has no endpoint', () => {
		expect(buildConnectionUrl(connection({ driver: 'sqlite', database: '/data/app.db' }))).toBe(
			'file:/data/app.db'
		);
		expect(buildConnectionUrl(connection({ driver: 'sqlite', database: null }))).toBe('');
	});

	it('falls back to localhost and the driver default port', () => {
		expect(
			buildConnectionUrl(connection({ driver: 'mssql', host: null, port: null }))
		).toBe('mssql://app:pa%20ss%2Fword@127.0.0.1:1433/shop');
	});
});
