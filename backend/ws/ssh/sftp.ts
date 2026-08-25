/**
 * ssh-client — SFTP browsing WS handlers.
 *
 * Small operations (listing, rename, chmod, text edits) travel here. Bulk file
 * bytes do not: uploads and downloads use the HTTP routes in
 * backend/http/ssh-sftp.ts, for the same reason the local file browser does —
 * a WebSocket wedges on sustained binary transfer behind the dev proxy.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { sftpService } from '../../ssh/sftp';
import { requireSshConnection } from './access';

const connectionAndPath = t.Object({
	connectionId: t.String({ minLength: 1 }),
	path: t.String()
});

/** What to do about a name the destination is already using. */
const conflictStrategy = t.Union([
	t.Literal('skip'),
	t.Literal('overwrite'),
	t.Literal('rename')
]);

export const sshSftpHandler = createRouter()
	.http('ssh:sftp-list', {
		data: connectionAndPath,
		response: t.Any()
	}, async ({ data, conn }) => {
		const connection = requireSshConnection(conn, data.connectionId);
		// An empty path means "wherever this connection starts": its configured
		// initial path, else the account's home directory.
		const path = data.path || connection.initialPath || '.';
		return sftpService.list(data.connectionId, path);
	})

	.http('ssh:sftp-stat', {
		data: connectionAndPath,
		response: t.Any()
	}, async ({ data, conn }) => {
		requireSshConnection(conn, data.connectionId);
		return sftpService.stat(data.connectionId, data.path);
	})

	.http('ssh:sftp-mkdir', {
		data: connectionAndPath,
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		requireSshConnection(conn, data.connectionId);
		await sftpService.makeDirectory(data.connectionId, data.path);
		return { ok: true };
	})

	.http('ssh:sftp-create-file', {
		data: connectionAndPath,
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		requireSshConnection(conn, data.connectionId);
		await sftpService.createFile(data.connectionId, data.path);
		return { ok: true };
	})

	.http('ssh:sftp-rename', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			fromPath: t.String({ minLength: 1 }),
			toPath: t.String({ minLength: 1 })
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		requireSshConnection(conn, data.connectionId);
		await sftpService.rename(data.connectionId, data.fromPath, data.toPath);
		return { ok: true };
	})

	.http('ssh:sftp-chmod', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			path: t.String({ minLength: 1 }),
			mode: t.Number({ minimum: 0, maximum: 0o7777 })
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		requireSshConnection(conn, data.connectionId);
		await sftpService.chmod(data.connectionId, data.path, data.mode);
		return { ok: true };
	})

	.http('ssh:sftp-delete', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			path: t.String({ minLength: 1 }),
			recursive: t.Optional(t.Boolean())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		requireSshConnection(conn, data.connectionId);
		await sftpService.remove(data.connectionId, data.path, data.recursive === true);
		return { ok: true };
	})

	.http('ssh:sftp-read', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			path: t.String({ minLength: 1 })
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		requireSshConnection(conn, data.connectionId);
		return sftpService.readText(data.connectionId, data.path);
	})

	.http('ssh:sftp-write', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			path: t.String({ minLength: 1 }),
			text: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		requireSshConnection(conn, data.connectionId);
		await sftpService.writeText(data.connectionId, data.path, data.text);
		return { ok: true };
	})

	.http('ssh:sftp-delete-many', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			paths: t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
			recursive: t.Optional(t.Boolean())
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		requireSshConnection(conn, data.connectionId);
		return sftpService.removeMany(data.connectionId, data.paths, data.recursive !== false);
	})

	.http('ssh:sftp-check-conflicts', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			paths: t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
			destinationDirectory: t.String({ minLength: 1 }),
			operation: t.Union([t.Literal('move'), t.Literal('copy')])
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		requireSshConnection(conn, data.connectionId);
		return sftpService.findConflicts(
			data.connectionId,
			data.paths,
			data.destinationDirectory,
			data.operation
		);
	})

	.http('ssh:sftp-move', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			paths: t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
			destinationDirectory: t.String({ minLength: 1 }),
			onConflict: t.Optional(conflictStrategy)
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		requireSshConnection(conn, data.connectionId);
		return sftpService.move(
			data.connectionId,
			data.paths,
			data.destinationDirectory,
			data.onConflict ?? 'skip'
		);
	})

	.http('ssh:sftp-copy', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			paths: t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
			destinationDirectory: t.String({ minLength: 1 }),
			onConflict: t.Optional(conflictStrategy)
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		requireSshConnection(conn, data.connectionId);
		return sftpService.copy(
			data.connectionId,
			data.paths,
			data.destinationDirectory,
			data.onConflict ?? 'skip'
		);
	})

	.http('ssh:sftp-compress', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			paths: t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
			archivePath: t.String({ minLength: 1 }),
			format: t.Union([t.Literal('zip'), t.Literal('tar.gz')]),
			onConflict: t.Optional(conflictStrategy)
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		requireSshConnection(conn, data.connectionId);
		return sftpService.compress(
			data.connectionId,
			data.paths,
			data.archivePath,
			data.format,
			data.onConflict ?? 'skip'
		);
	})

	.http('ssh:sftp-inspect-archive', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			archivePath: t.String({ minLength: 1 }),
			destinationDirectory: t.String({ minLength: 1 })
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		requireSshConnection(conn, data.connectionId);
		return sftpService.inspectArchive(
			data.connectionId,
			data.archivePath,
			data.destinationDirectory
		);
	})

	.http('ssh:sftp-extract', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			archivePath: t.String({ minLength: 1 }),
			destinationDirectory: t.String({ minLength: 1 }),
			mode: t.Optional(t.Union([t.Literal('smart'), t.Literal('here'), t.Literal('folder')])),
			folderName: t.Optional(t.String()),
			onConflict: t.Optional(conflictStrategy)
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		requireSshConnection(conn, data.connectionId);
		return sftpService.extract(data.connectionId, data.archivePath, data.destinationDirectory, {
			mode: data.mode ?? 'smart',
			folderName: data.folderName,
			onConflict: data.onConflict ?? 'rename'
		});
	})

	.http('ssh:sftp-disk-usage', {
		data: connectionAndPath,
		response: t.Any()
	}, async ({ data, conn }) => {
		const connection = requireSshConnection(conn, data.connectionId);
		// An empty path means "wherever this account lives". `.` resolves to the
		// home directory in the exec session, which is what `df` needs and what the
		// quota sources ignore — so the host overview can ask without knowing a path.
		const path = data.path || connection.initialPath || '.';
		return sftpService.diskUsage(data.connectionId, path);
	});
