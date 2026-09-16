import { describe, expect, test } from 'bun:test';

import {
	uniqueNotificationTag,
	waitForNotificationShown,
	type ShowEventSource
} from './native-notification';

/** Minimal stand-in for `Notification`, so the helper can be driven by hand. */
function fakeNotification() {
	const listeners = new Map<string, Set<() => void>>();

	const source: ShowEventSource = {
		addEventListener(type, listener) {
			const set = listeners.get(type) ?? new Set<() => void>();
			set.add(listener);
			listeners.set(type, set);
		},
		removeEventListener(type, listener) {
			listeners.get(type)?.delete(listener);
		}
	};

	return {
		source,
		emit(type: 'show' | 'error') {
			for (const listener of [...(listeners.get(type) ?? [])]) listener();
		},
		listenerCount(type: 'show' | 'error') {
			return listeners.get(type)?.size ?? 0;
		}
	};
}

describe('uniqueNotificationTag', () => {
	test('never repeats a tag, even within the same millisecond', () => {
		const tags = Array.from({ length: 200 }, () => uniqueNotificationTag('chat-complete'));

		expect(new Set(tags).size).toBe(tags.length);
	});

	test('keeps the prefix so tags stay recognisable', () => {
		expect(uniqueNotificationTag('test')).toStartWith('test-');
	});

	test('does not share a tag across different prefixes', () => {
		expect(uniqueNotificationTag('chat-complete')).not.toBe(uniqueNotificationTag('chat-error'));
	});
});

describe('waitForNotificationShown', () => {
	test('resolves shown when the OS confirms display', async () => {
		const notification = fakeNotification();
		const result = waitForNotificationShown(notification.source, 1000);

		notification.emit('show');

		expect(await result).toBe('shown');
	});

	test('resolves blocked when the platform reports an error', async () => {
		const notification = fakeNotification();
		const result = waitForNotificationShown(notification.source, 1000);

		notification.emit('error');

		expect(await result).toBe('blocked');
	});

	test('resolves unconfirmed — not blocked — when neither event arrives', async () => {
		const notification = fakeNotification();

		expect(await waitForNotificationShown(notification.source, 10)).toBe('unconfirmed');
	});

	test('detaches both listeners once settled', async () => {
		const notification = fakeNotification();
		const result = waitForNotificationShown(notification.source, 1000);

		notification.emit('show');
		await result;

		expect(notification.listenerCount('show')).toBe(0);
		expect(notification.listenerCount('error')).toBe(0);
	});

	test('keeps the first result when a later event fires', async () => {
		const notification = fakeNotification();
		const result = waitForNotificationShown(notification.source, 1000);

		notification.emit('show');
		notification.emit('error');

		expect(await result).toBe('shown');
	});

	test('a show arriving after the timeout cannot override unconfirmed', async () => {
		const notification = fakeNotification();
		const result = waitForNotificationShown(notification.source, 10);

		await new Promise((resolve) => setTimeout(resolve, 30));
		notification.emit('show');

		expect(await result).toBe('unconfirmed');
	});
});
