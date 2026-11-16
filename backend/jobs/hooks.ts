/**
 * A webhook per repeating task: a secret URL that runs it now. Anything that
 * can send an HTTP request — a shortcut on a phone, n8n, a CI job, a cron on
 * another server — can start the task, and what it sends becomes the run's
 * context.
 *
 * The token is the only credential, so it is long, random, shown only to the
 * signed-in owner, and replaceable (the old URL stops working at once).
 * Tokens live in settings, keyed by task.
 */

import { randomBytes } from 'node:crypto';
import { settingsQueries } from '$backend/database/queries';

const KEY = 'assistant:flow-hooks';

function read(): Record<string, string> {
	try {
		return JSON.parse(settingsQueries.get(KEY)?.value ?? '{}') as Record<string, string>;
	} catch {
		return {};
	}
}

function write(hooks: Record<string, string>): void {
	settingsQueries.set(KEY, JSON.stringify(hooks));
}

export const hookPath = (token: string) => `/api/hooks/tasks/${token}`;

/** The task's webhook token, made on first ask. */
export function flowHookToken(jobId: string): string {
	const hooks = read();
	if (hooks[jobId]) return hooks[jobId];
	hooks[jobId] = randomBytes(24).toString('base64url');
	write(hooks);
	return hooks[jobId];
}

/** A new token; the old URL stops working. */
export function regenerateFlowHook(jobId: string): string {
	const hooks = read();
	hooks[jobId] = randomBytes(24).toString('base64url');
	write(hooks);
	return hooks[jobId];
}

export function forgetFlowHook(jobId: string): void {
	const hooks = read();
	if (!(jobId in hooks)) return;
	delete hooks[jobId];
	write(hooks);
}

/** The task a token runs, or null. Compared in constant time. */
export function flowForToken(token: string): string | null {
	if (!token || token.length < 20) return null;
	for (const [jobId, known] of Object.entries(read())) {
		if (known.length === token.length && Buffer.from(known).equals(Buffer.from(token))) return jobId;
	}
	return null;
}

/** At most this many runs a minute per webhook: a loop elsewhere must not run a task hundreds of times. */
const PER_MINUTE = 10;
const recent = new Map<string, number[]>();

export function allowHookCall(jobId: string): boolean {
	const now = Date.now();
	const calls = (recent.get(jobId) ?? []).filter((at) => now - at < 60_000);
	if (calls.length >= PER_MINUTE) return false;
	calls.push(now);
	recent.set(jobId, calls);
	return true;
}
