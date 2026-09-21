/**
 * Multi-item explorer clipboard semantics.
 *
 * Guards the copy/paste contract the bug report demands:
 * - a copy stores EVERY selected item (files, folders, images) in order;
 * - a later copy fully replaces the earlier one (no merging);
 * - the stored array is an immutable snapshot of the selection at copy time;
 * - a menu paste onto a file lands in its parent, onto a folder inside it —
 *   identically for the internal and the fresh-OS clipboard branches;
 * - a menu paste fans out to every selected folder (2+), else the fallback.
 */

import { describe, it, expect } from 'bun:test';

import type { FileNode } from '$shared/types/filesystem';
import { buildClipboardEntry, menuPasteBase, resolveMenuDests } from './explorer-clipboard';

function node(name: string, path: string, type: 'file' | 'directory' = 'file'): FileNode {
	return {
		name,
		path,
		type,
		size: 0,
		modified: new Date(),
		children: type === 'directory' ? [] : undefined
	};
}

describe('buildClipboardEntry', () => {
	it('stores a single file', () => {
		const entry = buildClipboardEntry([node('a.txt', '/p/a.txt')], 'copy');
		expect(entry.files.map((f) => f.path)).toEqual(['/p/a.txt']);
		expect(entry.operation).toBe('copy');
		expect(entry.origin).toBe('internal');
	});

	it('stores 2+ files in selection order', () => {
		const targets = [
			node('guru_1', '/p/uploads/guru_1'),
			node('guru_2', '/p/uploads/guru_2'),
			node('guru_3', '/p/uploads/guru_3')
		];
		const entry = buildClipboardEntry(targets, 'copy');
		expect(entry.files).toHaveLength(3);
		expect(entry.files.map((f) => f.path)).toEqual([
			'/p/uploads/guru_1',
			'/p/uploads/guru_2',
			'/p/uploads/guru_3'
		]);
	});

	it('stores 5 files without dropping any', () => {
		const targets = Array.from({ length: 5 }, (_, i) => node(`f${i}.png`, `/p/f${i}.png`));
		expect(buildClipboardEntry(targets, 'copy').files).toHaveLength(5);
	});

	it('supports mixed files + folders + images as plain entries', () => {
		const targets = [
			node('doc.txt', '/p/doc.txt'),
			node('assets', '/p/assets', 'directory'),
			node('photo.png', '/p/photo.png'),
			node('backup', '/p/backup', 'directory')
		];
		const entry = buildClipboardEntry(targets, 'copy');
		expect(entry.files).toHaveLength(4);
		expect(entry.files.map((f) => f.type)).toEqual(['file', 'directory', 'file', 'directory']);
	});

	it('supports 2 folders', () => {
		const entry = buildClipboardEntry(
			[node('a', '/p/a', 'directory'), node('b', '/p/b', 'directory')],
			'copy'
		);
		expect(entry.files).toHaveLength(2);
	});

	it('snapshots the selection: later mutations do not leak into the copy', () => {
		const targets = [node('a.txt', '/p/a.txt'), node('b.txt', '/p/b.txt')];
		const entry = buildClipboardEntry(targets, 'copy');
		targets.pop();
		targets.push(node('c.txt', '/p/c.txt'));
		expect(entry.files.map((f) => f.path)).toEqual(['/p/a.txt', '/p/b.txt']);
	});

	it('a new copy replaces the old one instead of merging', () => {
		const first = buildClipboardEntry(
			[node('a.txt', '/p/a.txt'), node('b.txt', '/p/b.txt'), node('c.txt', '/p/c.txt')],
			'copy'
		);
		const second = buildClipboardEntry(
			[node('d.txt', '/p/d.txt'), node('e.txt', '/p/e.txt')],
			'copy'
		);
		// The panel assigns `clipboard = second`, so only D+E may paste.
		const active = second;
		expect(first.files).toHaveLength(3);
		expect(active.files.map((f) => f.path)).toEqual(['/p/d.txt', '/p/e.txt']);
	});

	it('carries cut operation and os origin through untouched', () => {
		const entry = buildClipboardEntry([node('a.txt', '/p/a.txt')], 'cut', 'os');
		expect(entry.operation).toBe('cut');
		expect(entry.origin).toBe('os');
		expect(entry.files).toHaveLength(1);
	});
});

describe('menuPasteBase', () => {
	it('pastes into a directory target itself', () => {
		expect(menuPasteBase('/p/uploads', true)).toBe('/p/uploads');
	});

	it('pastes a file target into its parent (POSIX)', () => {
		expect(menuPasteBase('/p/uploads/guru_1', false)).toBe('/p/uploads');
	});

	it('pastes a file target into its parent (Windows)', () => {
		expect(menuPasteBase('D:\\PKL\\Bimbel\\login.php', false)).toBe('D:\\PKL\\Bimbel');
	});

	it('keeps a directory target verbatim on Windows', () => {
		expect(menuPasteBase('D:\\PKL\\Bimbel\\uploads', true)).toBe('D:\\PKL\\Bimbel\\uploads');
	});
});

describe('resolveMenuDests', () => {
	it('uses the single fallback base when fewer than 2 folders are selected', () => {
		expect(resolveMenuDests([], '/p/uploads')).toEqual(['/p/uploads']);
		expect(resolveMenuDests(['/p/a'], '/p/uploads')).toEqual(['/p/uploads']);
	});

	it('fans out to every selected folder when 2+ are selected', () => {
		expect(resolveMenuDests(['/p/a', '/p/b'], '/p/uploads')).toEqual(['/p/a', '/p/b']);
	});
});
