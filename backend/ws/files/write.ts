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
import { requireFilePathAccess } from './path-access';

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
		const dirPath = requireFilePathAccess(conn, data.dirPath);
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
	});
