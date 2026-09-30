/**
 * Turn Changes Handler
 *
 * Everything the AI-change indicators and the checkpoint "Changes" tab read:
 * which files each turn of a chat touched, and the content on either side of
 * that change.
 *
 * Both are answered from checkpoint snapshots rather than from Edit/Write tool
 * calls — see backend/snapshot/turn-changes.ts for why that distinction is the
 * whole point. The one thing snapshots cannot answer is a turn that is still
 * running, which `snapshot:get-pending-changes` covers from the same baseline.
 *
 * Only checkpoints on the ACTIVE path are reported. After a restore, the
 * checkpoints that were undone no longer describe anything on disk, so keeping
 * their files in the list would mark files that carry no such change any more.
 * Active-path selection is done with the same helpers the timeline uses, so the
 * two views cannot disagree about which turns exist.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { isAbsolute, join, relative } from 'path';
import { readFile } from 'fs/promises';
import {
	messageQueries,
	sessionQueries,
	projectQueries,
	snapshotQueries
} from '../../database/queries';
import { loadMessage } from '$shared/utils/message-formatter';
import { blobStore } from '../../snapshot/blob-store';
import { snapshotService } from '../../snapshot/snapshot-service';
import { resolveSessionRoot } from '../../worktrees';
import { makeScopeKey } from '$shared/utils/workspace-scope';
import {
	buildTurnFiles,
	excerptPrompt,
	isBinaryBuffer,
	statusOf,
	summariseNetChanges
} from '../../snapshot/turn-changes';
import type { TurnFileStatus } from '../../snapshot/turn-changes';
import {
	buildCheckpointTree,
	getCheckpointPathToRoot,
	findCheckpointForHead,
	extractMessageText
} from '../../snapshot/helpers';
import type { DatabaseMessage, SessionScopedChanges } from '$shared/types/database/schema';
import { debug } from '$shared/utils/logger';
import { requireSessionAccess, requireMessageAccess } from '../access';

/**
 * Longest prompt excerpt a turn row shows. Long enough that nearly every real
 * instruction arrives whole, short enough that a chat of them stays a list.
 */
const PROMPT_EXCERPT_LENGTH = 400;

const TURN_FILE_SCHEMA = t.Object({
	path: t.String(),
	status: t.Union([t.Literal('added'), t.Literal('modified'), t.Literal('deleted')]),
	insertions: t.Number(),
	deletions: t.Number(),
	isBinary: t.Boolean(),
	contentAvailable: t.Boolean()
});

/** Parse a snapshot's stored changes, treating unreadable JSON as "no changes". */
function parseSessionChanges(raw: unknown): SessionScopedChanges {
	if (typeof raw !== 'string' || raw === '') return {};
	try {
		return JSON.parse(raw) as SessionScopedChanges;
	} catch {
		return {};
	}
}

/** Read a blob as text, or null when it is missing or not text. */
async function readTextBlob(hash: string): Promise<string | null> {
	if (!hash) return null;
	try {
		const buf = await blobStore.readBlob(hash);
		return isBinaryBuffer(buf) ? null : buf.toString('utf8');
	} catch {
		return null;
	}
}

/**
 * The checkpoints on a chat's active path, oldest first — the turns whose
 * changes are still on disk. Empty when the chat was restored to before its
 * first message.
 */
function activeCheckpoints(sessionId: string): DatabaseMessage[] {
	const allMessages = messageQueries.getAllBySessionId(sessionId);
	if (allMessages.length === 0) return [];

	const { checkpoints, parentMap } = buildCheckpointTree(allMessages);
	if (checkpoints.length === 0) return [];

	const head = sessionQueries.getHead(sessionId);
	if (!head) return [];

	const checkpointIds = new Set(checkpoints.map((cp) => cp.id));
	const activeCheckpointId = findCheckpointForHead(head, allMessages, checkpointIds);
	if (!activeCheckpointId) return [];

	const byId = new Map(checkpoints.map((cp) => [cp.id, cp]));
	return getCheckpointPathToRoot(activeCheckpointId, parentMap)
		.map((id) => byId.get(id))
		.filter((cp): cp is DatabaseMessage => cp !== undefined);
}

const NET_SCHEMA = t.Object({
	filesChanged: t.Number(),
	insertions: t.Number(),
	deletions: t.Number()
});

export const changesHandler = createRouter()
	/**
	 * Every turn of a chat, newest first, with the files it changed.
	 */
	.http('snapshot:list-turn-changes', {
		data: t.Object({
			sessionId: t.String({ minLength: 1 })
		}),
		response: t.Object({
			turns: t.Array(
				t.Object({
					checkpointMessageId: t.String(),
					/** 1-based position on the active path — what "Turn 3" means. */
					turnIndex: t.Number(),
					timestamp: t.String(),
					promptText: t.String(),
					files: t.Array(TURN_FILE_SCHEMA)
				})
			),
			/** Net over the whole active path — what the chat changed, not the sum of its turns. */
			net: NET_SCHEMA
		})
	}, async ({ data, conn }) => {
		requireSessionAccess(conn, data.sessionId);

		const activePath = activeCheckpoints(data.sessionId);
		const readBlob = (hash: string) => blobStore.readBlob(hash);

		const turns = [];
		const settled: SessionScopedChanges[] = [];
		for (let i = 0; i < activePath.length; i++) {
			const checkpoint = activePath[i];
			const snapshot = snapshotQueries.getByMessageId(checkpoint.id);
			const changes = parseSessionChanges(snapshot?.session_changes);
			settled.push(changes);
			const files = await buildTurnFiles(changes, readBlob);

			turns.push({
				checkpointMessageId: checkpoint.id,
				turnIndex: i + 1,
				timestamp: checkpoint.created_at,
				promptText: excerptPrompt(
					extractMessageText(loadMessage(checkpoint)),
					PROMPT_EXCERPT_LENGTH
				),
				files
			});
		}

		const net = await summariseNetChanges(settled, readBlob);

		// Newest first: the turn a user wants to review is almost always the last
		// one, and scrolling to reach it is a tax on the common case.
		turns.reverse();
		return { turns, net };
	})

	/**
	 * Both sides of one file's change in one turn.
	 *
	 * Replaces reading the file twice: the diff pane, the editor gutter and the
	 * revert action all need the same pair, and a single round-trip keeps them
	 * from disagreeing about which version they are looking at.
	 *
	 * Pass `messageId` for a settled turn, or `sessionId` for the turn that is
	 * still running — the running turn has no snapshot row yet, so its "before"
	 * comes from the live session baseline and its "after" from the file itself.
	 */
	.http('snapshot:read-turn-file', {
		data: t.Object({
			/** Checkpoint message id — the user message that opened the turn. */
			messageId: t.Optional(t.String({ minLength: 1 })),
			/** Session id — for the turn currently running. */
			sessionId: t.Optional(t.String({ minLength: 1 })),
			filePath: t.String()
		}),
		response: t.Object({
			/** Text before the turn; '' when the turn created the file. */
			before: t.Union([t.String(), t.Null()]),
			/** Text after the turn; '' when the turn deleted it. */
			after: t.Union([t.String(), t.Null()]),
			status: t.Union([
				t.Literal('added'),
				t.Literal('modified'),
				t.Literal('deleted'),
				t.Literal('unchanged')
			]),
			isBinary: t.Boolean()
		})
	}, async ({ data, conn }) => {
		const unchanged = { before: null, after: null, status: 'unchanged' as const, isBinary: false };

		const sessionId = data.messageId
			? requireMessageAccess(conn, data.messageId).session_id
			: data.sessionId;
		if (!sessionId) return unchanged;
		if (!data.messageId) requireSessionAccess(conn, sessionId);

		const session = sessionQueries.getById(sessionId);
		const root = resolveSessionRoot(sessionId)?.path
			|| (session ? projectQueries.getById(session.project_id)?.path : null);
		if (!root) return unchanged;

		const relativePath = (
			isAbsolute(data.filePath) ? relative(root, data.filePath) : data.filePath
		).replace(/\\/g, '/');

		if (data.messageId) {
			const snapshot = snapshotQueries.getByMessageId(data.messageId);
			const change = parseSessionChanges(snapshot?.session_changes)[relativePath];
			if (!change) return unchanged;

			const before = change.oldHash ? await readTextBlob(change.oldHash) : '';
			const after = change.newHash ? await readTextBlob(change.newHash) : '';
			// A side that exists but read back as null is binary or gone; either way
			// there is no text to diff, and saying so beats an empty pane.
			return {
				before,
				after,
				status: statusOf(change.oldHash, change.newHash),
				isBinary:
					(change.oldHash !== '' && before === null) || (change.newHash !== '' && after === null)
			};
		}

		// Running turn: the baseline is the before, and the disk is the after.
		const baseline = snapshotService.getBaselineHash(sessionId, relativePath);
		if (!baseline.known) return unchanged;

		const before = baseline.hash ? await readTextBlob(baseline.hash) : '';
		let after: string | null = null;
		let exists = true;
		try {
			const buf = await readFile(join(root, relativePath));
			after = isBinaryBuffer(buf) ? null : buf.toString('utf8');
		} catch {
			exists = false;
		}

		const status: TurnFileStatus = !baseline.hash ? 'added' : !exists ? 'deleted' : 'modified';
		return {
			before,
			after: exists ? after : '',
			status,
			isBinary: (baseline.hash !== '' && before === null) || (exists && after === null)
		};
	})

	/**
	 * Changes made so far by a turn that is still running.
	 *
	 * Returns an empty list rather than an error whenever it cannot answer — no
	 * baseline yet, nothing dirty, a session without a project — because the
	 * caller polls this while the model streams and a failure there must not
	 * become a visible error.
	 */
	.http('snapshot:get-pending-changes', {
		data: t.Object({
			sessionId: t.String({ minLength: 1 })
		}),
		response: t.Object({
			files: t.Array(TURN_FILE_SCHEMA),
			/** Net over the active path including the running turn; null when it adds nothing. */
			net: t.Union([NET_SCHEMA, t.Null()])
		})
	}, async ({ data, conn }) => {
		requireSessionAccess(conn, data.sessionId);

		const session = sessionQueries.getById(data.sessionId);
		if (!session) return { files: [], net: null };

		const root = resolveSessionRoot(data.sessionId)?.path
			|| projectQueries.getById(session.project_id)?.path;
		if (!root) return { files: [], net: null };

		try {
			const changes = await snapshotService.getPendingChanges(
				root,
				makeScopeKey(session.project_id, session.worktree_id ?? null),
				data.sessionId
			);
			if (Object.keys(changes).length === 0) return { files: [], net: null };

			const readBlob = (hash: string) => blobStore.readBlob(hash);
			const files = await buildTurnFiles(changes, readBlob);
			const settled = activeCheckpoints(data.sessionId).map((checkpoint) =>
				parseSessionChanges(snapshotQueries.getByMessageId(checkpoint.id)?.session_changes)
			);
			const net = await summariseNetChanges([...settled, changes], readBlob);
			return { files, net };
		} catch (error) {
			debug.warn('snapshot', 'Failed to read pending changes:', error);
			return { files: [], net: null };
		}
	});
