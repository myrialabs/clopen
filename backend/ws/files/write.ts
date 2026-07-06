/**
 * Files Write Operations
 *
 * HTTP endpoints for modifying files and directories:
 * - Write file
 * - Create file
 * - Create directory
 * - Rename file/directory
 * - Duplicate file/directory
 * - Upload file
 * - Delete file/directory
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import {
	writeFileOperation,
	createFileOperation,
	createDirectoryOperation,
	renameOperation,
	duplicateOperation,
	deleteOperation
} from '../../files/file-operations';
import { createArchiveOperation, extractArchiveOperation } from '../../files/file-archive';
import { stat as fsStat, readdir as fsReaddir, rename as fsRename } from 'node:fs/promises';
import { requireFilePathAccess, requireSharedFilePathAccess } from './path-access';

export const writeHandler = createRouter()
	// Write file operation
	.http('files:write-file', {
		data: t.Object({
			filePath: t.String(),
			content: t.String(),
			// Optimistic concurrency token: the disk mtime the client's buffer is
			// based on. When present and it no longer matches disk, the write is
			// rejected instead of overwriting newer content. Omit to force-write.
			baseModified: t.Optional(t.String())
		}),
		response: t.Object({
			message: t.String(),
			size: t.Number(),
			modified: t.String()
		})
	}, async ({ data, conn }) => {
		const filePath = await requireFilePathAccess(conn, data.filePath);
		debug.log('file', 'Write file operation:', {
			filePath,
			contentLength: data.content.length
		});
		return await writeFileOperation(filePath, data.content, data.baseModified);
	})

	// Create file operation
	.http('files:create-file', {
		data: t.Object({
			filePath: t.String(),
			content: t.Optional(t.String())
		}),
		response: t.Object({
			message: t.String(),
			path: t.String(),
			size: t.Number(),
			modified: t.String()
		})
	}, async ({ data, conn }) => {
		const filePath = await requireFilePathAccess(conn, data.filePath);
		return await createFileOperation(filePath, data.content);
	})

	// Create directory operation
	.http('files:create-directory', {
		data: t.Object({
			dirPath: t.String()
		}),
		response: t.Object({
			message: t.String(),
			path: t.String(),
			modified: t.String()
		})
	}, async ({ data, conn }) => {
		// Uses the shared guard so FolderBrowser can create candidate project
		// folders outside any existing project, while still preventing writes
		// inside another user's project.
		const dirPath = await requireSharedFilePathAccess(conn, data.dirPath);
		return await createDirectoryOperation(dirPath);
	})

	// Rename operation
	.http('files:rename', {
		data: t.Object({
			oldPath: t.String(),
			newPath: t.String()
		}),
		response: t.Object({
			message: t.String(),
			oldPath: t.String(),
			newPath: t.String(),
			modified: t.String()
		})
	}, async ({ data, conn }) => {
		const oldPath = await requireFilePathAccess(conn, data.oldPath);
		const newPath = await requireFilePathAccess(conn, data.newPath);
		return await renameOperation(oldPath, newPath);
	})

	// Duplicate operation
	.http('files:duplicate', {
		data: t.Object({
			sourcePath: t.String(),
			targetPath: t.String()
		}),
		response: t.Object({
			message: t.String(),
			sourcePath: t.String(),
			targetPath: t.String(),
			size: t.Number(),
			modified: t.String()
		})
	}, async ({ data, conn }) => {
		const sourcePath = await requireFilePathAccess(conn, data.sourcePath);
		const targetPath = await requireFilePathAccess(conn, data.targetPath);
		return await duplicateOperation(sourcePath, targetPath);
	})

	// Uploads moved to the HTTP route POST /api/files/upload — the WS path
	// kept getting dropped by the Vite dev proxy with `write EPIPE` on
	// sustained binary transfers (any chunk size). See backend/http/files-upload.ts.

	// Compress operation — pack files/directories into an archive (zip/tar/7z)
	.http('files:zip', {
		data: t.Object({
			sourcePaths: t.Array(t.String()),
			targetPath: t.String(),
			format: t.Optional(t.Union([
				t.Literal('zip'),
				t.Literal('tar'),
				t.Literal('tar.gz'),
				t.Literal('tar.zst'),
				t.Literal('7z')
			])),
			method: t.Optional(t.Union([t.Literal('store'), t.Literal('deflate'), t.Literal('zstd')])),
			level: t.Optional(t.Number()),
			password: t.Optional(t.String())
		}),
		response: t.Object({
			message: t.String(),
			path: t.String(),
			size: t.Number(),
			modified: t.String()
		})
	}, async ({ data, conn }) => {
		if (data.sourcePaths.length === 0) {
			throw new Error('At least one source path is required');
		}
		const resolvedSources: string[] = [];
		for (const p of data.sourcePaths) {
			resolvedSources.push(await requireFilePathAccess(conn, p));
		}
		const resolvedTarget = await requireFilePathAccess(conn, data.targetPath);
		return await createArchiveOperation(resolvedSources, resolvedTarget, {
			format: data.format,
			method: data.method,
			level: data.level,
			password: data.password
		});
	})

	// Extract operation — extract any supported archive into a target directory
	.http('files:extract', {
		data: t.Object({
			archivePath: t.String(),
			targetDir: t.String(),
			password: t.Optional(t.String())
		}),
		response: t.Object({
			message: t.String(),
			path: t.String(),
			entries: t.Number(),
			modified: t.String()
		})
	}, async ({ data, conn }) => {
		const archivePath = await requireFilePathAccess(conn, data.archivePath);
		const targetDir = await requireFilePathAccess(conn, data.targetDir);
		return await extractArchiveOperation(archivePath, targetDir, data.password);
	})

	// Delete operation
	.http('files:delete', {
		data: t.Object({
			filePath: t.String(),
			force: t.Optional(t.Boolean())
		}),
		response: t.Object({
			message: t.String(),
			path: t.String()
		})
	}, async ({ data, conn }) => {
		const filePath = await requireFilePathAccess(conn, data.filePath);
		return await deleteOperation(filePath, data.force);
	})

	// Delete an empty directory from FolderBrowser. Restricted to:
	// - real directory (not a file)
	// - empty contents (no force, no recursive)
	// - shared guard (outside all projects, or inside the user's own project)
	.http('files:delete-directory', {
		data: t.Object({
			dirPath: t.String()
		}),
		response: t.Object({
			message: t.String(),
			path: t.String()
		})
	}, async ({ data, conn }) => {
		const dirPath = await requireSharedFilePathAccess(conn, data.dirPath);

		const stats = await fsStat(dirPath);
		if (!stats.isDirectory()) {
			throw new Error('Path is not a directory');
		}
		const entries = await fsReaddir(dirPath);
		if (entries.length > 0) {
			throw new Error('Directory is not empty');
		}

		return await deleteOperation(dirPath, false);
	})

	// Rename a directory from FolderBrowser (e.g. fix typo on a candidate
	// project folder). Restricted to real directories on both sides and
	// guarded by the shared path access policy. Uses fs.rename directly
	// because Bun.file(...).exists() returns false for directories, which
	// makes the generic renameOperation unusable here.
	.http('files:rename-directory', {
		data: t.Object({
			oldPath: t.String(),
			newPath: t.String()
		}),
		response: t.Object({
			message: t.String(),
			oldPath: t.String(),
			newPath: t.String(),
			modified: t.String()
		})
	}, async ({ data, conn }) => {
		const oldPath = await requireSharedFilePathAccess(conn, data.oldPath);
		const newPath = await requireSharedFilePathAccess(conn, data.newPath);

		let oldStats;
		try {
			oldStats = await fsStat(oldPath);
		} catch {
			throw new Error('Source path does not exist');
		}
		if (!oldStats.isDirectory()) {
			throw new Error('Source path is not a directory');
		}

		// Reject only when the destination is a genuinely different entry. On
		// case-insensitive filesystems (default on macOS and Windows) a
		// case-only rename like "Foo" -> "foo" makes the destination resolve to
		// the same inode as the source, so allow that case through.
		try {
			const newStats = await fsStat(newPath);
			const sameEntry = newStats.ino === oldStats.ino && newStats.dev === oldStats.dev;
			if (!sameEntry) {
				throw new Error('Destination path already exists');
			}
		} catch (err) {
			if (err instanceof Error && err.message === 'Destination path already exists') {
				throw err;
			}
			// fsStat threw because newPath does not exist — that is what we want.
		}

		await fsRename(oldPath, newPath);
		const newStats = await fsStat(newPath);

		return {
			message: 'Directory renamed successfully',
			oldPath,
			newPath,
			modified: newStats.mtime.toISOString()
		};
	})


