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
} from '../../lib/files/file-operations';

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
	}, async ({ data }) => {
		debug.log('file', 'Write file operation:', {
			filePath: data.filePath,
			contentLength: data.content.length
		});
		return await writeFileOperation(data.filePath, data.content);
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
	}, async ({ data }) => {
		return await createFileOperation(data.filePath, data.content);
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
	}, async ({ data }) => {
		return await createDirectoryOperation(data.dirPath);
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
	}, async ({ data }) => {
		return await renameOperation(data.oldPath, data.newPath);
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
	}, async ({ data }) => {
		return await duplicateOperation(data.sourcePath, data.targetPath);
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
	}, async ({ data }) => {
		return await uploadFileOperation(data.file, data.targetPath);
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
	}, async ({ data }) => {
		return await deleteOperation(data.filePath, data.force);
	});
