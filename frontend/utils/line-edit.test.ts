/**
 * Line edits — discarding one change on disk and putting it back.
 *
 * The cases are the ones a byte-exact patch got wrong or would get wrong:
 * files with CRLF endings, files without a final newline, and a file that
 * moved on since the diff was read.
 */

import { describe, it, expect } from 'bun:test';

import { applyLineEdit, invertLineEdit, LineEditConflictError, type LineEdit } from './line-edit';

describe('applyLineEdit', () => {
	it('replaces a modified block and round-trips through its inverse', () => {
		const text = 'a\nb\nc\nd\n';
		const edit: LineEdit = { start: 2, remove: ['b', 'c'], insert: ['B'] };

		const discarded = applyLineEdit(text, edit);
		expect(discarded).toBe('a\nB\nd\n');
		expect(applyLineEdit(discarded, invertLineEdit(edit))).toBe(text);
	});

	it('takes out added lines and puts back deleted ones', () => {
		expect(applyLineEdit('a\nnew\nb\n', { start: 2, remove: ['new'], insert: [] })).toBe('a\nb\n');
		expect(applyLineEdit('a\nb\n', { start: 2, remove: [], insert: ['gone'] })).toBe('a\ngone\nb\n');
		expect(applyLineEdit('a\nb\n', { start: 1, remove: [], insert: ['top'] })).toBe('top\na\nb\n');
	});

	it('keeps CRLF endings on the lines it writes and leaves the rest alone', () => {
		const text = 'a\r\nb\r\nc\r\n';
		expect(applyLineEdit(text, { start: 2, remove: ['b'], insert: ['x', 'y'] })).toBe('a\r\nx\r\ny\r\nc\r\n');
		// Diff lines may arrive with or without their \r; both match.
		expect(applyLineEdit(text, { start: 2, remove: ['b\r'], insert: ['x'] })).toBe('a\r\nx\r\nc\r\n');
	});

	it('keeps a missing final newline missing', () => {
		expect(applyLineEdit('a\nb', { start: 2, remove: ['b'], insert: ['c'] })).toBe('a\nc');
		expect(applyLineEdit('a\r\nb', { start: 2, remove: ['b'], insert: ['c'] })).toBe('a\r\nc');
		expect(applyLineEdit('a\r\nb', { start: 3, remove: [], insert: ['c'] })).toBe('a\r\nb\r\nc');
	});

	it('refuses when the lines are no longer where the diff saw them', () => {
		expect(() => applyLineEdit('a\nX\nc\n', { start: 2, remove: ['b'], insert: ['B'] })).toThrow(
			LineEditConflictError
		);
		expect(() => applyLineEdit('a\n', { start: 5, remove: [], insert: ['x'] })).toThrow(LineEditConflictError);
	});
});
