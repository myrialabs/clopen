/**
 * Files OS Clipboard Operation
 *
 * `files:copy-to-os-clipboard` — places Clopen files/folders onto the native
 * Windows clipboard (CF_HDROP FileDropList) so the user can paste them with
 * Ctrl+V in Windows File Explorer. `effect: 'copy'` (default) pastes
 * duplicates and keeps the Clopen sources; `effect: 'move'` (used for CUT)
 * lets Explorer relocate them. The frontend's internal clipboard is
 * untouched; this only adds the OS-native side.
 *
 * `files:read-os-clipboard` — the reverse direction: reads file/folder
 * entries copied in a native file manager (File Explorer / Finder) so the
 * Clopen context-menu Paste works even when the copy source was outside
 * Clopen. Browsers cannot read CF_HDROP on a menu click (no DataTransfer),
 * hence this backend round-trip. Sources may live outside any project, so
 * no per-project path guard applies here — the frontend only ever
 * *duplicates* these entries INTO a project (COPY semantics), never moves
 * or deletes the file-manager originals.
 *
 * Security: every path goes through the standard per-user file access guard,
 * so a non-admin can only publish paths inside projects they can access.
 * The backend only *publishes references* — Explorer performs the actual
 * copy, and sources are never moved or deleted.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { copyPathsToOsClipboard, readOsClipboardFilePaths } from '../../files/os-clipboard';
import { requireFilePathAccess } from './path-access';

export const clipboardHandler = createRouter()
	.http('files:copy-to-os-clipboard', {
		data: t.Object({
			paths: t.Array(t.String(), { minItems: 1 }),
			effect: t.Optional(t.Union([t.Literal('copy'), t.Literal('move')]))
		}),
		response: t.Object({
			count: t.Number()
		})
	}, async ({ data, conn }) => {
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
	}, async () => {
		return { items: await readOsClipboardFilePaths() };
	});
