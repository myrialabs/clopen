import { describe, expect, test } from 'bun:test';
import { systemNoteToEvent } from './adapter';

const note = (body: string) => ({ id: 1, body, author: { id: 1, username: 'octocat' }, created_at: '2026-01-01T00:00:00Z' });

describe('systemNoteToEvent', () => {
	test('labels, assignments and renames become events with their subject', () => {
		expect(systemNoteToEvent(note('added ~bug label'))).toMatchObject({ kind: 'labeled', subject: 'bug' });
		expect(systemNoteToEvent(note('added ~"needs review" label'))).toMatchObject({ kind: 'labeled', subject: 'needs review' });
		expect(systemNoteToEvent(note('assigned to @mona'))).toMatchObject({ kind: 'assigned', subject: 'mona' });
		expect(systemNoteToEvent(note('changed title from **old** to **New title**'))).toMatchObject({ kind: 'renamed', subject: 'New title' });
	});

	test('state changes', () => {
		expect(systemNoteToEvent(note('closed'))?.kind).toBe('closed');
		expect(systemNoteToEvent(note('reopened'))?.kind).toBe('reopened');
		expect(systemNoteToEvent(note('merged'))?.kind).toBe('merged');
	});

	test('bookkeeping notes are dropped rather than drawn vaguely', () => {
		expect(systemNoteToEvent(note('changed the description'))).toBeNull();
		expect(systemNoteToEvent(note('added 3 commits'))).toBeNull();
	});
});
