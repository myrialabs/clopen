/**
 * Notes (this project's and the global ones) and memories from the memory
 * graph.
 *
 * A note is attached as its markdown. A memory is attached with the memories
 * it is connected to, because the one that answers the question is often
 * next to the one that was found.
 */

import type { MentionCandidate } from '$shared/types/mentions';
import type { GraphNode } from '$shared/types/memory';
import { buildContextDocument } from '$shared/utils/context-document';
import { noteCollectionQueries, noteQueries } from '$backend/database/queries/note-queries';
import { canAccessCollection } from '$backend/notes/access';
import { retrieve } from '$backend/memory/retrieval';
import { buildNodeDetail } from '$backend/memory/view';
import { graphQueries } from '$backend/database/queries';
import { ago, rank, wants } from '../shared';
import { refString, type MentionContext, type MentionSource } from '../types';

const NOTES = 'notes';
const MEMORY = 'memory';

function notesOf(ctx: MentionContext) {
	const collections = [
		...noteCollectionQueries.listByScope('project', ctx.projectId),
		...noteCollectionQueries.listByScope('global', null)
	].filter(canAccessCollection);
	const names = new Map(collections.map((collection) => [collection.id, collection]));
	return noteQueries
		.listByCollections(collections.map((collection) => collection.id))
		.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
		.map((note) => ({ note, collection: names.get(note.collection_id)! }));
}

function noteTitle(note: { title: string | null; content: string }): string {
	return note.title?.trim() || note.content.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 80) || 'Untitled note';
}

function memoryRow(node: GraphNode): MentionCandidate {
	return {
		key: `memory:${node.id}`, kind: 'memory', group: 'Memory', label: node.label,
		detail: `${node.subkind} · ${ago(node.updatedAt)}`, icon: 'lucide:brain', ref: { nodeId: node.id }
	};
}

/** Below this a memory search matches everything and nothing in particular. */
const MIN_MEMORY_QUERY = 3;

/** Opened with nothing typed: the user's standing instructions, then what was learned lately. */
function recentMemories(ctx: MentionContext, limit: number): MentionCandidate[] {
	const seen = new Set<string>();
	const nodes = [...graphQueries.standingInstructions(ctx.projectId, limit), ...graphQueries.timeline({ projectId: ctx.projectId, limit })];
	return nodes.filter((node) => !seen.has(node.id) && seen.add(node.id)).slice(0, limit).map(memoryRow);
}

function memories(ctx: MentionContext, query: string, limit: number): MentionCandidate[] {
	if (query.trim().length < MIN_MEMORY_QUERY) return [];
	const result = retrieve({ query, projectIds: [ctx.projectId], limit, expandHops: 0, precise: true });
	return result.hits.map((hit) => memoryRow(hit.node));
}

export const notesMemorySource: MentionSource = {
	kinds: ['note', 'memory'],

	categories: () => [
		{ id: NOTES, label: 'Notes', detail: 'This project’s notes and global ones', icon: 'lucide:notebook-pen', group: 'Knowledge' },
		{ id: MEMORY, label: 'Memory', detail: 'Search what past sessions learned', icon: 'lucide:brain', group: 'Knowledge' }
	],

	async list(ctx, request) {
		const noteRows = () =>
			notesOf(ctx).map(({ note, collection }): MentionCandidate => ({
				key: `note:${note.id}`, kind: 'note', group: 'Notes', label: noteTitle(note),
				detail: `${collection.name}${collection.scope === 'global' ? ' (global)' : ''} · ${ago(note.updated_at)}`,
				icon: 'lucide:notebook-pen', ref: { noteId: note.id }
			}));

		if (wants(request.category, NOTES) === 'own') return rank(noteRows(), request.query, (row) => [row.label, row.detail], request.limit);
		if (wants(request.category, MEMORY) === 'own') {
			return request.query.trim() ? memories(ctx, request.query, request.limit) : recentMemories(ctx, request.limit);
		}
		if (request.category || !request.query.trim()) return [];
		return [...rank(noteRows(), request.query, (row) => [row.label], 2), ...memories(ctx, request.query, 2)];
	},

	async capture(_ctx, kind, ref) {
		if (kind === 'note') {
			const noteId = refString(ref, 'noteId');
			const collection = noteCollectionQueries.getForNote(noteId);
			if (!collection || !canAccessCollection(collection)) throw new Error('That note is gone');
			const note = noteQueries.getById(noteId);
			if (!note) throw new Error('That note is gone');
			return {
				documents: [buildContextDocument({
					kind, label: noteTitle(note), detail: collection.name,
					facts: [['Collection', `${collection.name} (${collection.scope})`], ['Updated', note.updated_at],
						['Images', note.images.length ? note.images.map((image) => image.file_name).join(', ') : null]],
					sections: [{ title: 'Note', body: note.content }]
				})]
			};
		}

		const detail = buildNodeDetail(refString(ref, 'nodeId'), 1);
		if (!detail?.node) throw new Error('That memory is gone');
		const { node, neighbours } = detail;
		const related = neighbours
			.filter((entry) => entry.node.id !== node.id)
			.slice(0, 12)
			.map((entry) => `### ${entry.node.label} (${entry.node.subkind})\n\n${entry.node.body}`)
			.join('\n\n');
		return {
			documents: [buildContextDocument({
				kind, label: node.label, detail: node.subkind,
				facts: [['Kind', node.subkind], ['Scope', node.scope], ['Confidence', node.confidence.toFixed(2)],
					['Paths', node.relatedPaths?.length ? node.relatedPaths.join(', ') : null]],
				sections: [{ title: 'Memory', body: node.body }, ...(related ? [{ title: 'Connected memories', body: related }] : [])]
			})]
		};
	}
};
