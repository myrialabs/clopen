/**
 * Tests for the note collection access rule.
 *
 * This one function decides who can read notes and who can read the image bytes
 * behind them, so both answers have to stay in step.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { initializeDatabase, closeDatabase } from '../database';
import { projectQueries } from '../database/queries/project-queries';
import { noteCollectionQueries } from '../database/queries/note-queries';
import { canAccessCollection } from './access';
import type { NoteCollection } from '$shared/types/database/schema';

let listedId: string;
let removedId: string;

function createProject(name: string): string {
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
	listedId = createProject('notes-access-listed');
	projectQueries.list(listedId);
	// Removed from the list (mode 'remove'): the record stays, access does not.
	removedId = createProject('notes-access-removed');
});

afterAll(() => {
	projectQueries.deleteProject(listedId);
	projectQueries.deleteProject(removedId);
	closeDatabase();
});

describe('canAccessCollection — project scope', () => {
	it('admits a collection of a listed project', () => {
		const collection = noteCollectionQueries.create({ name: 'P', scope: 'project', projectId: listedId });
		expect(canAccessCollection(collection)).toBe(true);
		noteCollectionQueries.delete(collection.id);
	});

	it('refuses a collection of a removed project', () => {
		const collection = noteCollectionQueries.create({ name: 'P', scope: 'project', projectId: removedId });
		expect(canAccessCollection(collection)).toBe(false);
		noteCollectionQueries.delete(collection.id);
	});

	it('refuses a project collection with no project rather than admitting it', () => {
		// The table's CHECK makes this unreachable through the queries, but a row
		// in this shape must fail closed rather than fall through to the global
		// branch.
		const malformed = {
			id: 'x',
			name: 'Malformed',
			scope: 'project',
			project_id: null,
			created_by: null,
			created_at: '',
			updated_at: ''
		} as NoteCollection;
		expect(canAccessCollection(malformed)).toBe(false);
	});
});

describe('canAccessCollection — global scope', () => {
	it('admits a global collection', () => {
		const collection = noteCollectionQueries.create({ name: 'G', scope: 'global' });
		expect(canAccessCollection(collection)).toBe(true);
		noteCollectionQueries.delete(collection.id);
	});
});
