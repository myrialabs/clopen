/**
 * The scheduler — one timer, checked every 30 seconds.
 *
 * Flows are stored as jobs; a `once` flow switches itself off after its run,
 * a `manual` one never runs from here.
 *
 * A job runs when its `next_run_at` has passed. After a run, the next time is
 * worked out from the trigger again, never by adding to the old one, so a slow
 * run or a sleeping laptop cannot make a schedule drift.
 *
 * Missed runs: when Clopen was not running at a job's time (the computer was
 * off, or Clopen was not set to start with it), `run-once` runs it once now and
 * `skip` just moves on to the next time. Either way it never runs once per
 * missed slot — eight hours asleep is not eight morning reports.
 *
 * Event jobs have no clock; they subscribe to their integration's verified
 * webhooks and run when one arrives.
 */

import { jobQueries, type JobRow } from '$backend/database/queries';
import { onWebhook, type WebhookEvent } from '$backend/integrations/webhooks/gateway';
import { toJob } from '$backend/assistant/mappers';
import { debug } from '$shared/utils/logger';
import { nextRunFor } from './service';
import { runJob } from './runner';
import { observe, changeContext } from './watch';
import type { WatchTrigger } from '$shared/types/assistant';

const TICK_MS = 30_000;
/** A run this much later than planned counts as missed rather than merely late. */
const MISSED_AFTER_MS = 5 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
const subscribedProviders = new Set<string>();

function scheduleNext(row: JobRow, from: Date): void {
	const job = toJob(row);
	jobQueries.setSchedule(row.id, null, nextRunFor(job.trigger.type, job.trigger.config as unknown as Record<string, unknown>, from));
}

async function due(row: JobRow, now: Date): Promise<void> {
	const job = toJob(row);
	const planned = row.next_run_at ? new Date(row.next_run_at) : now;
	const missed = now.getTime() - planned.getTime() > MISSED_AFTER_MS;
	scheduleNext(row, now);
	// A one-off flow runs once and switches itself off.
	if (job.trigger.type === 'once') jobQueries.update(row.id, { enabled: false, nextRunAt: null });

	if (job.trigger.type === 'watch') {
		const trigger = job.trigger.config as WatchTrigger;
		const observation = await observe(trigger.target);
		const context = changeContext(row.watch_state, observation);
		jobQueries.setWatchState(row.id, JSON.stringify({ fingerprint: observation.fingerprint, at: now.toISOString() }));
		if (context) await runJob(row.id, 'watch: changed', context);
		return;
	}

	if (missed && row.missed_policy === 'skip') {
		debug.log('jobs', `Skipping missed run of ${row.name}`);
		return;
	}
	await runJob(row.id, missed ? 'schedule (missed)' : job.trigger.type === 'checkin' ? 'check-in' : 'schedule');
}

async function tick(): Promise<void> {
	if (ticking) return;
	ticking = true;
	try {
		const now = new Date();
		for (const row of jobQueries.listEnabled()) {
			if (row.trigger_type === 'event' || row.trigger_type === 'manual') continue;
			if (!row.next_run_at) {
				scheduleNext(row, now);
				continue;
			}
			if (new Date(row.next_run_at).getTime() > now.getTime()) continue;
			try {
				await due(row, now);
			} catch (error) {
				debug.warn('jobs', `Job ${row.name} failed to start:`, error);
			}
		}
		syncEventSubscriptions();
	} finally {
		ticking = false;
	}
}

function eventName(event: WebhookEvent): string | null {
	for (const header of ['x-github-event', 'x-gitlab-event', 'x-event-key', 'x-vercel-event', 'x-event-type']) {
		const value = event.headers.get(header);
		if (value) return value;
	}
	const payload = event.payload as { type?: unknown; action?: unknown } | null;
	return typeof payload?.type === 'string' ? payload.type : typeof payload?.action === 'string' ? payload.action : null;
}

function describeEvent(event: WebhookEvent, name: string | null): string {
	let body = '';
	try {
		body = JSON.stringify(event.payload, null, 2).slice(0, 6000);
	} catch {
		body = '(unreadable payload)';
	}
	return `${event.provider} event${name ? ` "${name}"` : ''} (delivery ${event.deliveryId}):\n${body}`;
}

async function onEvent(event: WebhookEvent): Promise<void> {
	const name = eventName(event);
	for (const row of jobQueries.listEnabled()) {
		if (row.trigger_type !== 'event') continue;
		const trigger = toJob(row).trigger.config as { provider: string; event?: string };
		if (trigger.provider !== event.provider) continue;
		if (trigger.event && trigger.event !== name) continue;
		try {
			await runJob(row.id, `event: ${name ?? event.provider}`, describeEvent(event, name));
		} catch (error) {
			debug.warn('jobs', `Event job ${row.name} failed to start:`, error);
		}
	}
}

/** Subscribe once per provider any event job listens to; the handler filters per job. */
function syncEventSubscriptions(): void {
	for (const row of jobQueries.listEnabled()) {
		if (row.trigger_type !== 'event') continue;
		const provider = (toJob(row).trigger.config as { provider?: string }).provider;
		if (!provider || subscribedProviders.has(provider)) continue;
		subscribedProviders.add(provider);
		onWebhook(provider, (event) => onEvent(event));
	}
}

export function startJobScheduler(): void {
	if (timer) return;
	syncEventSubscriptions();
	timer = setInterval(() => void tick(), TICK_MS);
	// First look shortly after startup, so missed runs are handled without waiting a full tick.
	setTimeout(() => void tick(), 5_000);
	debug.log('jobs', 'Job scheduler started');
}

export function stopJobScheduler(): void {
	if (timer) clearInterval(timer);
	timer = null;
}
