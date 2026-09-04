import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { WSConnection } from '$shared/utils/ws-server';
import { MessageRateLimiter } from './message-rate-limiter';

type CloseCall = { code?: number; reason?: string };

function createMockConnection(): { conn: WSConnection; closeCalls: CloseCall[] } {
	const closeCalls: CloseCall[] = [];
	const conn: WSConnection = {
		readyState: 1,
		send: () => {},
		close: (code?: number, reason?: string) => {
			closeCalls.push({ code, reason });
		}
	};
	return { conn, closeCalls };
}

const originalDateNow = Date.now;

describe('MessageRateLimiter', () => {
	beforeEach(() => {
		const fixedNow = 1_700_000_000_000;
		Date.now = () => fixedNow;
	});

	afterEach(() => {
		Date.now = originalDateNow;
	});

	test('allows traffic under the warning threshold', () => {
		const limiter = new MessageRateLimiter();
		const { conn, closeCalls } = createMockConnection();

		for (let i = 0; i < 49; i++) {
			expect(limiter.checkRateLimit(conn, 'chat:send')).toBe(true);
		}

		const stats = limiter.getConnectionStats(conn);
		expect(stats?.messagesDropped).toBe(0);
		expect(closeCalls.length).toBe(0);
	});

	test('drops messages once throttle threshold is reached', () => {
		const limiter = new MessageRateLimiter();
		const { conn, closeCalls } = createMockConnection();

		for (let i = 0; i < 99; i++) {
			expect(limiter.checkRateLimit(conn, 'chat:send')).toBe(true);
		}

		expect(limiter.checkRateLimit(conn, 'chat:send')).toBe(false);
		const stats = limiter.getConnectionStats(conn);
		expect(stats?.isThrottled).toBe(true);
		expect(stats?.messagesDropped).toBe(1);
		expect(closeCalls.length).toBe(0);
	});

	test('throttling never drops a request somebody is waiting on', () => {
		const limiter = new MessageRateLimiter();
		const { conn, closeCalls } = createMockConnection();

		// Push the connection into the throttled state with event traffic — the
		// shape of a preview stream or a terminal, which is what actually fills
		// this window on a busy instance.
		for (let i = 0; i < 99; i++) {
			expect(limiter.checkRateLimit(conn, 'preview:browser-interaction')).toBe(true);
		}
		expect(limiter.checkRateLimit(conn, 'preview:browser-interaction')).toBe(false);
		expect(limiter.getConnectionStats(conn)?.isThrottled).toBe(true);

		// A request-response call arriving in the same window still gets through.
		// Shedding it used to hang its caller for a full timeout, which the client
		// then "healed" by tearing down the socket — a far bigger burst than the
		// one being throttled, and the reason the overload sustained itself.
		expect(limiter.checkRateLimit(conn, 'files:list-tree', true)).toBe(true);
		expect(limiter.checkRateLimit(conn, 'git:status', true)).toBe(true);

		// Only the events were counted as dropped.
		expect(limiter.getConnectionStats(conn)?.messagesDropped).toBe(1);
		expect(closeCalls.length).toBe(0);
	});

	test('a request is still refused once the connection is closed for abuse', () => {
		const limiter = new MessageRateLimiter({
			warningThreshold: 50,
			throttleThreshold: 100,
			disconnectThreshold: 200,
			windowMs: 1000
		});
		const { conn, closeCalls } = createMockConnection();

		for (let i = 0; i < 199; i++) {
			limiter.checkRateLimit(conn, 'files:list-tree', true);
		}

		// Requests are exempt from THROTTLING, not from the abuse ceiling: past the
		// disconnect threshold the socket is gone, so there is nothing to protect.
		expect(limiter.checkRateLimit(conn, 'files:list-tree', true)).toBe(false);
		expect(limiter.getConnectionStats(conn)?.isFlagged).toBe(true);
		expect(closeCalls.length).toBe(1);
	});

	test('drops and closes connection at disconnect threshold', () => {
		const limiter = new MessageRateLimiter({
			warningThreshold: 50,
			throttleThreshold: 300,
			disconnectThreshold: 200,
			windowMs: 1000
		});
		const { conn, closeCalls } = createMockConnection();

		for (let i = 0; i < 199; i++) {
			expect(limiter.checkRateLimit(conn, 'chat:send')).toBe(true);
		}

		expect(limiter.checkRateLimit(conn, 'chat:send')).toBe(false);
		const stats = limiter.getConnectionStats(conn);
		expect(stats?.isFlagged).toBe(true);
		expect(stats?.messagesDropped).toBe(1);
		expect(closeCalls.length).toBe(1);
		expect(closeCalls[0]).toEqual({ code: 1008, reason: 'Rate limit exceeded' });
	});
});
