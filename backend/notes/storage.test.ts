/**
 * Tests for the note attachment path contract.
 *
 * The reason these exist: `note_images.storage_path` used to be an absolute
 * path, which pinned every attachment to the machine and OS that uploaded it.
 * The rules below are what make a `~/.clopen` portable between a `CLOPEN_DATA_DIR`
 * move and between platforms, so they are pinned rather than left to review.
 */

import { describe, it, expect } from 'bun:test';
import { join, isAbsolute } from 'node:path';

import {
	getNotesRootDir,
	noteImageRelPath,
	resolveNoteImagePath,
	sanitizeImageFileName
} from './storage';

describe('noteImageRelPath', () => {
	it('is relative and POSIX-separated so the row survives a move between platforms', () => {
		const rel = noteImageRelPath('coll-1', 'note-1', 'abc-photo.png');
		expect(rel).toBe('notes/coll-1/note-1/abc-photo.png');
		expect(isAbsolute(rel)).toBe(false);
		expect(rel).not.toContain('\\');
	});
});

describe('resolveNoteImagePath', () => {
	it('resolves a stored relative path under the current data dir', () => {
		const rel = noteImageRelPath('coll-1', 'note-1', 'abc-photo.png');
		expect(resolveNoteImagePath(rel)).toBe(join(getNotesRootDir(), 'coll-1', 'note-1', 'abc-photo.png'));
	});

	it('still resolves an absolute path written before the relative format', () => {
		const absolute = join(getNotesRootDir(), 'coll-1', 'note-1', 'legacy.png');
		expect(resolveNoteImagePath(absolute)).toBe(absolute);
	});

	it('refuses a path that escapes the notes root', () => {
		expect(resolveNoteImagePath('notes/../../.ssh/id_rsa')).toBeNull();
		expect(resolveNoteImagePath('../../../etc/passwd')).toBeNull();
		expect(resolveNoteImagePath('/etc/passwd')).toBeNull();
	});

	it('refuses an empty path rather than resolving to the data dir', () => {
		expect(resolveNoteImagePath('')).toBeNull();
	});
});

describe('sanitizeImageFileName', () => {
	it('keeps only characters that are legal on every platform', () => {
		expect(sanitizeImageFileName('my photo (1).png')).toBe('my_photo__1_.png');
		expect(sanitizeImageFileName('re:port|v2*.jpg')).toBe('re_port_v2_.jpg');
	});

	it('strips any directory component from both separator styles', () => {
		expect(sanitizeImageFileName('../../etc/passwd')).toBe('passwd');
		expect(sanitizeImageFileName('C:\\Users\\me\\shot.png')).toBe('shot.png');
	});

	it('drops trailing dots and spaces, which Windows removes behind our back', () => {
		// A stored `shot.png.` would leave the row pointing at a name the OS
		// never actually wrote.
		expect(sanitizeImageFileName('shot.png.')).toBe('shot.png');
		expect(sanitizeImageFileName('shot.png   ')).toBe('shot.png');
	});

	it('caps the length so the full path stays under the Windows 260-char limit', () => {
		expect(sanitizeImageFileName(`${'a'.repeat(400)}.png`).length).toBeLessThanOrEqual(64);
	});

	it('never returns an empty name', () => {
		expect(sanitizeImageFileName('')).toBe('image');
		expect(sanitizeImageFileName('...')).toBe('image');
	});
});
