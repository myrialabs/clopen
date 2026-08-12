import { beforeEach, describe, expect, mock, test } from 'bun:test';

type AuditRow = {
	id: string;
	user_id: string;
	actor_user_id: string | null;
	event_type: string;
	event_details: string | null;
	ip_address: string | null;
	user_agent: string | null;
	created_at: string;
};

let rows: AuditRow[] = [];
let failNextInsert = false;
let nextId = 1;
const mockDebugError = mock(() => {});

const mockDb = {
	prepare(sql: string) {
		const normalized = sql.replace(/\s+/g, ' ').trim();

		if (normalized.includes('INSERT INTO auth_audit_log')) {
			return {
				run: (
					userId: string,
					actorUserId: string | null,
					eventType: string,
					eventDetails: string | null,
					ipAddress: string | null,
					userAgent: string | null
				) => {
					if (failNextInsert) {
						failNextInsert = false;
						throw new Error('disk full');
					}

					rows.push({
						id: `audit-${nextId}`,
						user_id: userId,
						actor_user_id: actorUserId,
						event_type: eventType,
						event_details: eventDetails,
						ip_address: ipAddress,
						user_agent: userAgent,
						created_at: new Date(Date.UTC(2026, 4, 19, 12, 0, nextId++)).toISOString()
					});
				}
			};
		}

		if (normalized.includes('WHERE user_id = ?')) {
			return {
				all: (userId: string, limit: number) =>
					[...rows]
						.filter(row => row.user_id === userId)
						.sort((a, b) => b.created_at.localeCompare(a.created_at))
						.slice(0, limit)
			};
		}

		if (normalized.includes('WHERE event_type = ?')) {
			return {
				all: (eventType: string, limit: number) =>
					[...rows]
						.filter(row => row.event_type === eventType)
						.sort((a, b) => b.created_at.localeCompare(a.created_at))
						.slice(0, limit)
			};
		}

		if (normalized.includes('ORDER BY created_at DESC LIMIT ?')) {
			return {
				all: (limit: number) =>
					[...rows]
						.sort((a, b) => b.created_at.localeCompare(a.created_at))
						.slice(0, limit)
			};
		}

		throw new Error(`Unexpected SQL in test: ${normalized}`);
	}
};

mock.module('../index', () => ({
	getDatabase: () => mockDb
}));

// Every method, not just the one this file asserts on. `mock.module` replaces the
// module for the WHOLE test process, so a partial stub here leaves any file that
// runs afterwards with a `debug` missing `log`/`warn`/etc — which fails as
// "debug.log is not a function" inside unrelated code, a long way from this line.
mock.module('$shared/utils/logger', () => ({
	debug: {
		log: () => {},
		info: () => {},
		warn: () => {},
		error: mockDebugError,
		debug: () => {},
		trace: () => {}
	}
}));

const { auditLogQueries } = await import('./audit-log-queries');

describe('auditLogQueries', () => {
	beforeEach(() => {
		rows = [];
		failNextInsert = false;
		nextId = 1;
		mockDebugError.mockClear();
	});

	test('logEvent inserts rows with actor identity and getUserLogs returns them', () => {
		const inserted = auditLogQueries.logEvent({
			userId: 'member-1',
			actorUserId: 'admin-1',
			eventType: 'project:assigned',
			eventDetails: 'Project proj-1 assigned to user member-1',
			ipAddress: '127.0.0.1'
		});

		expect(inserted).toBe(true);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			user_id: 'member-1',
			actor_user_id: 'admin-1',
			event_type: 'project:assigned',
			ip_address: '127.0.0.1'
		});

		const logs = auditLogQueries.getUserLogs('member-1', 10);
		expect(logs).toHaveLength(1);
		expect(logs[0].actor_user_id).toBe('admin-1');
	});

	test('getEventsByType filters and orders matching events', () => {
		auditLogQueries.logEvent({
			userId: 'user-1',
			actorUserId: 'user-1',
			eventType: 'auth:login'
		});
		auditLogQueries.logEvent({
			userId: 'user-2',
			actorUserId: 'admin-1',
			eventType: 'project:assigned'
		});
		auditLogQueries.logEvent({
			userId: 'user-3',
			actorUserId: 'user-3',
			eventType: 'auth:login'
		});

		const logs = auditLogQueries.getEventsByType('auth:login', 10);
		expect(logs).toHaveLength(2);
		expect(logs.map(log => log.user_id)).toEqual(['user-3', 'user-1']);
	});

	test('logEvent is best-effort when the insert fails', () => {
		failNextInsert = true;

		const inserted = auditLogQueries.logEvent({
			userId: 'user-4',
			eventType: 'auth:logout'
		});

		expect(inserted).toBe(false);
		expect(rows).toHaveLength(0);
		expect(mockDebugError).toHaveBeenCalled();
	});
});
