/**
 * Tests for the note collection access rule.
 *
 * This one function decides who can read notes and who can read the image bytes
 * behind them. Both answers have to stay in step, and the global case has to
 * stay deliberate: it grants every signed-in account, so a regression that
 * quietly widened the project case into it would be invisible in the UI.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { initializeDatabase, closeDatabase } from '../database';
import { projectQueries } from '../database/queries/project-queries';
import { noteCollectionQueries } from '../database/queries/note-queries';
import { canAccessCollection } from './access';
import type { NoteCollection } from '$shared/types/database/schema';

let memberId: string;
let outsiderId: string;
let projectId: string;

beforeAll(async () => {
	await initializeDatabase();
	memberId = randomUUID();
	outsiderId = randomUUID();
	projectId = projectQueries.create({
		name: 'notes-access-test',
		// `projects.path` is unique, so a fixed path collides with whatever an
		// earlier run left behind in the test data dir.
		path: `/tmp/notes-access-test-${randomUUID()}`,
		created_at: new Date().toISOString(),
		last_opened_at: new Date().toISOString()
	}).id;
	projectQueries.addUserProject(memberId, projectId);
});

afterAll(() => {
	projectQueries.deleteProject(projectId);
	closeDatabase();
});

describe('canAccessCollection — project scope', () => {
	it('admits a member of the project', () => {
		const collection = noteCollectionQueries.create({ name: 'P', scope: 'project', projectId });
		expect(canAccessCollection(memberId, collection)).toBe(true);
		noteCollectionQueries.delete(collection.id);
	});

	it('refuses someone who is not a member', () => {
		const collection = noteCollectionQueries.create({ name: 'P', scope: 'project', projectId });
		expect(canAccessCollection(outsiderId, collection)).toBe(false);
		noteCollectionQueries.delete(collection.id);
	});

	it('refuses a project collection with no project rather than admitting everyone', () => {
		// The table's CHECK makes this unreachable through the queries, but a row
		// in this shape must fail closed rather than fall through to the global
		// branch and become readable by the whole instance.
		const malformed = {
			id: 'x',
			name: 'Malformed',
			scope: 'project',
			project_id: null,
			created_by: null,
			created_at: '',
			updated_at: ''
		} as NoteCollection;
		expect(canAccessCollection(memberId, malformed)).toBe(false);
	});
});

describe('canAccessCollection — global scope', () => {
	it('admits any signed-in user, including one in no project at all', () => {
		// Deliberate: a global collection has no per-note ACL, so everything in it
		// is readable by every account that can sign in.
		const collection = noteCollectionQueries.create({ name: 'G', scope: 'global' });
		expect(canAccessCollection(memberId, collection)).toBe(true);
		expect(canAccessCollection(outsiderId, collection)).toBe(true);
		noteCollectionQueries.delete(collection.id);
	});
});
