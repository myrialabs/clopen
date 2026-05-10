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
	uploadFileOperation,
	deleteOperation
} from '../../files/file-operations';
import { join } from 'node:path';
import { stat as fsStat, readdir as fsReaddir, rename as fsRename, access as fsAccess } from 'node:fs/promises';
import { requireFilePathAccess, requireSharedFilePathAccess } from './path-access';

export const writeHandler = createRouter()
	// Write file operation
	.http('files:write-file', {
		data: t.Object({
			filePath: t.String(),
			content: t.String()
		}),
		response: t.Object({
			message: t.String(),
			size: t.Number(),
			modified: t.String()
		})
	}, async ({ data, conn }) => {
		const filePath = requireFilePathAccess(conn, data.filePath);
		debug.log('file', 'Write file operation:', {
			filePath,
			contentLength: data.content.length
		});
		return await writeFileOperation(filePath, data.content);
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
		const filePath = requireFilePathAccess(conn, data.filePath);
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
		const dirPath = requireSharedFilePathAccess(conn, data.dirPath);
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
		const oldPath = requireFilePathAccess(conn, data.oldPath);
		const newPath = requireFilePathAccess(conn, data.newPath);
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
		const sourcePath = requireFilePathAccess(conn, data.sourcePath);
		const targetPath = requireFilePathAccess(conn, data.targetPath);
		return await duplicateOperation(sourcePath, targetPath);
	})

	// Upload file operation
	.http('files:upload-file', {
		data: t.Object({
			targetPath: t.String(),
			file: t.Object({
				name: t.String(),
				type: t.String(),
				size: t.Number(),
				data: t.Uint8Array()
			})
		}),
		response: t.Object({
			message: t.String(),
			path: t.String(),
			size: t.Number(),
			modified: t.String()
		})
	}, async ({ data, conn }) => {
		const targetPath = requireFilePathAccess(conn, data.targetPath);
		requireFilePathAccess(conn, join(targetPath, data.file.name));
		return await uploadFileOperation(data.file, targetPath);
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
		const filePath = requireFilePathAccess(conn, data.filePath);
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
		const dirPath = requireSharedFilePathAccess(conn, data.dirPath);

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
		const oldPath = requireSharedFilePathAccess(conn, data.oldPath);
		const newPath = requireSharedFilePathAccess(conn, data.newPath);

		let oldStats;
		try {
			oldStats = await fsStat(oldPath);
		} catch {
			throw new Error('Source path does not exist');
		}
		if (!oldStats.isDirectory()) {
			throw new Error('Source path is not a directory');
		}

		try {
			await fsAccess(newPath);
			throw new Error('Destination path already exists');
		} catch (err) {
			if (err instanceof Error && err.message === 'Destination path already exists') {
				throw err;
			}
			// fsAccess threw because newPath does not exist — that is what we want.
		}

		await fsRename(oldPath, newPath);
		const newStats = await fsStat(newPath);

		return {
			message: 'Directory renamed successfully',
			oldPath,
			newPath,
			modified: newStats.mtime.toISOString()
		};
	});
