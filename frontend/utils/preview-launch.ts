/**
 * The two rules a cancelled preview launch turns on.
 *
 * A launch is the window between "open this URL" and the backend reporting a
 * tab. There is no tab id for its whole length, which is what makes Stop hard:
 * the thing to stop has no name yet, and the tab that eventually arrives has to
 * find its way back to the slot that asked for it.
 */

export interface LaunchSlot {
	/** The launch this slot is waiting on, while it is waiting. */
	launchId?: string | null;
	/** Whether a launch request is in flight for this slot. */
	isLaunchingBrowser?: boolean;
	sessionId?: string | null;
}

/**
 * The slot a newly reported tab belongs to.
 *
 * Matched on the launch's name first. The fallback — "whichever slot is
 * launching" — is kept for clients that started a launch without naming it,
 * but it must never be the primary rule: pressing Stop clears the launching
 * flag, and a tab that then matched nothing was materialised as a second tab
 * on the same URL, appearing seconds after the user asked for the load to end.
 */
export function findLaunchSlot<T extends LaunchSlot>(
	slots: readonly T[],
	launchId?: string | null
): T | undefined {
	if (launchId) {
		const named = slots.find((slot) => slot.launchId === launchId);
		if (named) return named;
	}

	return slots.find((slot) => slot.isLaunchingBrowser && !slot.sessionId);
}

/**
 * The address to show for a tab the backend has just reported.
 *
 * A page that never committed a navigation sits on `about:blank`. Showing that
 * would empty the address bar the user had just typed into and take away the
 * one thing Reload needs, so the requested address wins whenever the page did
 * not actually land anywhere.
 */
export function resolveLandedUrl(reported: string | undefined | null, requested: string): string {
	if (reported && reported !== 'about:blank') return reported;
	return requested || reported || '';
}
