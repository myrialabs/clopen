/**
 * Behavior-based tests for AuthRateLimiter.
 *
 * Validates:
 *  - Failure-based lockout tiers (5/10/20 → 30s/2m/10m) still trigger.
 *  - Lockout state is per-route and per-identifier, so a lockout on one
 *    endpoint neither blocks nor is cleared by another.
 *  - `recordSuccess` clears only its own route's record.
 *
 * Each test uses a unique identifier so the singleton's in-memory state does
 * not bleed across tests.
 */

import { describe, expect, test } from 'bun:test';
import { authRateLimiter } from './rate-limiter';

let seq = 0;
function uniqueId(label: string): string {
	// IPv4-shaped string the rate limiter treats as opaque.
	return `203.0.113.${++seq}-${label}`;
}

/** Read the remaining lockout out of `check()`'s message. */
function remainingMs(result: string | null): number | null {
	if (result === null) return null;
	const match = result.match(/Try again in (\d+) seconds/);
	return match ? Number(match[1]) * 1000 : 0;
}

/** Drive an identifier to `count` failures on one route. */
function fail(id: string, action: string, count: number): void {
	for (let i = 0; i < count; i++) authRateLimiter.recordFailure(id, action);
}

describe('failure-based lockout tiers', () => {
	test('four failures stay below the first threshold', () => {
		const id = uniqueId('4fail');
		fail(id, 'auth:login', 4);
		expect(authRateLimiter.check(id, 'auth:login')).toBeNull();
	});

	test('five failures lock for 30s', () => {
		const id = uniqueId('5fail');
		fail(id, 'auth:login', 5);
		expect(remainingMs(authRateLimiter.check(id, 'auth:login'))).toBeGreaterThanOrEqual(25_000);
		expect(remainingMs(authRateLimiter.check(id, 'auth:login'))).toBeLessThanOrEqual(30_500);
	});

	test('ten failures escalate to a 2-minute lockout', () => {
		const id = uniqueId('10fail');
		fail(id, 'auth:login', 10);
		expect(remainingMs(authRateLimiter.check(id, 'auth:login'))).toBeGreaterThanOrEqual(115_000);
		expect(remainingMs(authRateLimiter.check(id, 'auth:login'))).toBeLessThanOrEqual(120_500);
	});

	test('twenty failures escalate to a 10-minute lockout', () => {
		const id = uniqueId('20fail');
		fail(id, 'auth:login', 20);
		expect(remainingMs(authRateLimiter.check(id, 'auth:login'))).toBeGreaterThanOrEqual(595_000);
		expect(remainingMs(authRateLimiter.check(id, 'auth:login'))).toBeLessThanOrEqual(600_500);
	});

	test('routes outside the rate-limited set are ignored', () => {
		const id = uniqueId('unlimited');
		fail(id, 'auth:logout', 5);
		expect(authRateLimiter.check(id, 'auth:logout')).toBeNull();
	});
});

describe('per-route isolation', () => {
	test('a lockout on auth:login does not block auth:validate-invite', () => {
		const id = uniqueId('route-iso');
		fail(id, 'auth:login', 5);

		expect(authRateLimiter.check(id, 'auth:login')).not.toBeNull();
		expect(authRateLimiter.check(id, 'auth:validate-invite')).toBeNull();
		expect(authRateLimiter.check(id, 'auth:claim-device-code')).toBeNull();
	});

	test('success on one route does not clear another route\'s failures', () => {
		const id = uniqueId('no-cross-clear');
		fail(id, 'auth:login', 5);
		authRateLimiter.recordSuccess(id, 'auth:validate-invite');

		expect(authRateLimiter.check(id, 'auth:login')).not.toBeNull();
	});

	test('success clears the lockout for its own route', () => {
		const id = uniqueId('self-clear');
		fail(id, 'auth:login', 5);
		authRateLimiter.recordSuccess(id, 'auth:login');

		expect(authRateLimiter.check(id, 'auth:login')).toBeNull();
	});

	test('a valid invite clears the failures from earlier mistyped ones', () => {
		const id = uniqueId('invite-retry');
		fail(id, 'auth:validate-invite', 2);
		authRateLimiter.recordSuccess(id, 'auth:validate-invite');
		fail(id, 'auth:validate-invite', 4);

		expect(authRateLimiter.check(id, 'auth:validate-invite')).toBeNull();
	});
});

describe('per-identifier isolation', () => {
	test('one identifier locking out does not affect another', () => {
		const idA = uniqueId('ipA');
		const idB = uniqueId('ipB');
		fail(idA, 'auth:login', 5);

		expect(authRateLimiter.check(idA, 'auth:login')).not.toBeNull();
		expect(authRateLimiter.check(idB, 'auth:login')).toBeNull();
	});
});
