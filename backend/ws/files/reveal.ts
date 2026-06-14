/**
 * Files Reveal in File Manager Operation
 *
 * Opens the default file manager to reveal a file or directory, using the
 * platform-native command: `open -R` (macOS), `cmd /c start /max explorer /select,`
 * (Windows, via cmd to avoid minimized window), or `xdg-open` on the parent
 * directory (Linux).
 */

import { sep } from 'node:path';
import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { requireFilePathAccess } from './path-access';

export const revealHandler = createRouter()

	.http('files:reveal-in-file-manager', {
		data: t.Object({
			path: t.String()
		}),
		response: t.Object({
			ok: t.Boolean()
		})
	}, async ({ data, conn }) => {
		const targetPath = await requireFilePathAccess(conn, data.path);

		if (process.platform === 'darwin') {
			const proc = Bun.spawn(['open', '-R', targetPath], {
				stdout: 'ignore',
				stderr: 'pipe'
			});
			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				const stderr = proc.stderr ? (await new Response(proc.stderr).text()).trim() : '';
				throw new Error(stderr || 'Failed to reveal item in Finder');
			}
		} else if (process.platform === 'win32') {
			const winPath = targetPath.split('/').join(sep);
			Bun.spawn(['cmd', '/c', 'start', '', '/max', 'explorer', '/select,' + winPath], {
				stdout: 'ignore',
				stderr: 'ignore'
			});
		} else if (process.platform === 'linux') {
			const parentDir = targetPath.lastIndexOf('/') > 0
				? targetPath.slice(0, targetPath.lastIndexOf('/'))
				: '/';
			const proc = Bun.spawn(['xdg-open', parentDir], {
				stdout: 'ignore',
				stderr: 'pipe'
			});
			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				const stderr = proc.stderr ? (await new Response(proc.stderr).text()).trim() : '';
				throw new Error(stderr || 'Failed to open file manager');
			}
		} else {
			throw new Error('Reveal in file manager is not supported on this platform');
		}

		return { ok: true };
	});
