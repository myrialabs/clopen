/**
 * Files OS Clipboard Operations
 *
 * `files:copy-to-os-clipboard` — places Clopen files/folders onto the native
 * clipboard of the machine the SERVER runs on, so the user can paste them in
 * File Explorer / Finder / their Linux file manager. `effect: 'copy'`
 * (default) pastes duplicates and keeps the Clopen sources; `effect: 'move'`
 * (used for CUT) lets the file manager relocate them. The response echoes the
 * effect that was actually published — macOS cannot express "move" on the
 * pasteboard, so a CUT lands there as a copy and the UI says so. The
 * frontend's internal clipboard is untouched; this only adds the OS-native
 * side.
 *
 * `files:read-os-clipboard` — the reverse direction: reads file/folder
 * entries copied in a native file manager so the Clopen context-menu Paste
 * works even when the copy source was outside Clopen. Browsers cannot read a
 * native file-drop list on a menu click (no DataTransfer), hence this backend
 * round-trip.
 *
 * Both routes act on the clipboard of the machine the server runs on — the
 * owner's own. Published paths are canonicalised first. The backend only
 * *publishes references* — the file manager performs the actual copy, and
 * sources are never moved or deleted by Clopen.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { copyPathsToOsClipboard, readOsClipboardFilePaths } from '../../files/os-clipboard';
import { resolveFilePath } from './path-access';

export const clipboardHandler = createRouter()
	.http('files:copy-to-os-clipboard', {
		data: t.Object({
			paths: t.Array(t.String(), { minItems: 1 }),
			effect: t.Optional(t.Union([t.Literal('copy'), t.Literal('move')]))
		}),
		response: t.Object({
			count: t.Number(),
			/** The effect actually published — `copy` on macOS even for a CUT. */
			effect: t.Union([t.Literal('copy'), t.Literal('move')])
		})
	}, async ({ data }) => {
		const resolved: string[] = [];
		for (const p of data.paths) {
			resolved.push(await resolveFilePath(p));
		}
		return await copyPathsToOsClipboard(resolved, data.effect ?? 'copy');
	})
	.http('files:read-os-clipboard', {
		data: t.Object({}),
		response: t.Object({
			items: t.Array(t.Object({
				path: t.String(),
				isDirectory: t.Boolean()
			}))
		})
	}, async () => {
		return { items: await readOsClipboardFilePaths() };
	});
