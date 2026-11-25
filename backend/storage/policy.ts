/**
 * Scheduled cleanup.
 *
 * Every action that can be automated can be switched on here, with the same
 * parameters it takes by hand. The defaults switch on only what nothing uses —
 * leftovers, duplicates, old logs — because those are pure loss to keep. Caches,
 * the database rebuild, worktrees and old chats are off until the user turns them
 * on: each has a cost (a download, a pause, lost history) that is theirs to
 * accept.
 *
 * A run happens at most once per `intervalHours`, only while nothing is
 * streaming, and stops between actions as soon as a chat starts.
 */

import { settingsQueries } from '$backend/database/queries/settings-queries';
import type { CleanupActionId, StoragePolicy } from '$shared/types/storage';
import { debug } from '$shared/utils/logger';
import { CLEANUP_ACTIONS, runCleanup, runningCleanup } from './actions';
import { activeChatIds } from './purge';
import { scanStorage } from './scanner';

const POLICY_SETTING = 'storage_policy';
const TICK_MS = 30 * 60_000;
const FIRST_TICK_MS = 10 * 60_000;

/** Order a scheduled run goes in: cheap and safe first, the database last. */
const RUN_ORDER: CleanupActionId[] = [
	'orphan-transcripts', 'dedupe-transcripts', 'orphan-snapshots', 'orphan-profiles', 'orphan-worktree-dirs',
	'legacy-engine-data', 'engine-logs', 'browser-cache', 'tool-caches', 'stale-worktrees',
	'slim-old-chats', 'delete-old-chats', 'compact-database'
];

export function defaultStoragePolicy(): StoragePolicy {
	return {
		enabled: true,
		intervalHours: 24,
		actions: {
			'orphan-transcripts': { enabled: true },
			'dedupe-transcripts': { enabled: true },
			'orphan-snapshots': { enabled: true },
			'orphan-profiles': { enabled: true },
			'orphan-worktree-dirs': { enabled: true },
			'legacy-engine-data': { enabled: true },
			'engine-logs': { enabled: true },
			'browser-cache': { enabled: false },
			'tool-caches': { enabled: false },
			'compact-database': { enabled: false },
			'stale-worktrees': { enabled: false, olderThanDays: 60 },
			'slim-old-chats': { enabled: false, olderThanDays: 90 },
			'delete-old-chats': { enabled: false, olderThanDays: 365 }
		},
		lastRunAt: null
	};
}

export function getStoragePolicy(): StoragePolicy {
	const defaults = defaultStoragePolicy();
	const raw = settingsQueries.get(POLICY_SETTING)?.value;
	if (!raw) return defaults;
	try {
		const saved = JSON.parse(raw) as Partial<StoragePolicy>;
		return {
			enabled: saved.enabled ?? defaults.enabled,
			intervalHours: saved.intervalHours ?? defaults.intervalHours,
			actions: { ...defaults.actions, ...saved.actions },
			lastRunAt: saved.lastRunAt ?? null
		};
	} catch {
		return defaults;
	}
}

export function saveStoragePolicy(policy: StoragePolicy): StoragePolicy {
	const automatable = new Set(CLEANUP_ACTIONS.filter(action => action.automatable).map(action => action.id));
	const clean: StoragePolicy = {
		enabled: !!policy.enabled,
		intervalHours: Math.min(24 * 30, Math.max(1, Math.round(policy.intervalHours || 24))),
		actions: {},
		lastRunAt: getStoragePolicy().lastRunAt
	};
	for (const [id, setting] of Object.entries(policy.actions ?? {})) {
		if (!automatable.has(id as CleanupActionId) || !setting) continue;
		clean.actions[id as CleanupActionId] = {
			enabled: !!setting.enabled,
			...(setting.olderThanDays !== undefined && {
				olderThanDays: Math.min(3650, Math.max(1, Math.round(setting.olderThanDays)))
			})
		};
	}
	settingsQueries.set(POLICY_SETTING, JSON.stringify(clean));
	return getStoragePolicy();
}

function markRun(): void {
	const policy = getStoragePolicy();
	settingsQueries.set(POLICY_SETTING, JSON.stringify({ ...policy, lastRunAt: new Date().toISOString() }));
}

let timer: ReturnType<typeof setInterval> | null = null;
let runInFlight: Promise<void> | null = null;

/** Run every enabled action now, in order. */
export function runScheduledCleanup(): Promise<void> {
	if (runInFlight) return runInFlight;
	runInFlight = (async () => {
		const policy = getStoragePolicy();
		markRun();
		for (const action of RUN_ORDER) {
			const setting = policy.actions[action];
			if (!setting?.enabled) continue;
			if (activeChatIds().size > 0) {
				debug.log('storage', 'Scheduled cleanup paused: a chat started');
				break;
			}
			try {
				await runCleanup({ action, ...(setting.olderThanDays && { olderThanDays: setting.olderThanDays }) }, 'auto');
			} catch (error) {
				debug.warn('storage', `Scheduled ${action} failed:`, error);
			}
		}
		await scanStorage().catch(() => {});
	})().finally(() => {
		runInFlight = null;
	});
	return runInFlight;
}

function due(policy: StoragePolicy): boolean {
	if (!policy.enabled) return false;
	if (!policy.lastRunAt) return true;
	return Date.now() - Date.parse(policy.lastRunAt) >= policy.intervalHours * 60 * 60_000;
}

async function tick(): Promise<void> {
	if (runInFlight || runningCleanup()) return;
	if (activeChatIds().size > 0) return;
	try {
		if (due(getStoragePolicy())) await runScheduledCleanup();
	} catch (error) {
		debug.warn('storage', 'Storage maintenance tick failed:', error);
	}
}

export function startStorageMaintenance(): void {
	if (timer) return;
	timer = setInterval(() => void tick(), TICK_MS);
	timer.unref?.();
	const first = setTimeout(() => void tick(), FIRST_TICK_MS);
	first.unref?.();
}

export function stopStorageMaintenance(): void {
	if (!timer) return;
	clearInterval(timer);
	timer = null;
}
