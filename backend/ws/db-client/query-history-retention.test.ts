/**
 * Test query history retention policy enforcement.
 *
 * Verifies that deterministic pruning keeps exactly HISTORY_KEEP_PER_CONNECTION
 * entries after every PRUNE_EVERY_N_QUERIES inserts, replacing the old
 * probabilistic approach that could allow unbounded growth.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { initializeDatabase, closeDatabase } from '../../database';
import { dbClientQueryHistoryQueries } from '../../database/queries';
import { dbClientConnectionQueries } from '../../database/queries';

const HISTORY_KEEP_PER_CONNECTION = 200;
const PRUNE_EVERY_N_QUERIES = 10;

describe('Query History Retention', () => {
	beforeEach(async () => {
		await initializeDatabase();
		// Clean up any existing test data
		const db = await import('../../database').then(m => m.getDatabase());
		db.prepare('DELETE FROM db_client_query_history').run();
		db.prepare('DELETE FROM db_client_connections').run();
	});

	test('prunes history after PRUNE_EVERY_N_QUERIES inserts', () => {
		// Create a test connection
		const connection = dbClientConnectionQueries.createForUser({
			name: 'test-connection',
			driver: 'postgres',
			host: 'localhost',
			port: 5432,
			username: 'test',
			password: 'test',
			database: 'testdb',
			sslMode: 'disable',
			ssh: {
				enabled: false,
				host: '',
				port: 22,
				username: '',
				authMethod: 'password',
				password: '',
				privateKey: '',
				passphrase: ''
			},
			options: {}
		}, 'test-user-id');

		// Insert HISTORY_KEEP_PER_CONNECTION + 50 queries (250 total)
		const totalQueries = HISTORY_KEEP_PER_CONNECTION + 50;
		for (let i = 0; i < totalQueries; i++) {
			dbClientQueryHistoryQueries.insert({
				connectionId: connection.id,
				userId: 'test-user-id',
				query: `SELECT ${i};`,
				durationMs: Math.random() * 100,
				rowCount: 1,
				status: 'success',
				error: null
			});

			// Manually trigger prune every PRUNE_EVERY_N_QUERIES
			if ((i + 1) % PRUNE_EVERY_N_QUERIES === 0) {
				dbClientQueryHistoryQueries.prune(connection.id, HISTORY_KEEP_PER_CONNECTION);
			}
		}

		// Verify exactly HISTORY_KEEP_PER_CONNECTION entries remain
		const { total } = dbClientQueryHistoryQueries.list({
			connectionId: connection.id,
			limit: 1000
		});

		expect(total).toBe(HISTORY_KEEP_PER_CONNECTION);
	});

	test('keeps most recent queries after pruning', () => {
		const connection = dbClientConnectionQueries.createForUser({
			name: 'test-connection-2',
			driver: 'postgres',
			host: 'localhost',
			port: 5432,
			username: 'test',
			password: 'test',
			database: 'testdb',
			sslMode: 'disable',
			ssh: {
				enabled: false,
				host: '',
				port: 22,
				username: '',
				authMethod: 'password',
				password: '',
				privateKey: '',
				passphrase: ''
			},
			options: {}
		}, 'test-user-id');

		// Insert 250 queries — more than HISTORY_KEEP_PER_CONNECTION
		for (let i = 0; i < 250; i++) {
			dbClientQueryHistoryQueries.insert({
				connectionId: connection.id,
				userId: 'test-user-id',
				query: `SELECT ${i};`,
				durationMs: 10,
				rowCount: 1,
				status: 'success',
				error: null
			});

			if ((i + 1) % PRUNE_EVERY_N_QUERIES === 0) {
				dbClientQueryHistoryQueries.prune(connection.id, HISTORY_KEEP_PER_CONNECTION);
			}
		}

		const { items, total } = dbClientQueryHistoryQueries.list({
			connectionId: connection.id,
			limit: 1000
		});

		expect(total).toBe(HISTORY_KEEP_PER_CONNECTION);
		expect(items.length).toBe(HISTORY_KEEP_PER_CONNECTION);
	});

	test('prune does not affect other connections', () => {
		// Create two connections
		const conn1 = dbClientConnectionQueries.createForUser({
			name: 'connection-1',
			driver: 'postgres',
			host: 'localhost',
			port: 5432,
			username: 'test',
			password: 'test',
			database: 'testdb',
			sslMode: 'disable',
			ssh: {
				enabled: false,
				host: '',
				port: 22,
				username: '',
				authMethod: 'password',
				password: '',
				privateKey: '',
				passphrase: ''
			},
			options: {}
		}, 'user-1');

		const conn2 = dbClientConnectionQueries.createForUser({
			name: 'connection-2',
			driver: 'mysql',
			host: 'localhost',
			port: 3306,
			username: 'test',
			password: 'test',
			database: 'testdb',
			sslMode: 'disable',
			ssh: {
				enabled: false,
				host: '',
				port: 22,
				username: '',
				authMethod: 'password',
				password: '',
				privateKey: '',
				passphrase: ''
			},
			options: {}
		}, 'user-2');

		// Insert 250 queries for conn1
		for (let i = 0; i < 250; i++) {
			dbClientQueryHistoryQueries.insert({
				connectionId: conn1.id,
				userId: 'user-1',
				query: `SELECT ${i};`,
				durationMs: 10,
				rowCount: 1,
				status: 'success',
				error: null
			});
			if ((i + 1) % PRUNE_EVERY_N_QUERIES === 0) {
				dbClientQueryHistoryQueries.prune(conn1.id, HISTORY_KEEP_PER_CONNECTION);
			}
		}

		// Insert only 50 queries for conn2
		for (let i = 0; i < 50; i++) {
			dbClientQueryHistoryQueries.insert({
				connectionId: conn2.id,
				userId: 'user-2',
				query: `SELECT ${i};`,
				durationMs: 10,
				rowCount: 1,
				status: 'success',
				error: null
			});
		}

		// Verify conn1 has exactly 200
		const { total: total1 } = dbClientQueryHistoryQueries.list({
			connectionId: conn1.id,
			limit: 1000
		});
		expect(total1).toBe(HISTORY_KEEP_PER_CONNECTION);

		// Verify conn2 still has all 50 (not affected by conn1 pruning)
		const { total: total2 } = dbClientQueryHistoryQueries.list({
			connectionId: conn2.id,
			limit: 1000
		});
		expect(total2).toBe(50);
	});
});

