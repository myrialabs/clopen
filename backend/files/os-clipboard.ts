import { stat as fsStat } from 'node:fs/promises';

import { debug } from '$shared/utils/logger';

/**
 * OS clipboard bridge for file copy (Windows).
 *
 * Clopen is a web app (Bun backend + Svelte frontend in the browser), so the
 * frontend's internal clipboard can never surface as real files in Windows
 * File Explorer — browsers have no access to the CF_HDROP clipboard format.
 * But the Bun backend runs on the same Windows machine in local usage, so it
 * can place real file/folder paths onto the OS clipboard via PowerShell
 * (`System.Windows.Forms.Clipboard` with a FileDropList). After that the user
 * opens Windows File Explorer and presses Ctrl+V — Explorer performs the
 * copy itself, so names, contents, extensions and folder structure arrive
 * intact and the sources in Clopen are never modified.
 *
 * The payload travels via an environment variable (base64 JSON) rather than
 * command-line interpolation, so paths with spaces, quotes or `&` cannot
 * break out of the PowerShell command. A COPY publish pins the drop effect
 * to DROPEFFECT_COPY (1); a CUT publish uses DROPEFFECT_MOVE (2) so Windows
 * File Explorer itself performs the move — Clopen never deletes sources.
 *
 * The reverse direction (File Explorer → Clopen) works the same way through
 * `readOsClipboardFilePaths()` below: the backend reads the native file-drop
 * list and the frontend duplicates those entries into the chosen destination
 * with COPY semantics, so Explorer sources are never moved or deleted.
 * Browsers cannot read CF_HDROP on a context-menu click (no DataTransfer),
 * which is why this backend round-trip exists — Ctrl+V from Explorer keeps
 * using the `paste` event fast path in the frontend.
 */

export const OS_CLIPBOARD_ENV_VAR = 'CLOPEN_OS_CLIP_PATHS_B64';

/**
 * OLE drop effects (OLEIDL.H): COPY = 1, MOVE = 2.
 * NOTE: these were once swapped here (COPY published as 2), which made
 * Windows File Explorer MOVE the files on paste and delete the Clopen
 * sources — even though the user did a COPY. COPY must always be 1 so the
 * sources survive the paste; only CUT publishes 2.
 */
const DROP_EFFECT_COPY = 1;
const DROP_EFFECT_MOVE = 2;

export type OsClipboardEffect = 'copy' | 'move';

/**
 * Build the PowerShell script that reads the path list from
 * `CLOPEN_OS_CLIP_PATHS_B64` and publishes it as a FileDropList with an
 * explicit drop effect (COPY by default). Exported (pure, no side effects)
 * for unit tests.
 */
export function buildOsClipboardPsScript(effect: OsClipboardEffect = 'copy'): string {
	const dropEffect = effect === 'move' ? DROP_EFFECT_MOVE : DROP_EFFECT_COPY;
	return [
		'$ErrorActionPreference = \'Stop\'',
		'Add-Type -AssemblyName System.Windows.Forms',
		`$json = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String($env:${OS_CLIPBOARD_ENV_VAR}))`,
		'$paths = $json | ConvertFrom-Json',
		'$coll = New-Object Collections.Specialized.StringCollection',
		'foreach ($p in $paths) { [void]$coll.Add([string]$p) }',
		'$data = New-Object Windows.Forms.DataObject',
		'$data.SetFileDropList($coll)',
		'$ms = New-Object IO.MemoryStream(4)',
		`$ms.Write([BitConverter]::GetBytes(${dropEffect}), 0, 4)`,
		// Rewind: the shell reads the stream from its current position, so a
		// stream left at the end would arrive as an empty/unknown effect and
		// Explorer could fall back to MOVE semantics.
		'[void]$ms.Seek(0, \'Begin\')',
		'$data.SetData(\'Preferred DropEffect\', $ms)',
		'[Windows.Forms.Clipboard]::SetDataObject($data, $true)'
	].join('\r\n');
}

/**
 * Encode absolute paths for transport via `CLOPEN_OS_CLIP_PATHS_B64`.
 * UTF-16LE matches the PowerShell `[Unicode]::GetString` decoding above.
 * Exported for unit tests.
 */
export function encodeOsClipboardPayload(paths: string[]): string {
	return Buffer.from(JSON.stringify(paths), 'utf16le').toString('base64');
}

/** Decode helper used by tests to round-trip the payload encoding. */
export function decodeOsClipboardPayload(payload: string): string[] {
	return JSON.parse(Buffer.from(payload, 'base64').toString('utf16le')) as string[];
}

/**
 * Place existing files/folders onto the Windows clipboard as a file-drop
 * list. `copy` (default) pastes duplicates and keeps the sources;
 * `move` lets Explorer relocate them (used for CUT). Resolves when Explorer
 * would now paste them. Throws on unsupported effects, non-Windows
 * platforms, missing paths, or PowerShell failures.
 */
export async function copyPathsToOsClipboard(
	paths: string[],
	effect: OsClipboardEffect = 'copy'
): Promise<{ count: number }> {
	if (effect !== 'copy' && effect !== 'move') {
		throw new Error(`Unknown clipboard effect: ${String(effect)}`);
	}
	if (process.platform !== 'win32') {
		throw new Error('Copy to OS clipboard is only supported on Windows');
	}
	if (paths.length === 0) {
		throw new Error('At least one path is required');
	}
	for (const p of paths) {
		try {
			await fsStat(p);
		} catch {
			throw new Error(`Path does not exist: ${p}`);
		}
	}

	const psPath = Bun.which('powershell.exe') ?? 'powershell.exe';
	const script = buildOsClipboardPsScript(effect);
	debug.log('file', 'Copy to OS clipboard:', { count: paths.length, effect });

	const proc = Bun.spawn([psPath, '-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, [OS_CLIPBOARD_ENV_VAR]: encodeOsClipboardPayload(paths) }
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited
	]);
	if (exitCode !== 0) {
		debug.error('file', 'Copy to OS clipboard failed:', { exitCode, stderr: stderr.trim(), stdout: stdout.trim() });
		throw new Error(stderr.trim() || 'Failed to copy to Windows clipboard');
	}
	return { count: paths.length };
}

export interface OsClipboardItem {
	path: string;
	isDirectory: boolean;
}

/** Maximum entries read from the OS clipboard in one call (abuse guard). */
const OS_CLIPBOARD_READ_LIMIT = 200;

/**
 * Split raw line-based command output into non-empty trimmed paths.
 * Pure (no side effects) for unit tests.
 */
export function parseFileDropLines(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * Parse an X11 `text/uri-list` payload (`file://` URIs, `#` comments,
 * percent-encoding) into local paths. Pure for unit tests.
 */
export function parseTextUriList(output: string): string[] {
	const out: string[] = [];
	for (const raw of output.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		let rest = line;
		if (rest.startsWith('file://')) {
			rest = rest.slice('file://'.length);
			// Strip a `host` segment (`file://host/path`); keep unix sockets
			// style `file:///path` (empty host) intact.
			if (!rest.startsWith('/') && rest.includes('/')) {
				rest = rest.slice(rest.indexOf('/'));
			}
		}
		try {
			rest = decodeURIComponent(rest);
		} catch {
			// Keep the raw form rather than dropping the entry.
		}
		if (rest) out.push(rest);
	}
	return out;
}

/**
 * Build the PowerShell script that prints the native clipboard FileDropList,
 * one absolute path per line (empty output = no files on the clipboard).
 * Exported (pure, no side effects) for unit tests. Clipboard access needs an
 * STA thread, so callers must spawn PowerShell with `-STA` (same as the
 * write path above).
 */
export function buildOsClipboardReadPsScript(): string {
	return [
		'$ErrorActionPreference = \'Stop\'',
		'Add-Type -AssemblyName System.Windows.Forms',
		'$files = [Windows.Forms.Clipboard]::GetFileDropList()',
		'if ($null -ne $files) { foreach ($f in $files) { Write-Output $f } }'
	].join('\r\n');
}

/**
 * Build the osascript program that prints Finder-copied file paths (one
 * POSIX path per line) via the AppKit pasteboard. `log` writes to stderr,
 * so callers must scan BOTH stdout and stderr. Best-effort: exact behavior
 * depends on the macOS version and what placed the files on the clipboard.
 * Exported for unit tests.
 */
export function buildMacClipboardReadScriptLines(): string[] {
	return [
		'use framework "AppKit"',
		"set pb to current application's NSPasteboard's generalPasteboard()",
		"set urls to (pb's readObjectsForClasses:{current application's NSURL} options:{current application's NSURLReadingFileURLsOnly:true})",
		'if urls is not missing value then repeat with u in urls',
		"log ((u's |path|) as text)",
		'end repeat',
		'end if'
	];
}

async function runCommand(
	cmd: string,
	args: string[],
	timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn([cmd, ...args], {
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const timer = setTimeout(() => {
		try {
			proc.kill();
		} catch {
			// Already exited.
		}
	}, timeoutMs);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited
		]);
		return { stdout, stderr, exitCode };
	} finally {
		clearTimeout(timer);
	}
}

async function statClipboardPaths(paths: string[]): Promise<OsClipboardItem[]> {
	const items: OsClipboardItem[] = [];
	for (const p of paths.slice(0, OS_CLIPBOARD_READ_LIMIT)) {
		try {
			const st = await fsStat(p);
			if (st.isFile() || st.isDirectory()) {
				items.push({ path: p, isDirectory: st.isDirectory() });
			}
		} catch {
			// Vanished between copy and paste — skip silently.
		}
	}
	return items;
}

/**
 * Read file/folder entries from the native OS clipboard (File Explorer,
 * Finder, or X11 file manager copies).
 *
 * - Windows: PowerShell FileDropList (same mechanism family as the write
 *   path; requires `-STA`).
 * - macOS: AppKit pasteboard file URLs via osascript (best-effort).
 * - Linux: X11 `text/uri-list` via xclip (best-effort; Wayland-only
 *   sessions without xclip report unsupported).
 *
 * Returns `[]` when the clipboard holds no files (text or images only).
 * Always COPY semantics downstream — callers must duplicate, never move,
 * so the file-manager sources are never modified or deleted.
 */
export async function readOsClipboardFilePaths(): Promise<OsClipboardItem[]> {
	if (process.platform === 'win32') {
		const psPath = Bun.which('powershell.exe') ?? 'powershell.exe';
		const { stdout, stderr, exitCode } = await runCommand(
			psPath,
			['-NoProfile', '-NonInteractive', '-STA', '-Command', buildOsClipboardReadPsScript()],
			15_000
		);
		if (exitCode !== 0) {
			debug.error('file', 'Read OS clipboard failed:', { exitCode, stderr: stderr.trim() });
			throw new Error(stderr.trim() || 'Failed to read the Windows clipboard');
		}
		return await statClipboardPaths(parseFileDropLines(stdout));
	}
	if (process.platform === 'darwin') {
		const osaPath = Bun.which('osascript') ?? 'osascript';
		const args: string[] = [];
		for (const line of buildMacClipboardReadScriptLines()) {
			args.push('-e', line);
		}
		try {
			const { stdout, stderr, exitCode } = await runCommand(osaPath, args, 15_000);
			if (exitCode !== 0) {
				throw new Error((stderr || stdout).trim() || 'osascript failed');
			}
			const candidates = parseFileDropLines(`${stdout}\n${stderr}`).filter((p) => p.startsWith('/'));
			return await statClipboardPaths(candidates);
		} catch (error) {
			debug.error('file', 'Read Finder clipboard failed:', error);
			throw new Error('Reading the Finder clipboard is not available on this Mac');
		}
	}
	// Linux (X11, best-effort).
	try {
		const xclip = Bun.which('xclip');
		if (!xclip) throw new Error('xclip is not installed');
		const targets = await runCommand(xclip, ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], 10_000);
		if (targets.exitCode !== 0 || !targets.stdout.includes('text/uri-list')) {
			return [];
		}
		const uris = await runCommand(xclip, ['-selection', 'clipboard', '-t', 'text/uri-list', '-o'], 10_000);
		if (uris.exitCode !== 0) return [];
		return await statClipboardPaths(parseTextUriList(uris.stdout));
	} catch (error) {
		debug.error('file', 'Read X11 clipboard failed:', error);
		throw new Error('Reading the system clipboard is not supported on this Linux session');
	}
}
