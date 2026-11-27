/**
 * What the AI changed in this chat: one turn, or the whole chat net.
 *
 * Read from checkpoint snapshots — the same record the AI-changes panel shows
 * — so a change made by a shell command counts as much as one made by an edit
 * tool. Only turns still on the active branch are offered: a restored-away
 * turn describes nothing on disk.
 */

import type { MentionCandidate } from '$shared/types/mentions';
import type { SessionScopedChanges } from '$shared/types/database/schema';
import { buildContextDocument, type ContextSection } from '$shared/utils/context-document';
import { loadMessage } from '$shared/utils/message-formatter';
import { snapshotQueries } from '$backend/database/queries';
import { extractMessageText } from '$backend/snapshot/helpers';
import { excerptPrompt, statusOf } from '$backend/snapshot/turn-changes';
import { activeCheckpoints, parseSessionChanges, readTextBlob } from '$backend/ws/snapshot/changes';
import { unifiedDiff } from '../diff';
import { ago, rank, wants } from '../shared';
import { type MentionContext, type MentionSource } from '../types';

const CATEGORY = 'ai-changes';

interface Turn {
	checkpointId: string;
	index: number;
	prompt: string;
	at: string;
	changes: SessionScopedChanges;
}

/** How long a chat's turn list is reused: the picker asks on every keystroke. */
const TURNS_TTL_MS = 10_000;
const turnsCache = new Map<string, { at: number; turns: Turn[] }>();

/** The turns that changed something, oldest first — read once per few keystrokes. */
function turnsOf(chatSessionId: string | null): Turn[] {
	if (!chatSessionId) return [];
	const hit = turnsCache.get(chatSessionId);
	if (hit && Date.now() - hit.at < TURNS_TTL_MS) return hit.turns;
	const turns = readTurns(chatSessionId);
	turnsCache.set(chatSessionId, { at: Date.now(), turns });
	if (turnsCache.size > 50) turnsCache.delete(turnsCache.keys().next().value!);
	return turns;
}

function readTurns(chatSessionId: string): Turn[] {
	return activeCheckpoints(chatSessionId)
		.map((checkpoint, i) => ({
			checkpointId: checkpoint.id,
			index: i + 1,
			prompt: excerptPrompt(extractMessageText(loadMessage(checkpoint)).replace(/\s+/g, ' ').trim(), 120),
			at: checkpoint.created_at,
			changes: parseSessionChanges(snapshotQueries.getByMessageId(checkpoint.id)?.session_changes)
		}))
		.filter((turn) => Object.keys(turn.changes).length > 0);
}

function rows(ctx: MentionContext): MentionCandidate[] {
	const turns = turnsOf(ctx.chatSessionId);
	if (turns.length === 0) return [];
	const files = new Set(turns.flatMap((turn) => Object.keys(turn.changes)));
	return [
		{
			key: 'ai-changes:all', kind: 'ai-changes', group: 'AI changes', label: 'Everything this chat changed',
			detail: `${files.size} ${files.size === 1 ? 'file' : 'files'} over ${turns.length} ${turns.length === 1 ? 'turn' : 'turns'}`,
			icon: 'lucide:sparkles', ref: {}
		},
		...[...turns].reverse().map((turn) => {
			const count = Object.keys(turn.changes).length;
			return {
				key: `ai-changes:${turn.checkpointId}`, kind: 'ai-changes' as const, group: 'AI changes',
				label: `Turn ${turn.index}: ${turn.prompt || '(no text)'}`,
				detail: `${count} ${count === 1 ? 'file' : 'files'} · ${ago(turn.at)}`, icon: 'lucide:sparkles' as const,
				ref: { checkpointId: turn.checkpointId }
			};
		})
	];
}

export const aiChangesSource: MentionSource = {
	kinds: ['ai-changes'],

	categories(ctx) {
		const turns = turnsOf(ctx.chatSessionId);
		if (turns.length === 0) return [];
		return [{ id: CATEGORY, label: 'AI changes', detail: `${turns.length} ${turns.length === 1 ? 'turn' : 'turns'} in this chat`, icon: 'lucide:sparkles', group: 'Chats' }];
	},

	async list(ctx, request) {
		const mode = wants(request.category, CATEGORY);
		if (!mode) return [];
		const all = rows(ctx);
		if (mode === 'root') return request.query.trim() ? rank(all, request.query, (row) => [row.label, 'ai changes'], 2) : [];
		return rank(all, request.query, (row) => [row.label], request.limit);
	},

	async capture(ctx, _kind, ref) {
		// A capture reads the chat as it is now, not as it was a few seconds ago.
		const turns = ctx.chatSessionId ? readTurns(ctx.chatSessionId) : [];
		const checkpointId = typeof ref.checkpointId === 'string' ? ref.checkpointId : null;
		const chosen = checkpointId ? turns.filter((turn) => turn.checkpointId === checkpointId) : turns;
		if (chosen.length === 0) throw new Error('Those changes are no longer on this branch');

		// Net over the turns: the first "before" and the last "after" of each file.
		const net = new Map<string, { oldHash: string; newHash: string }>();
		for (const turn of chosen) {
			for (const [path, change] of Object.entries(turn.changes)) {
				const known = net.get(path);
				net.set(path, { oldHash: known ? known.oldHash : change.oldHash, newHash: change.newHash });
			}
		}

		const sections: ContextSection[] = [];
		const summary: string[] = [];
		for (const [path, change] of net) {
			if (change.oldHash === change.newHash) continue;
			const status = statusOf(change.oldHash, change.newHash);
			summary.push(`${status.padEnd(8)} ${path}`);
			const before = change.oldHash ? await readTextBlob(change.oldHash) : '';
			const after = change.newHash ? await readTextBlob(change.newHash) : '';
			if (before === null || after === null) {
				sections.push({ title: path, body: `Binary file ${status}.` });
				continue;
			}
			sections.push({ title: path, body: await unifiedDiff(path, before, after), fence: 'diff' });
		}

		const label = checkpointId ? `Turn ${chosen[0].index}: ${chosen[0].prompt || '(no text)'}` : 'Everything this chat changed';
		return {
			documents: [buildContextDocument({
				kind: 'ai-changes',
				label,
				detail: `${summary.length} ${summary.length === 1 ? 'file' : 'files'}`,
				facts: [['Turns', chosen.map((turn) => turn.index).join(', ')]],
				sections: [{ title: 'Files', body: summary.join('\n') || 'Nothing left changed.', fence: '' }, ...sections]
			})]
		};
	}
};
