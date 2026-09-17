/**
 * Notification wording — the single source of truth for every notification
 * Clopen raises, on both sides of the wire.
 *
 * Every chat event is announced twice: the open tab raises a local toast, and
 * the server pushes to the user's registered devices so the notice survives a
 * closed tab. The two copies share a tag, which means the server copy
 * *replaces* the local one rather than stacking beside it — and a replacement
 * is only invisible when both say exactly the same thing. Four separate
 * copies of these strings (two per side) is what let them drift apart before.
 */

/** Chat lifecycle moments worth interrupting the user for. */
export type ChatNotificationEvent = 'completed' | 'cancelled' | 'error' | 'waiting-input';

/**
 * Where the event happened. Both fields are optional because both can be
 * genuinely unknown — a project row deleted mid-stream, a session whose title
 * has not been derived from the first message yet.
 */
export interface ChatNotificationContext {
	projectName?: string;
	sessionTitle?: string;
}

/**
 * How long a push service holds a notification for a device it cannot reach.
 *
 * This is the whole mechanism behind "notify me even though I closed the
 * browser". A phone with the screen off, or a laptop whose browser is not
 * running, is simply unreachable: the push service queues the message and
 * replays it the moment that device reconnects. A TTL shorter than the gap
 * throws the notification away instead — which is the one outcome this
 * feature exists to prevent.
 *
 * Twelve hours covers a laptop closed overnight or a phone left face-down
 * through a working day, and still expires before a completion notice turns
 * into archaeology.
 *
 * Lives here rather than with the sender because the settings panel quotes the
 * duration back to the user; two hand-maintained copies of "12 hours" is a
 * promise the code can silently stop keeping.
 */
export const PUSH_TTL_SECONDS = 12 * 3600;

/** Human form of {@link PUSH_TTL_SECONDS}, for prose that quotes it. */
export function pushTtlLabel(): string {
	const hours = Math.round(PUSH_TTL_SECONDS / 3600);
	return hours === 1 ? '1 hour' : `${hours} hours`;
}

/**
 * A session title is free text from the user's first message, so it is
 * unbounded. Notification centres give the body a line or two before they
 * truncate, and they truncate the *end* — which is where the project name
 * would be if the title ran long.
 */
const MAX_SESSION_TITLE_CHARS = 40;

/**
 * The title states what happened; the body states where.
 *
 * Titles used to name the engine ("Claude Response Complete") on a product
 * that runs eight of them, and the cancelled case contradicted its own body by
 * announcing a completion. They also never truncate: every OS clips the title
 * around forty characters, and a title that leads with an unbounded project
 * name loses the status first — the one thing the notification exists to say.
 */
const CHAT_TITLES: Record<ChatNotificationEvent, string> = {
	completed: 'Response ready',
	cancelled: 'Response stopped',
	error: 'Response failed',
	'waiting-input': 'Needs your input'
};

/**
 * What the body says when neither the project nor the session could be
 * resolved. Never empty: a notification with no body renders as a bare title
 * strip on most platforms.
 */
const CHAT_FALLBACK_BODIES: Record<ChatNotificationEvent, string> = {
	completed: 'Your chat response is ready.',
	cancelled: 'The response stopped before it finished.',
	error: 'The engine reported an error.',
	'waiting-input': 'A question is waiting for your answer.'
};

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Compose the body from whatever context resolved.
 *
 * An absent segment is dropped rather than filled in: the old `"Unknown"`
 * placeholder was shown to the user as though it were a project name, and told
 * them strictly less than leaving it out.
 */
function chatNotificationBody(
	event: ChatNotificationEvent,
	context: ChatNotificationContext
): string {
	const project = context.projectName?.trim();
	const session = context.sessionTitle?.trim();
	const quotedSession = session ? `"${truncate(session, MAX_SESSION_TITLE_CHARS)}"` : '';

	if (project && quotedSession) return `${project} — ${quotedSession}`;
	if (project) return project;
	if (quotedSession) return quotedSession;
	return CHAT_FALLBACK_BODIES[event];
}

/** Title and body for one chat event. Identical on the server and in the tab. */
export function chatNotificationMessage(
	event: ChatNotificationEvent,
	context: ChatNotificationContext = {}
): { title: string; body: string } {
	return {
		title: CHAT_TITLES[event],
		body: chatNotificationBody(event, context)
	};
}

/**
 * Test Push wording, split by the route that actually carried it.
 *
 * Both routes end at the same OS notification centre, so an identical body
 * ("Push notifications are working correctly") left the user unable to tell
 * whether the network leg was proven or whether the test had quietly fallen
 * back to a toast the open tab raised itself — which proves nothing about
 * delivery with the tab closed.
 */
export const TEST_PUSH_MESSAGES = {
	background: {
		title: 'Test notification',
		body: 'Delivered through the background push service.'
	},
	local: {
		title: 'Test notification',
		body: 'Shown by this browser tab.'
	}
} as const;
