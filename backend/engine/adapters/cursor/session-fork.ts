/**
 * Cursor fork-on-resume.
 *
 * Clopen's multi-branch checkpoints require every resumed turn to fork so the
 * source branch's history is never mutated (README §10.10). Cursor has no native
 * fork — `Agent.resume(agentId)` continues the SAME agent in place — so we fork by
 * copying the parent agent's persisted state under a fresh `agentId`:
 *
 *   1. read the parent agent document (metadata + `latestCheckpoint` pointer)
 *   2. copy every content-addressed checkpoint blob to the new agent id
 *   3. write a new agent document seeded with the parent's checkpoint pointer
 *
 * The conversation transcript lives in the checkpoint blobs, so the resumed agent
 * replays the exact ancestor branch. Runs / run-events (the streaming log) are
 * intentionally NOT copied — they are per-turn history, not conversation context.
 *
 * Returns the new agent id, or `undefined` when the parent is missing on disk
 * (evicted / cross-restart) so the caller can gracefully start a fresh agent.
 */

import type { JsonlLocalAgentStore } from '@cursor/sdk';
import { debug } from '$shared/utils/logger';

/** Page through a checkpoint blob-id listing (id-based cursor). */
async function listAllCheckpointBlobIds(store: JsonlLocalAgentStore, agentId: string): Promise<string[]> {
	const ids: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await store.checkpoints.list({ filter: { agentIds: [agentId], cursor, limit: 500 } });
		ids.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor);
	return ids;
}

export async function forkCursorAgent(store: JsonlLocalAgentStore, parentAgentId: string): Promise<string | undefined> {
	const parent = await store.agents.get({ agentId: parentAgentId });
	if (!parent) {
		debug.warn('engine', `Cursor fork: parent agent ${parentAgentId} not found on disk, starting fresh`);
		return undefined;
	}

	const newAgentId = `agent-${crypto.randomUUID()}`;

	// Copy every checkpoint blob (content-addressed) to the new agent id.
	const blobIds = await listAllCheckpointBlobIds(store, parentAgentId);
	for (const blobId of blobIds) {
		const data = await store.checkpoints.get({ agentId: parentAgentId, blobId });
		if (data) await store.checkpoints.create({ agentId: newAgentId, blobId, data });
	}

	// Seed the new agent document with the parent's checkpoint pointer. `Date.now()`
	// is fine here (backend runtime, not a workflow script).
	const now = Date.now();
	await store.agents.create({
		agent: {
			...parent,
			agentId: newAgentId,
			status: 'idle',
			activeRunId: null,
			createdAt: now,
			updatedAt: now,
		},
	});

	debug.log('engine', `Cursor resumed agent ${parentAgentId} → fork ${newAgentId} (${blobIds.length} checkpoint blob(s))`);
	return newAgentId;
}
