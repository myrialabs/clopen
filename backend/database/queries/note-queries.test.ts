/**
 * Tests for the note query layer.
 *
 * The scope of a note is the scope of its collection and nothing else, so the
 * cases that matter are the ones where those two could drift apart: a global
 * collection must never carry a project id, a project collection must always
 * carry one, and the cascade has to reach notes and images through it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { initializeDatabase, closeDatabase } from '../index';
import { projectQueries } from './project-queries';
import {
	noteQueries,
	noteCollectionQueries,
	noteImageQueries,
	DEFAULT_COLLECTION_NAME
} from './note-queries';

let projectId: string;
let collectionId: string;

function makeProject(name: string): string {
	return projectQueries.create({
		name,
		// `projects.path` is unique, so a fixed path collides with whatever an
		// earlier run left behind in the test data dir.
		path: `/tmp/${name}-${randomUUID()}`,
		created_at: new Date().toISOString(),
		last_opened_at: new Date().toISOString()
	}).id;
}

beforeAll(async () => {
	await initializeDatabase();
	projectId = makeProject('note-query-test');
	collectionId = noteCollectionQueries.create({
		name: 'General',
		scope: 'project',
		projectId
	}).id;
});

afterAll(() => {
	// Global collections outlive every project, so this suite cleans up its own.
	for (const c of noteCollectionQueries.listByScope('global')) noteCollectionQueries.delete(c.id);
	projectQueries.deleteProject(projectId);
	closeDatabase();
});

describe('noteCollectionQueries', () => {
	it('drops a project id handed to a global collection instead of failing the CHECK', () => {
		const global = noteCollectionQueries.create({
			name: 'Runbooks',
			scope: 'global',
			projectId
		});
		expect(global.scope).toBe('global');
		expect(global.project_id).toBeNull();
		noteCollectionQueries.delete(global.id);
	});

	it('keeps each scope’s collections out of the other’s list', () => {
		const global = noteCollectionQueries.create({ name: 'Shared', scope: 'global' });

		const projectIds = noteCollectionQueries.listByScope('project', projectId).map((c) => c.id);
		const globalIds = noteCollectionQueries.listByScope('global').map((c) => c.id);

		expect(projectIds).toContain(collectionId);
		expect(projectIds).not.toContain(global.id);
		expect(globalIds).toContain(global.id);
		expect(globalIds).not.toContain(collectionId);

		noteCollectionQueries.delete(global.id);
	});

	it('does not leak one project’s collections into another’s', () => {
		const otherId = makeProject('note-query-other');
		expect(noteCollectionQueries.listByScope('project', otherId)).toEqual([]);
		projectQueries.deleteProject(otherId);
	});

	it('resolves the collection a note belongs to, which is where its access comes from', () => {
		const note = noteQueries.create({ collectionId, content: 'body' });
		expect(noteCollectionQueries.getForNote(note.id)?.id).toBe(collectionId);
		noteQueries.delete(note.id);
	});

	it('returns null for a note that does not exist rather than a stray collection', () => {
		expect(noteCollectionQueries.getForNote('missing-note')).toBeNull();
	});

	it('creates a default collection on first use, then reuses it', () => {
		const emptyProject = makeProject('note-query-default');
		const first = noteCollectionQueries.ensureDefault('project', emptyProject, null);
		expect(first.name).toBe(DEFAULT_COLLECTION_NAME);
		expect(noteCollectionQueries.ensureDefault('project', emptyProject, null).id).toBe(first.id);
		projectQueries.deleteProject(emptyProject);
	});

	it('cascades its notes away when deleted', () => {
		const doomed = noteCollectionQueries.create({ name: 'Doomed', scope: 'project', projectId });
		const note = noteQueries.create({ collectionId: doomed.id, content: 'bye' });
		noteCollectionQueries.delete(doomed.id);
		expect(noteQueries.getRawById(note.id)).toBeNull();
	});
});

describe('noteQueries', () => {
	it('attaches each note its own images and nothing else', () => {
		const withImages = noteQueries.create({ collectionId, content: 'has images' });
		const withoutImages = noteQueries.create({ collectionId, content: 'no images' });

		for (const name of ['a.png', 'b.png']) {
			noteImageQueries.create({
				noteId: withImages.id,
				fileName: name,
				mimeType: 'image/png',
				size: 1,
				storagePath: `notes/${collectionId}/${withImages.id}/${name}`
			});
		}

		const byId = new Map(noteQueries.listByCollection(collectionId).map((n) => [n.id, n]));
		expect(byId.get(withImages.id)?.images.map((i) => i.file_name).sort()).toEqual(['a.png', 'b.png']);
		expect(byId.get(withoutImages.id)?.images).toEqual([]);

		noteQueries.delete(withImages.id);
		noteQueries.delete(withoutImages.id);
	});

	it('lists across several collections in one call', () => {
		const other = noteCollectionQueries.create({ name: 'Specs', scope: 'project', projectId });
		const a = noteQueries.create({ collectionId, content: 'a' });
		const b = noteQueries.create({ collectionId: other.id, content: 'b' });

		expect(noteQueries.listByCollections([collectionId, other.id]).map((n) => n.id).sort()).toEqual(
			[a.id, b.id].sort()
		);
		// An empty set must not turn into "every note in the database".
		expect(noteQueries.listByCollections([])).toEqual([]);

		noteCollectionQueries.delete(other.id);
		noteQueries.delete(a.id);
	});

	it('truncates oversized content on create and on update', () => {
		const note = noteQueries.create({ collectionId, content: 'x'.repeat(250_000) });
		expect(note.content.length).toBe(200_000);
		expect(noteQueries.getById(note.id)?.content.length).toBe(200_000);

		expect(noteQueries.update(note.id, { content: 'y'.repeat(250_000) })?.content.length).toBe(200_000);
		noteQueries.delete(note.id);
	});

	it('leaves untouched fields alone when the patch omits them', () => {
		const note = noteQueries.create({ collectionId, title: 'Keep me', content: 'original' });
		const updated = noteQueries.update(note.id, { content: 'replaced' });
		expect(updated?.title).toBe('Keep me');
		expect(updated?.content).toBe('replaced');
		expect(updated?.collection_id).toBe(collectionId);
		noteQueries.delete(note.id);
	});

	it('moves a note between collections, which is what changes who can read it', () => {
		const target = noteCollectionQueries.create({ name: 'Moved', scope: 'global' });
		const note = noteQueries.create({ collectionId, content: 'travelling' });

		expect(noteQueries.update(note.id, { collectionId: target.id })?.collection_id).toBe(target.id);
		expect(noteCollectionQueries.getForNote(note.id)?.scope).toBe('global');

		noteCollectionQueries.delete(target.id);
	});

	it('cascades image rows away with the note', () => {
		const note = noteQueries.create({ collectionId, content: 'doomed' });
		const image = noteImageQueries.create({
			noteId: note.id,
			fileName: 'c.png',
			mimeType: 'image/png',
			size: 3,
			storagePath: `notes/${collectionId}/${note.id}/c.png`
		});

		noteQueries.delete(note.id);
		expect(noteImageQueries.getById(image.id)).toBeNull();
	});
});
