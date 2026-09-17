/**
 * Tests for the Web Push subscription store.
 *
 * Two invariants carry the feature. One row per device endpoint, so a phone
 * that re-subscribes on every app open does not accumulate duplicates and
 * receive N copies of every notification. And a purge that covers the whole
 * user, because `pushNotifications` is a single per-user setting synced
 * across devices — switching it off on a laptop has to silence the phone.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { initializeDatabase, closeDatabase } from '../index';
import { pushSubscriptionQueries } from './push-subscription-queries';

const userA = `user-a-${randomUUID()}`;
const userB = `user-b-${randomUUID()}`;

function subscribe(userId: string, suffix: string) {
	return pushSubscriptionQueries.upsert({
		userId,
		endpoint: `https://push.example.com/${suffix}`,
		p256dh: 'p256dh-'.padEnd(20, 'x'),
		auth: 'auth-'.padEnd(16, 'x'),
		userAgent: 'test-agent'
	});
}

beforeAll(async () => {
	await initializeDatabase();
});

beforeEach(() => {
	pushSubscriptionQueries.deleteAllByUser(userA);
	pushSubscriptionQueries.deleteAllByUser(userB);
});

afterAll(() => {
	pushSubscriptionQueries.deleteAllByUser(userA);
	pushSubscriptionQueries.deleteAllByUser(userB);
	closeDatabase();
});

describe('pushSubscriptionQueries', () => {
	it('keeps one row per endpoint when the same device re-subscribes', () => {
		const first = subscribe(userA, 'device-1');
		const second = pushSubscriptionQueries.upsert({
			userId: userA,
			endpoint: 'https://push.example.com/device-1',
			p256dh: 'rotated-p256dh'.padEnd(20, 'x'),
			auth: 'rotated-auth'.padEnd(16, 'x')
		});

		expect(second.id).toBe(first.id);
		expect(second.p256dh).toBe('rotated-p256dh'.padEnd(20, 'x'));
		expect(pushSubscriptionQueries.listByUser(userA)).toHaveLength(1);
	});

	it('deletes every device of one user and leaves other users untouched', () => {
		subscribe(userA, 'phone');
		subscribe(userA, 'tablet');
		subscribe(userB, 'other-phone');

		expect(pushSubscriptionQueries.deleteAllByUser(userA)).toBe(2);
		expect(pushSubscriptionQueries.listByUser(userA)).toHaveLength(0);
		expect(pushSubscriptionQueries.listByUser(userB)).toHaveLength(1);
	});

	it('scopes a single-endpoint delete to its owner', () => {
		subscribe(userA, 'shared-looking-endpoint');

		expect(
			pushSubscriptionQueries.deleteByEndpoint(
				userB,
				'https://push.example.com/shared-looking-endpoint'
			)
		).toBe(false);
		expect(pushSubscriptionQueries.listByUser(userA)).toHaveLength(1);
	});

	it('prunes a stale endpoint regardless of owner', () => {
		subscribe(userA, 'expired');

		expect(
			pushSubscriptionQueries.deleteStaleByEndpoint('https://push.example.com/expired')
		).toBe(true);
		expect(pushSubscriptionQueries.listByUser(userA)).toHaveLength(0);
	});
});
