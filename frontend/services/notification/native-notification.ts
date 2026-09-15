/**
 * Helpers for the native Notification API.
 *
 * Split out from `push.service.ts` because that module imports a runes store
 * and therefore cannot be loaded from a test. Everything here is pure and
 * DOM-free so the rules that actually decide whether a user sees a
 * notification can be pinned by tests.
 */

/**
 * - `shown` — the OS confirmed display via the `show` event.
 * - `blocked` — the platform reported failure via the `error` event.
 * - `unconfirmed` — neither event arrived in time; the toast may or may not
 *   be on screen, so the caller must not destroy it.
 */
export type NotificationShowResult = 'shown' | 'blocked' | 'unconfirmed';

/** The slice of `Notification` the confirmation helper needs. */
export interface ShowEventSource {
	addEventListener(type: 'show' | 'error', listener: () => void): void;
	removeEventListener(type: 'show' | 'error', listener: () => void): void;
}

let tagCounter = 0;

/**
 * A tag no live notification can already be using.
 *
 * Tags are not labels — they are identity. Constructing a notification whose
 * tag matches one the browser is already showing *replaces* that one, and
 * Chrome performs the replacement silently: no banner, no sound, and on
 * Windows the existing Action Center entry is updated in place. Two chats
 * finishing therefore produced exactly one visible notification.
 *
 * The counter alone would repeat across a reload while older notifications
 * are still on screen, so it is paired with a timestamp.
 */
export function uniqueNotificationTag(prefix: string): string {
	tagCounter += 1;
	return `${prefix}-${Date.now()}-${tagCounter}`;
}

/**
 * Resolve once the OS confirms (or rejects) display, or once `timeoutMs`
 * elapses.
 *
 * `new Notification()` returning without throwing only means the browser
 * accepted the request. Windows Focus Assist, macOS Do Not Disturb and a
 * missing Linux notification daemon all drop the toast after that point, so
 * the `show` event is the only cross-platform evidence the user saw
 * anything.
 *
 * A missing `show` is reported as `unconfirmed`, never as failure: some
 * platform and browser combinations display the toast without ever emitting
 * the event, and calling a working setup broken is its own bug.
 *
 * Listeners are always detached and the timer always cleared, so a late
 * `show` on an already-resolved notification cannot leak or re-resolve.
 */
export function waitForNotificationShown(
	notification: ShowEventSource,
	timeoutMs: number
): Promise<NotificationShowResult> {
	return new Promise<NotificationShowResult>((resolve) => {
		let settled = false;

		const settle = (result: NotificationShowResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			notification.removeEventListener('show', onShow);
			notification.removeEventListener('error', onError);
			resolve(result);
		};

		const onShow = () => settle('shown');
		const onError = () => settle('blocked');

		const timer = setTimeout(() => settle('unconfirmed'), timeoutMs);

		notification.addEventListener('show', onShow);
		notification.addEventListener('error', onError);
	});
}
