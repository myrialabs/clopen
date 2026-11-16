/**
 * The owner's profile — who Clopen works for, kept by Clopen itself.
 *
 * A short free-text note (name, language, work, the accounts and tools they
 * use, how they like answers) that the assistant rewrites through the
 * `profile.update` action as it learns. It rides in every brief, so a fresh
 * chat already knows the person on the other side.
 */

import { settingsQueries } from '$backend/database/queries';

const KEY = 'assistant:profile';
export const PROFILE_MAX = 1500;

export function getProfile(): string {
	return settingsQueries.get(KEY)?.value ?? '';
}

export function saveProfile(text: string): string {
	const next = text.trim().slice(0, PROFILE_MAX);
	if (next) settingsQueries.set(KEY, next);
	else settingsQueries.delete(KEY);
	return next;
}
