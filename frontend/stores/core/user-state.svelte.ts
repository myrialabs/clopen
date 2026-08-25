/**
 * User Server State — single loader for `user:restore-state`.
 *
 * Every per-user value the app persists (settings, last view, project order,
 * unread sessions, todo panel, command usage) arrives in one round trip. This
 * module owns that call so there is exactly one place that decides whether the
 * client actually holds the user's saved state.
 *
 * That distinction matters: stores here persist by sending their whole object
 * back to the server, so acting on defaults that were never replaced by the
 * server's copy silently overwrites the real one. Callers must therefore treat
 * `null` as "not loaded" and refuse to save — see `settings.svelte.ts`.
 *
 * The load is single-flight and cached on success; a failure is not cached, so
 * the next caller retries.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

/** Mirrors the `user:restore-state` response — free-form values stay untyped. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RestoredValue = any;

export interface UserServerState {
	currentProjectId: string | null;
	lastView: string | null;
	settings: RestoredValue;
	unreadSessions: RestoredValue;
	todoPanelState: RestoredValue;
	projectOrder: string[] | null;
	commandUsage: RestoredValue;
}

let loaded: UserServerState | null = null;
let inFlight: Promise<UserServerState | null> | null = null;

/**
 * Fetch the current user's server-side state, reusing an in-flight or completed
 * load. Returns `null` when the state could not be retrieved — never throws, so
 * a failed restore cannot take down the caller's initialization path.
 */
export async function loadUserState(): Promise<UserServerState | null> {
	if (loaded) return loaded;
	if (inFlight) return inFlight;

	inFlight = ws.http('user:restore-state', {})
		.then((state) => {
			loaded = state as UserServerState;
			debug.log('user', 'User state loaded');
			return loaded;
		})
		.catch((err) => {
			debug.error('user', 'Failed to load user state:', err);
			return null;
		})
		.finally(() => {
			inFlight = null;
		});

	return inFlight;
}

/** The loaded state, or `null` if it has not been successfully loaded yet. */
export function getLoadedUserState(): UserServerState | null {
	return loaded;
}

/**
 * Drop the cached state. Called on sign-out so the next session never inherits
 * (or persists over) the previous user's saved state.
 */
export function resetUserState(): void {
	loaded = null;
	inFlight = null;
}
