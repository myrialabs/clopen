/**
 * The `@` picker's server side: every mention source, searched together, and
 * the snapshot of whatever is picked.
 *
 * Adding a source is adding it to `SOURCES` — the composer, the prompt and
 * the timeline already know what to do with whatever it captures.
 */

import type { CapturedAttachment, ContextKind, MentionCandidate, MentionRef } from '$shared/types/mentions';
import { CONTEXT_MEDIA_TYPE } from '$shared/utils/context-document';
import { MAX_ATTACHMENT_BYTES } from '$shared/constants/attachments';
import { debug } from '$shared/utils/logger';
import { bestFuzzyScore } from '$shared/utils/fuzzy';
import { filesSource } from './sources/files';
import { gitSource } from './sources/git';
import { terminalSource } from './sources/terminal';
import { previewSource } from './sources/preview';
import { chatsSource } from './sources/chats';
import { aiChangesSource } from './sources/ai-changes';
import { projectsSource } from './sources/projects';
import { notesMemorySource } from './sources/notes-memory';
import { databaseSource } from './sources/database';
import { containersSource, deploymentsSource } from './sources/ops';
import { systemSource } from './sources/system';
import { within } from './shared';
import type { MentionCategory, MentionContext, MentionSource } from './types';

export type { MentionContext, MentionCategory } from './types';

/** In the order their rows are listed. */
const SOURCES: MentionSource[] = [
	filesSource,
	gitSource,
	previewSource,
	terminalSource,
	chatsSource,
	aiChangesSource,
	projectsSource,
	notesMemorySource,
	databaseSource,
	deploymentsSource,
	containersSource,
	systemSource
];

/** How long one source may take at the root before the picker answers without it. */
const ROOT_BUDGET_MS = 1500;
/** Opening a category waits longer: that list is all the picker shows. */
const CATEGORY_BUDGET_MS = 20_000;

export interface MentionSearch {
	category?: string;
	query: string;
	limit?: number;
}

export async function searchMentions(
	ctx: MentionContext,
	search: MentionSearch
): Promise<{ items: MentionCandidate[]; categories: MentionCategory[] }> {
	const query = search.query.trim();
	const limit = Math.min(Math.max(search.limit ?? 50, 1), 200);
	const budget = search.category ? CATEGORY_BUDGET_MS : ROOT_BUDGET_MS;

	const answer = async <T>(source: MentionSource, work: () => Promise<T> | T, fallback: T): Promise<T> => {
		try {
			return await within(Promise.resolve(work()), budget, fallback);
		} catch (error) {
			debug.warn('chat', `A mention source failed (${source.kinds[0]}):`, error);
			return fallback;
		}
	};

	const lists = await Promise.all(
		SOURCES.map((source) => answer(source, () => source.list(ctx, { category: search.category, query, limit }), [] as MentionCandidate[]))
	);
	const items = lists.flat();

	if (search.category) return { items: items.slice(0, limit), categories: [] };

	const all = (await Promise.all(SOURCES.map((source) => answer(source, () => source.categories(ctx), [] as MentionCategory[])))).flat();
	const categories = query
		? all.filter((category) => bestFuzzyScore(query, [category.label, category.detail]) > 0)
		: all;
	return { items, categories };
}

/** Take the snapshot of what was picked: its documents, then its pictures. */
export async function captureMention(ctx: MentionContext, kind: ContextKind, ref: MentionRef): Promise<CapturedAttachment[]> {
	const source = SOURCES.find((entry) => entry.kinds.includes(kind));
	if (!source) throw new Error(`Nothing can be mentioned as ${kind}`);
	const captured = await source.capture(ctx, kind, ref);
	return [
		...captured.documents.map((document) => ({
			fileName: document.fileName,
			mediaType: CONTEXT_MEDIA_TYPE,
			data: withinLimit(document.text).toString('base64')
		})),
		...(captured.images ?? [])
	];
}

/** The document's bytes, cut to what an attachment may hold — the header always survives. */
function withinLimit(text: string): Buffer {
	const bytes = Buffer.from(text, 'utf8');
	if (bytes.length <= MAX_ATTACHMENT_BYTES) return bytes;
	const note = Buffer.from(`\n\n… cut here: the snapshot was larger than ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB.\n`, 'utf8');
	return Buffer.concat([bytes.subarray(0, MAX_ATTACHMENT_BYTES - note.length), note]);
}
