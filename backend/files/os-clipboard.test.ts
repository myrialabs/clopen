import { describe, expect, test } from 'bun:test';

import {
	buildMacClipboardReadScriptLines,
	buildOsClipboardPsScript,
	buildOsClipboardReadPsScript,
	copyPathsToOsClipboard,
	decodeOsClipboardPayload,
	encodeOsClipboardPayload,
	OS_CLIPBOARD_ENV_VAR,
	parseFileDropLines,
	parseTextUriList
} from './os-clipboard';

describe('os-clipboard payload encoding', () => {
	test('round-trips paths with spaces, unicode, quotes and ampersands', () => {
		const paths = [
			'C:\\Users\\Test\\Laporan PKL\\ABSENSI KEGIATAN.docx',
			'C:\\Users\\Test\\Jurnal Mingguan (1).docx',
			'C:\\Users\\Test\\a&b\'c"d;e|.txt'
		];
		expect(decodeOsClipboardPayload(encodeOsClipboardPayload(paths))).toEqual(paths);
	});

	test('round-trips folder paths', () => {
		const paths = ['C:\\Users\\Test\\Laporan PKL'];
		expect(decodeOsClipboardPayload(encodeOsClipboardPayload(paths))).toEqual(paths);
	});
});

describe('os-clipboard PowerShell script', () => {
	test('publishes a FileDropList with explicit COPY effect', () => {
		const script = buildOsClipboardPsScript();
		expect(script).toContain('System.Windows.Forms');
		expect(script).toContain('SetFileDropList');
		expect(script).toContain('Preferred DropEffect');
		expect(script).toContain('SetDataObject');
		// DROPEFFECT_COPY (1) — never MOVE, so COPY sources are never deleted.
		expect(script).toContain('GetBytes(1)');
		expect(script).not.toContain('GetBytes(2)');
		expect(script).toContain(OS_CLIPBOARD_ENV_VAR);
	});

	test('publishes DROPEFFECT_MOVE for cut so Explorer moves the sources', () => {
		const script = buildOsClipboardPsScript('move');
		expect(script).toContain('SetFileDropList');
		expect(script).toContain('Preferred DropEffect');
		// DROPEFFECT_MOVE (2) — only CUT publishes this; Explorer itself
		// performs the move, Clopen never deletes the sources.
		expect(script).toContain('GetBytes(2)');
		expect(script).not.toContain('GetBytes(1)');
	});

	test('never interpolates paths (injection-safe transport via env var)', () => {
		const script = buildOsClipboardPsScript();
		expect(script).not.toContain('ABSENSI');
		expect(script).not.toContain('C:\\');
	});
});

describe('copyPathsToOsClipboard validation', () => {
	test('rejects an unknown effect', async () => {
		await expect(
			// @ts-expect-error runtime guard must reject invalid effects
			copyPathsToOsClipboard(['C:\\tmp\\a.txt'], 'delete')
		).rejects.toThrow(/Unknown clipboard effect/);
	});

	test('rejects an empty path list', async () => {
		await expect(copyPathsToOsClipboard([])).rejects.toThrow(
			/At least one path|only supported on Windows/
		);
	});

	test('rejects non-existent paths on Windows', async () => {
		if (process.platform !== 'win32') return;
		await expect(
			copyPathsToOsClipboard(['C:\\definitely\\not\\here\\missing.docx'])
		).rejects.toThrow(/does not exist/);
	});
});

describe('os-clipboard read helpers', () => {
	test('parseFileDropLines splits CRLF/LF output and drops blanks', () => {
		expect(
			parseFileDropLines('C:\\A\\f.txt\r\nD:\\B Folder\\\r\n\r\n  \nC:\\C.docx\n')
		).toEqual(['C:\\A\\f.txt', 'D:\\B Folder\\', 'C:\\C.docx']);
	});

	test('parseFileDropLines returns [] for empty clipboard output', () => {
		expect(parseFileDropLines('')).toEqual([]);
		expect(parseFileDropLines('\r\n  \r\n')).toEqual([]);
	});

	test('parseTextUriList decodes file URIs and skips comments', () => {
		expect(
			parseTextUriList(
				'# comment\nfile:///home/user/Laporan%20PKL\nfile://host/tmp/a&b.txt\n'
			)
		).toEqual(['/home/user/Laporan PKL', '/tmp/a&b.txt']);
	});

	test('read PowerShell script prints the FileDropList line by line', () => {
		const script = buildOsClipboardReadPsScript();
		expect(script).toContain('GetFileDropList');
		expect(script).toContain('Write-Output');
		expect(script).not.toContain('SetDataObject');
	});

	test('mac read script targets pasteboard file URLs', () => {
		const lines = buildMacClipboardReadScriptLines();
		expect(lines.join('\n')).toContain('NSPasteboard');
		expect(lines.join('\n')).toContain('NSURLReadingFileURLsOnly');
	});
});
