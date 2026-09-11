import { describe, expect, test } from 'bun:test';

import {
	buildGnomeCopiedFilesPayload,
	buildMacClipboardReadScriptLines,
	buildMacClipboardWriteScriptLines,
	buildOsClipboardPsScript,
	buildOsClipboardReadPsScript,
	copyPathsToOsClipboard,
	decodeOsClipboardPayload,
	encodeOsClipboardPayload,
	OS_CLIPBOARD_ENV_VAR,
	parseFileDropLines,
	parseGnomeCopiedFiles,
	parseTextUriList,
	pathToFileUri
} from './os-clipboard';

describe('os-clipboard payload encoding', () => {
	test('round-trips paths with spaces, unicode, quotes and ampersands', () => {
		const paths = [
			'C:\\Users\\Test\\Report 2026\\Attendance Log.docx',
			'C:\\Users\\Test\\Weekly Journal (1).docx',
			'C:\\Users\\Test\\a&b\'c"d;e|.txt'
		];
		expect(decodeOsClipboardPayload(encodeOsClipboardPayload(paths))).toEqual(paths);
	});

	test('round-trips folder paths', () => {
		const paths = ['C:\\Users\\Test\\Report 2026'];
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
		expect(script).not.toContain('Attendance');
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
			/At least one path|not supported on this platform/
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
				'# comment\nfile:///home/user/Report%202026\nfile://host/tmp/a&b.txt\n'
			)
		).toEqual(['/home/user/Report 2026', '/tmp/a&b.txt']);
	});

	test('read PowerShell script prints the FileDropList line by line', () => {
		const script = buildOsClipboardReadPsScript();
		expect(script).toContain('GetFileDropList');
		expect(script).toContain('Write-Output');
		expect(script).not.toContain('SetDataObject');
	});
});

describe('mac clipboard write script', () => {
	const lines = buildMacClipboardWriteScriptLines();
	const script = lines.join('\n');

	test('publishes onto the general pasteboard as a file-name list', () => {
		expect(script).toContain('NSPasteboard');
		expect(script).toContain('NSFilenamesPboardType');
		expect(script).toContain("pb's clearContents()");
	});

	test('writes the list eagerly instead of through writeObjects:', () => {
		// writeObjects: hands the pasteboard server one lazily-provided item
		// per URL. osascript exits before they are all pulled, so the entries
		// that actually land are a race — the same four paths arrived as 1, 3
		// or 4 items across identical runs, which is how a multi-select copy
		// turned into a single pasted file.
		expect(script).toContain('setPropertyList:paths');
		expect(script).toContain('declareTypes:');
		expect(script).not.toContain('writeObjects');
	});

	test('confirms the write landed before the process exits', () => {
		// An eager write is still not guaranteed to be visible to other
		// processes the instant the writer dies; reading it back is what makes
		// the result deterministic.
		expect(script).toContain('propertyListForType:');
		expect(script).toContain('repeat 50 times');
		expect(script).toContain('exit repeat');
		expect(lines).toContain('use scripting additions');
	});

	test('collects the paths in a plain AppleScript list', () => {
		expect(script).toContain('set paths to {}');
		expect(script).toContain('set end of paths to');
		expect(script).not.toContain('NSMutableArray');
	});

	test('takes paths from argv so nothing is interpolated into the script', () => {
		expect(lines).toContain('on run argv');
		expect(script).toContain('repeat with p in argv');
	});
});

describe('mac clipboard read script', () => {
	const lines = buildMacClipboardReadScriptLines();
	const script = lines.join('\n');

	test('targets pasteboard file URLs', () => {
		expect(script).toContain('NSPasteboard');
		expect(script).toContain('readObjectsForClasses');
	});

	test('opens the if as a block instead of a one-line if/then/repeat', () => {
		// `if ... then repeat ...` on one line is an AppleScript syntax error,
		// which made every Finder read fail with "not available on this Mac".
		expect(lines).toContain('if urls is not missing value then');
		expect(lines).toContain('end if');
		expect(script).not.toMatch(/then repeat/);
	});

	test('filters file URLs with isFileURL, not a reading-options dictionary', () => {
		// The ASObjC bridge cannot resolve NSURLReadingFileURLsOnly and aborts
		// with "Can't continue", so the filter has to be an explicit test.
		expect(script).toContain('isFileURL');
		expect(script).toContain('options:(missing value)');
		expect(script).not.toContain('NSURLReadingFileURLsOnly');
	});
});

describe('linux clipboard payloads', () => {
	test('pathToFileUri percent-encodes each segment and keeps separators', () => {
		expect(pathToFileUri('/home/user/Report 2026/a&b;c.txt')).toBe(
			'file:///home/user/Report%202026/a%26b%3Bc.txt'
		);
	});

	test('gnome-copied-files leads with the action line', () => {
		expect(buildGnomeCopiedFilesPayload(['/tmp/a.txt'])).toBe('copy\nfile:///tmp/a.txt');
		expect(buildGnomeCopiedFilesPayload(['/tmp/a.txt'], 'move')).toBe('cut\nfile:///tmp/a.txt');
	});

	test('round-trips through parseGnomeCopiedFiles for both actions', () => {
		const paths = ['/home/user/Report 2026', '/home/user/a&b.txt'];
		for (const effect of ['copy', 'move'] as const) {
			expect(parseGnomeCopiedFiles(buildGnomeCopiedFilesPayload(paths, effect))).toEqual(paths);
		}
	});

	test('parseGnomeCopiedFiles tolerates a payload with no action line', () => {
		expect(parseGnomeCopiedFiles('file:///tmp/a.txt\nfile:///tmp/b.txt')).toEqual([
			'/tmp/a.txt',
			'/tmp/b.txt'
		]);
	});
});
