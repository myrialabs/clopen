import { stat as fsStat } from 'node:fs/promises';

import { debug } from '$shared/utils/logger';

/**
 * OS clipboard bridge for file copy/cut (Windows, macOS, Linux).
 *
 * Clopen is a web app (Bun backend + Svelte frontend in the browser), so the
 * frontend's internal clipboard can never surface as real files in the native
 * file manager — browsers have no access to CF_HDROP, NSPasteboard, or the
 * X11/Wayland file-drop targets. But the Bun backend runs on the same machine
 * in local usage, so it can place real file/folder paths onto the OS
 * clipboard. After that the user opens the native file manager and pastes —
 * the file manager performs the copy itself, so names, contents, extensions
 * and folder structure arrive intact and the sources in Clopen are never
 * modified by Clopen.
 *
 * The reverse direction (file manager → Clopen) works through
 * `readOsClipboardFilePaths()` below: the backend reads the native file-drop
 * list and the frontend duplicates those entries into the chosen destination
 * with COPY semantics, so the file-manager sources are never moved or
 * deleted. Browsers cannot read a native file-drop list on a context-menu
 * click (no DataTransfer), which is why this backend round-trip exists —
 * Ctrl+V/⌘V keeps using the `paste` event fast path in the frontend.
 *
 * Both directions are HOST-MACHINE operations: they read and write the
 * clipboard of the machine the server runs on, not the viewer's. The WS
 * routes therefore restrict them to admins (see `backend/ws/files/clipboard.ts`).
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

/** Command timeout for every clipboard helper process. */
const CLIPBOARD_COMMAND_TIMEOUT_MS = 15_000;

/**
 * Whether this platform can publish file references to the native clipboard.
 * The frontend uses the thrown "not supported" error to fall back to the
 * in-app clipboard silently, so keep this in sync with the branches in
 * {@link copyPathsToOsClipboard}.
 */
export function osClipboardWriteSupported(): boolean {
	return process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux';
}

/**
 * Build the PowerShell script that reads the path list from
 * `CLOPEN_OS_CLIP_PATHS_B64` and publishes it as a FileDropList with an
 * explicit drop effect (COPY by default). The payload travels via an
 * environment variable (base64 JSON) rather than command-line interpolation,
 * so paths with spaces, quotes or `&` cannot break out of the PowerShell
 * command. Exported (pure, no side effects) for unit tests.
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
 * Build the AppleScript (ASObjC) program that publishes file URLs onto the
 * macOS general pasteboard. Paths arrive as `argv`, and Bun spawns osascript
 * without a shell, so no quoting or escaping applies to them.
 *
 * macOS has no clipboard equivalent of DROPEFFECT_MOVE: Finder decides
 * copy-vs-move at paste time (⌘V copies, ⌘⌥V moves). A CUT therefore
 * publishes the same file URLs as a COPY and the caller reports the actual
 * published effect — see {@link copyPathsToOsClipboard}.
 *
 * The URL list must be a plain AppleScript list. Collecting the URLs into an
 * `NSMutableArray` instead makes `writeObjects:` return true while placing
 * only the FIRST url on the pasteboard, so a multi-select copy silently
 * arrives in Finder as a single file.
 * Exported (pure, no side effects) for unit tests.
 */
export function buildMacClipboardWriteScriptLines(): string[] {
	return [
		'use framework "AppKit"',
		'on run argv',
		'set urls to {}',
		'repeat with p in argv',
		"set end of urls to (current application's NSURL's fileURLWithPath:(p as text))",
		'end repeat',
		"set pb to current application's NSPasteboard's generalPasteboard()",
		"pb's clearContents()",
		"pb's writeObjects:urls",
		'end run'
	];
}

/**
 * Encode a local path as a `file://` URI for the X11/Wayland clipboard
 * targets. Each segment is percent-encoded separately so separators survive.
 * Exported for unit tests.
 */
export function pathToFileUri(path: string): string {
	return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Build the `x-special/gnome-copied-files` payload understood by Nautilus,
 * Nemo, Caja and (recent) Dolphin: an action line followed by one `file://`
 * URI per line. This target is the only widely-supported way to express
 * copy-vs-cut on Linux — plain `text/uri-list` always pastes as a copy.
 * Exported (pure) for unit tests.
 */
export function buildGnomeCopiedFilesPayload(paths: string[], effect: OsClipboardEffect = 'copy'): string {
	const action = effect === 'move' ? 'cut' : 'copy';
	return [action, ...paths.map(pathToFileUri)].join('\n');
}

const GNOME_COPIED_FILES_TARGET = 'x-special/gnome-copied-files';

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

interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

interface CommandOptions {
	timeoutMs?: number;
	env?: Record<string, string>;
}

/**
 * Run a short-lived helper and collect its output. Only safe for processes
 * that exit on their own — see {@link runClipboardOwner} for the forking
 * selection-owner case.
 */
async function runCommand(cmd: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
	const proc = Bun.spawn([cmd, ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
		stdin: 'ignore',
		env: options.env ? { ...process.env, ...options.env } : undefined
	});
	const timer = setTimeout(() => {
		try {
			proc.kill();
		} catch {
			// Already exited.
		}
	}, options.timeoutMs ?? CLIPBOARD_COMMAND_TIMEOUT_MS);
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

/** Wayland sessions expose `wl-copy`/`wl-paste`; X11 sessions use `xclip`. */
function preferWayland(): boolean {
	return !!process.env.WAYLAND_DISPLAY;
}

/**
 * Run a clipboard-owning helper (`xclip` / `wl-copy`) and wait for it to hand
 * the selection off.
 *
 * These tools fork a background process that keeps serving the selection
 * until another app claims it; the process we spawn exits immediately after.
 * Their stdio must therefore be IGNORED rather than piped: the forked child
 * inherits the pipes and never closes them, so draining stdout/stderr would
 * block until the timeout even though the copy itself already succeeded.
 * That costs us the helper's error text, which is why failures fall back to a
 * generic message.
 */
async function runClipboardOwner(cmd: string, args: string[], payload: string): Promise<number> {
	const proc = Bun.spawn([cmd, ...args], {
		stdin: new TextEncoder().encode(payload),
		stdout: 'ignore',
		stderr: 'ignore'
	});
	const timer = setTimeout(() => {
		try {
			proc.kill();
		} catch {
			// Already exited.
		}
	}, CLIPBOARD_COMMAND_TIMEOUT_MS);
	try {
		return await proc.exited;
	} finally {
		clearTimeout(timer);
	}
}

async function writeLinuxClipboard(paths: string[], effect: OsClipboardEffect): Promise<void> {
	const payload = buildGnomeCopiedFilesPayload(paths, effect);
	const wlCopy = preferWayland() ? Bun.which('wl-copy') : null;
	if (wlCopy) {
		const exitCode = await runClipboardOwner(wlCopy, ['--type', GNOME_COPIED_FILES_TARGET], payload);
		if (exitCode !== 0) {
			throw new Error(`wl-copy exited with code ${exitCode}`);
		}
		return;
	}
	const xclip = Bun.which('xclip');
	if (!xclip) {
		throw new Error('Copying to the system clipboard needs xclip (X11) or wl-clipboard (Wayland)');
	}
	const exitCode = await runClipboardOwner(
		xclip,
		['-selection', 'clipboard', '-t', GNOME_COPIED_FILES_TARGET, '-i'],
		payload
	);
	if (exitCode !== 0) {
		throw new Error(`xclip exited with code ${exitCode}`);
	}
}

/**
 * Place existing files/folders onto the native clipboard as a file-drop list.
 * `copy` (default) pastes duplicates and keeps the sources; `move` lets the
 * file manager relocate them (used for CUT). Clopen itself never deletes the
 * sources — the file manager performs the move.
 *
 * Returns the effect that was ACTUALLY published, which can differ from the
 * requested one: macOS cannot express "move" on the pasteboard (Finder picks
 * copy-vs-move at paste time), so a CUT publishes as `copy` there and the
 * caller words its confirmation accordingly.
 *
 * Throws on unsupported effects, unsupported platforms, missing paths, or a
 * failing helper process.
 */
export async function copyPathsToOsClipboard(
	paths: string[],
	effect: OsClipboardEffect = 'copy'
): Promise<{ count: number; effect: OsClipboardEffect }> {
	if (effect !== 'copy' && effect !== 'move') {
		throw new Error(`Unknown clipboard effect: ${String(effect)}`);
	}
	if (!osClipboardWriteSupported()) {
		throw new Error('Copy to the system clipboard is not supported on this platform');
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

	debug.log('file', 'Copy to OS clipboard:', { count: paths.length, effect, platform: process.platform });

	if (process.platform === 'win32') {
		const psPath = Bun.which('powershell.exe') ?? 'powershell.exe';
		const { stdout, stderr, exitCode } = await runCommand(
			psPath,
			['-NoProfile', '-NonInteractive', '-STA', '-Command', buildOsClipboardPsScript(effect)],
			{ env: { [OS_CLIPBOARD_ENV_VAR]: encodeOsClipboardPayload(paths) } }
		);
		if (exitCode !== 0) {
			debug.error('file', 'Copy to OS clipboard failed:', { exitCode, stderr: stderr.trim(), stdout: stdout.trim() });
			throw new Error(stderr.trim() || 'Failed to copy to the Windows clipboard');
		}
		return { count: paths.length, effect };
	}

	if (process.platform === 'darwin') {
		const osaPath = Bun.which('osascript') ?? 'osascript';
		const args: string[] = [];
		for (const line of buildMacClipboardWriteScriptLines()) {
			args.push('-e', line);
		}
		// Paths are argv, never interpolated into the script source.
		const { stdout, stderr, exitCode } = await runCommand(osaPath, [...args, ...paths]);
		if (exitCode !== 0) {
			debug.error('file', 'Copy to Finder clipboard failed:', { exitCode, stderr: stderr.trim(), stdout: stdout.trim() });
			throw new Error(stderr.trim() || 'Failed to copy to the Finder clipboard');
		}
		// Finder decides copy-vs-move at paste time, so a CUT lands as a copy.
		return { count: paths.length, effect: 'copy' };
	}

	await writeLinuxClipboard(paths, effect);
	return { count: paths.length, effect };
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
 * Parse an X11/Wayland `text/uri-list` payload (`file://` URIs, `#` comments,
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
 * Parse an `x-special/gnome-copied-files` payload: the first line is the
 * action (`copy` / `cut`) and the rest are `file://` URIs. The action is
 * dropped on purpose — Clopen always duplicates, never moves, the
 * file-manager sources. Pure for unit tests.
 */
export function parseGnomeCopiedFiles(output: string): string[] {
	const lines = output.split(/\r?\n/);
	const first = lines[0]?.trim();
	const body = first === 'copy' || first === 'cut' ? lines.slice(1) : lines;
	return parseTextUriList(body.join('\n'));
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
 * Build the AppleScript (ASObjC) program that prints Finder-copied file paths
 * (one POSIX path per line) from the general pasteboard.
 *
 * Two things here are load-bearing and were each a runtime failure before:
 * `if … then` must open a block on its own line (a one-line
 * `if … then repeat …` is a syntax error), and the file-URL restriction has
 * to be an `isFileURL()` test rather than a `readObjectsForClasses:options:`
 * dictionary — the ASObjC bridge cannot resolve the option-key constant and
 * fails with "Can't continue". `log` writes to stderr, so callers must scan
 * BOTH stdout and stderr. Exported for unit tests.
 */
export function buildMacClipboardReadScriptLines(): string[] {
	return [
		'use framework "AppKit"',
		"set pb to current application's NSPasteboard's generalPasteboard()",
		"set urls to (pb's readObjectsForClasses:{current application's NSURL} options:(missing value))",
		'if urls is not missing value then',
		'repeat with u in urls',
		"if (u's isFileURL()) as boolean then log ((u's |path|) as text)",
		'end repeat',
		'end if'
	];
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

/** Wayland read leg: `wl-paste` with the richer GNOME target first. */
async function readWaylandClipboard(wlPaste: string): Promise<string[] | null> {
	const types = await runCommand(wlPaste, ['--list-types'], { timeoutMs: 10_000 });
	if (types.exitCode !== 0) return null;
	if (types.stdout.includes(GNOME_COPIED_FILES_TARGET)) {
		const res = await runCommand(wlPaste, ['--no-newline', '--type', GNOME_COPIED_FILES_TARGET], { timeoutMs: 10_000 });
		if (res.exitCode === 0) return parseGnomeCopiedFiles(res.stdout);
	}
	if (types.stdout.includes('text/uri-list')) {
		const res = await runCommand(wlPaste, ['--no-newline', '--type', 'text/uri-list'], { timeoutMs: 10_000 });
		if (res.exitCode === 0) return parseTextUriList(res.stdout);
	}
	return [];
}

/** X11 read leg: `xclip`, same target preference as the Wayland leg. */
async function readX11Clipboard(xclip: string): Promise<string[]> {
	const targets = await runCommand(xclip, ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], { timeoutMs: 10_000 });
	if (targets.exitCode !== 0) return [];
	if (targets.stdout.includes(GNOME_COPIED_FILES_TARGET)) {
		const res = await runCommand(xclip, ['-selection', 'clipboard', '-t', GNOME_COPIED_FILES_TARGET, '-o'], {
			timeoutMs: 10_000
		});
		if (res.exitCode === 0) return parseGnomeCopiedFiles(res.stdout);
	}
	if (targets.stdout.includes('text/uri-list')) {
		const res = await runCommand(xclip, ['-selection', 'clipboard', '-t', 'text/uri-list', '-o'], { timeoutMs: 10_000 });
		if (res.exitCode === 0) return parseTextUriList(res.stdout);
	}
	return [];
}

/**
 * Read file/folder entries from the native OS clipboard (File Explorer,
 * Finder, or a Linux file manager copy).
 *
 * - Windows: PowerShell FileDropList (same mechanism family as the write
 *   path; requires `-STA`).
 * - macOS: AppKit pasteboard file URLs via osascript.
 * - Linux: `wl-paste` on Wayland, `xclip` on X11 (best-effort; a session with
 *   neither helper installed reports unsupported).
 *
 * Returns `[]` when the clipboard holds no files (text or images only).
 * Always COPY semantics downstream — callers must duplicate, never move,
 * so the file-manager sources are never modified or deleted.
 */
export async function readOsClipboardFilePaths(): Promise<OsClipboardItem[]> {
	if (process.platform === 'win32') {
		const psPath = Bun.which('powershell.exe') ?? 'powershell.exe';
		const { stdout, stderr, exitCode } = await runCommand(psPath, [
			'-NoProfile',
			'-NonInteractive',
			'-STA',
			'-Command',
			buildOsClipboardReadPsScript()
		]);
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
			const { stdout, stderr, exitCode } = await runCommand(osaPath, args);
			if (exitCode !== 0) {
				throw new Error((stderr || stdout).trim() || 'osascript failed');
			}
			// `log` writes to stderr; a future osascript could use stdout.
			const candidates = parseFileDropLines(`${stdout}\n${stderr}`).filter((p) => p.startsWith('/'));
			return await statClipboardPaths(candidates);
		} catch (error) {
			debug.error('file', 'Read Finder clipboard failed:', error);
			throw new Error('Reading the Finder clipboard is not available on this Mac');
		}
	}

	// Linux (Wayland first, then X11 — both best-effort).
	try {
		const wlPaste = preferWayland() ? Bun.which('wl-paste') : null;
		if (wlPaste) {
			const paths = await readWaylandClipboard(wlPaste);
			if (paths !== null) return await statClipboardPaths(paths);
		}
		const xclip = Bun.which('xclip');
		if (!xclip) {
			throw new Error('Reading the system clipboard needs xclip (X11) or wl-clipboard (Wayland)');
		}
		return await statClipboardPaths(await readX11Clipboard(xclip));
	} catch (error) {
		debug.error('file', 'Read Linux clipboard failed:', error);
		throw new Error('Reading the system clipboard is not supported on this Linux session');
	}
}
