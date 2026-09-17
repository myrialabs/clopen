/**
 * Web Push subscription storage.
 *
 * One row per (user, device endpoint). Subscribing twice from the same
 * browser reuses the same endpoint, so upsert keeps exactly one row per
 * device. Rows die two ways: explicit unsubscribe, or a 404/410 from the
 * push service on send (see `backend/push/sender.ts`).
 */

import { getDatabase } from '../index';

export interface PushSubscription {
	id: number;
	user_id: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	user_agent: string | null;
	created_at: string;
}

export interface PushSubscriptionInput {
	userId: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	userAgent?: string;
}

export const pushSubscriptionQueries = {
	upsert(input: PushSubscriptionInput): PushSubscription {
		const db = getDatabase();
		const now = new Date().toISOString();
		db.prepare(
			`
			INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(endpoint) DO UPDATE SET
				user_id = excluded.user_id,
				p256dh = excluded.p256dh,
				auth = excluded.auth,
				user_agent = excluded.user_agent
		`
		).run(
			input.userId,
			input.endpoint,
			input.p256dh,
			input.auth,
			input.userAgent ?? null,
			now
		);
		return db
			.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?')
			.get(input.endpoint) as PushSubscription;
	},

	listByUser(userId: string): PushSubscription[] {
		const db = getDatabase();
		return db
			.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at')
			.all(userId) as PushSubscription[];
	},

	deleteByEndpoint(userId: string, endpoint: string): boolean {
		const db = getDatabase();
		const result = db
			.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
			.run(userId, endpoint) as { changes: number | bigint };
		return Number(result.changes ?? 0) > 0;
	},

	/**
	 * Drop every device this user registered.
	 *
	 * `pushNotifications` is one per-user setting shared by all of their
	 * devices, so turning it off anywhere has to stop the pushes everywhere —
	 * deleting only the calling device's endpoint would leave a phone
	 * receiving notifications the settings screen says are off.
	 */
	deleteAllByUser(userId: string): number {
		const db = getDatabase();
		const result = db
			.prepare('DELETE FROM push_subscriptions WHERE user_id = ?')
			.run(userId) as { changes: number | bigint };
		return Number(result.changes ?? 0);
	},

	/**
	 * Delete regardless of owner. Used when a push service reports the
	 * endpoint expired (404/410) — the stored user may be stale too.
	 */
	deleteStaleByEndpoint(endpoint: string): boolean {
		const db = getDatabase();
		const result = db
			.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
			.run(endpoint) as { changes: number | bigint };
		return Number(result.changes ?? 0) > 0;
	}
};
