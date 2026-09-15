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
 * Security: both routes act on the HOST machine's clipboard, which belongs to
 * whoever runs the server — not to a remote collaborator. A member's project
 * grants say nothing about that clipboard, and its contents are absolute
 * paths that can sit anywhere on disk (another user's project, a home
 * directory), so both routes are admin-only.
 *
 * The read route answers a non-admin with an empty list rather than an error:
 * the frontend polls it to decide whether to offer "Paste", and an empty list
 * simply means "nothing pasteable from the OS" — no error toast on every
 * context-menu open. The write route throws, because it is only ever reached
 * from an explicit Copy/Cut the caller asked for.
 *
 * Published paths still go through the standard per-user file access guard on
 * top of the admin check, so the guard stays correct if the policy is ever
 * widened. The backend only *publishes references* — the file manager
 * performs the actual copy, and sources are never moved or deleted by Clopen.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import { copyPathsToOsClipboard, readOsClipboardFilePaths } from '../../files/os-clipboard';
import { requireFilePathAccess } from './path-access';

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
	}, async ({ data, conn }) => {
		if (ws.getRole(conn) !== 'admin') {
			throw new Error('Access denied');
		}
		const resolved: string[] = [];
		for (const p of data.paths) {
			resolved.push(await requireFilePathAccess(conn, p));
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
	}, async ({ conn }) => {
		if (ws.getRole(conn) !== 'admin') {
			return { items: [] };
		}
		return { items: await readOsClipboardFilePaths() };
	});
