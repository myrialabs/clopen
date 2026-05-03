/**
 * Files Read Operations
 *
 * HTTP endpoints for reading files and directories:
 * - List file tree
 * - Browse path (for FolderBrowser)
 * - List directory contents
 * - Read file contents (text)
 * - Read file content (binary)
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import {
	buildFileTree,
	listDirectoryContents,
	readFileContents
} from '../../files/file-reading';
import { handlePathBrowsing } from '../../files/path-browsing';
import { gitService } from '../../git/git-service';
import { projectQueries } from '../../database/queries/project-queries';
import { isAbsolute, relative } from 'node:path';
import { requireProjectAccess } from '../access';

// Bun-compatible existsSync implementation
async function existsSync(path: string): Promise<boolean> {
	try {
		const file = Bun.file(path);
		await file.stat();
		return true;
	} catch {
		return false;
	}
}

export const readHandler = createRouter()
	// List files as file tree
	.http('files:list-tree', {
		data: t.Object({
			project_path: t.String(),
			expanded: t.Optional(t.String()) // comma-separated paths
		}),
		response: t.Recursive((Self) =>
			t.Union([
				// File node
				t.Object({
					name: t.String(),
					type: t.Literal('file'),
					path: t.String(),
					size: t.Optional(t.Number()),
					modified: t.String(),
					extension: t.Optional(t.String()),
					error: t.Optional(t.String())
				}),
				// Directory node
				t.Object({
					name: t.String(),
					type: t.Literal('directory'),
					path: t.String(),
					modified: t.String(),
					children: t.Optional(t.Array(Self)),
					error: t.Optional(t.String())
				})
			])
		)
	}, async ({ data }) => {
		if (!(await existsSync(data.project_path))) {
			throw new Error('Project path does not exist');
		}

		// Parse expanded paths parameter
		let expandedPaths: Set<string> | undefined;

		if (data.expanded) {
			// Split comma-separated paths and create Set
			const paths = data.expanded
				.split(',')
				.map((p: string) => p.trim())
				.filter(Boolean);
			expandedPaths = new Set(paths);
		}

		const fileTree = await buildFileTree(data.project_path, 3, 0, expandedPaths);
		return fileTree as any;
	})

	// Browse path (for FolderBrowser)
	.http('files:browse-path', {
		data: t.Object({
			path: t.String()
		}),
		response: t.Object({
			name: t.String(),
			type: t.Union([t.Literal('file'), t.Literal('directory'), t.Literal('drive')]),
			path: t.String(),
			modified: t.Optional(t.String()),
			size: t.Optional(t.Number()),
			extension: t.Optional(t.String()),
			children: t.Optional(
				t.Array(
					t.Object({
						name: t.String(),
						type: t.Union([t.Literal('file'), t.Literal('directory')]),
						path: t.String(),
						modified: t.Optional(t.String()),
						size: t.Optional(t.Number()),
						extension: t.Optional(t.String())
					})
				)
			),
			error: t.Optional(t.String())
		})
	}, async ({ data }) => {
		const result = await handlePathBrowsing(data.path);
		return result;
	})

	// List directory contents
	.http('files:list-directory', {
		data: t.Object({
			dir_path: t.String()
		}),
		response: t.Array(
			t.Recursive((Self) =>
				t.Object({
					name: t.String(),
					type: t.Union([t.Literal('file'), t.Literal('directory')]),
					path: t.String(),
					size: t.Optional(t.Number()),
					modified: t.String(),
					extension: t.Optional(t.String()),
					children: t.Optional(t.Array(Self))
				})
			)
		)
	}, async ({ data }) => {
		const result = await listDirectoryContents(data.dir_path);
		return result;
	})

	// Read file contents (text)
	.http('files:read-file', {
		data: t.Object({
			file_path: t.String()
		}),
		response: t.Object({
			content: t.String(),
			size: t.Number(),
			modified: t.String(),
			extension: t.String(),
			encoding: t.Optional(t.String()),
			isBinary: t.Optional(t.Boolean()),
			error: t.Optional(t.String())
		})
	}, async ({ data }) => {
		const result = await readFileContents(data.file_path);
		return result;
	})

	// Read file content at a git ref (e.g. HEAD) for diff comparison
	.http('files:read-file-at', {
		data: t.Object({
			projectId: t.String(),
			filePath: t.String(),
			ref: t.Optional(t.String())
		}),
		response: t.Object({
			content: t.Union([t.String(), t.Null()]),
			ref: t.String()
		})
	}, async ({ data, conn }) => {
		requireProjectAccess(conn, data.projectId);
		const project = projectQueries.getById(data.projectId);
		if (!project) throw new Error('Project not found');

		const ref = data.ref || 'HEAD';

		// Make filePath relative to project root for `git show`
		let relativePath = data.filePath;
		if (isAbsolute(data.filePath)) {
			relativePath = relative(project.path, data.filePath);
		}
		// Normalize path separators for git
		relativePath = relativePath.replace(/\\/g, '/');

		const content = await gitService.getFileAtRef(project.path, ref, relativePath);
		return { content, ref };
	})

	// Read file content (binary - for images, etc.) as base64
	.http('files:read-content', {
		data: t.Object({
			path: t.String()
		}),
		response: t.Object({
			content: t.String(), // Base64 encoded binary content
			contentType: t.String()
		})
	}, async ({ data }) => {
		const { path } = data;

		// Read file as binary
		const file = Bun.file(path);

		// Check if file exists
		const exists = await file.exists();
		if (!exists) {
			throw new Error('File not found');
		}

		// Get file as ArrayBuffer and convert to base64
		const arrayBuffer = await file.arrayBuffer();
		const base64 = Buffer.from(arrayBuffer).toString('base64');

		// Detect content type
		const contentType = file.type || 'application/octet-stream';

		return {
			content: base64,
			contentType
		};
	});
