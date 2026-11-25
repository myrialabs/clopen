/**
 * Storage Router — Settings → Storage.
 *
 * - storage:get         the last report, scan status, policy, actions, history
 * - storage:scan        start a scan (or join the running one); progress arrives
 *                       as `storage:scan-status`
 * - storage:estimate    what an action would free, for the confirm dialog
 * - storage:cleanup     run an action now
 * - storage:policy-save save the schedule
 * - storage:run-now     run the scheduled set now
 *
 * Report and result payloads are typed in `$shared/types/storage` and sent as
 * `t.Any()`, like the other report-shaped endpoints.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import type { CleanupActionId, StoragePolicy } from '$shared/types/storage';
import { broadcastPresence } from '../projects/status';
import { CLEANUP_ACTIONS, estimateCleanup, runCleanup, runningCleanup } from '../../storage/actions';
import { listCleanupRuns } from '../../storage/history';
import { getStoragePolicy, runScheduledCleanup, saveStoragePolicy } from '../../storage/policy';
import { getLastStorageReport, getStorageScanStatus, onStorageScan, scanStorage } from '../../storage/scanner';

const actionIds = CLEANUP_ACTIONS.map(action => t.Literal(action.id));
const cleanupRequest = t.Object({
	action: t.Union(actionIds),
	projectId: t.Optional(t.Union([t.String(), t.Null()])),
	olderThanDays: t.Optional(t.Number({ minimum: 1, maximum: 3650 }))
});

onStorageScan((status, report) => {
	ws.emit.global('storage:scan-status', { status, report });
});

function snapshot() {
	return {
		report: getLastStorageReport(),
		status: getStorageScanStatus(),
		policy: getStoragePolicy(),
		actions: CLEANUP_ACTIONS,
		history: listCleanupRuns(),
		running: runningCleanup()
	};
}

export const storageRouter = createRouter()
	.http('storage:get', {
		data: t.Object({}),
		response: t.Any()
	}, async () => snapshot())

	.http('storage:scan', {
		data: t.Object({}),
		response: t.Any()
	}, async () => {
		void scanStorage().catch(() => {});
		return getStorageScanStatus();
	})

	.http('storage:estimate', {
		data: cleanupRequest,
		response: t.Any()
	}, async ({ data }) => estimateCleanup({ ...data, action: data.action as CleanupActionId }))

	.http('storage:cleanup', {
		data: cleanupRequest,
		response: t.Any()
	}, async ({ data }) => {
		const result = await runCleanup({ ...data, action: data.action as CleanupActionId }, 'manual');
		ws.emit.global('storage:cleanup-finished', { result, history: listCleanupRuns() });
		if (data.action === 'delete-old-chats') {
			broadcastPresence().catch(() => {});
		}
		void scanStorage().catch(() => {});
		return result;
	})

	.http('storage:policy-save', {
		data: t.Object({ policy: t.Any() }),
		response: t.Any()
	}, async ({ data }) => saveStoragePolicy(data.policy as StoragePolicy))

	.http('storage:run-now', {
		data: t.Object({}),
		response: t.Any()
	}, async () => {
		void runScheduledCleanup().then(() => {
			ws.emit.global('storage:cleanup-finished', { result: null, history: listCleanupRuns() });
		});
		return { started: true };
	})

	.emit('storage:scan-status', t.Object({
		status: t.Any(),
		report: t.Any()
	}))
	.emit('storage:cleanup-finished', t.Object({
		result: t.Any(),
		history: t.Any()
	}));
