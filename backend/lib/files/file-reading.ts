import { join, extname } from 'path';
import { readFileWithEncoding, isTextFile } from '$shared/utils/file-type-detection';

import { debug } from '$shared/utils/logger';

// Bun-compatible readdir implementation (cross-platform)
async function readdir(path: string): Promise<string[]> {
	let proc;
	if (process.platform === 'win32') {
		proc = Bun.spawn(['cmd', '/c', 'dir', '/b', path], { stdout: 'pipe', stderr: 'ignore' });
	} else {
		proc = Bun.spawn(['ls', '-1', path], { stdout: 'pipe', stderr: 'ignore' });
	}
	const result = await new Response(proc.stdout).text();
	// Split and clean up, removing \r characters for Windows compatibility
	return result.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

// Return types
export interface FileTreeNode {
	name: string;
	type: 'file' | 'directory';
	path: string;
	size?: number;
	modified: string;
	extension?: string;
	children?: FileTreeNode[];
	error?: string;
}

// Helper function to build file tree
export async function buildFileTree(
	rootPath: string,
	maxDepth: number = 3,
	currentDepth: number = 0,
	expandedPaths?: Set<string>
): Promise<FileTreeNode | null> {
	try {
		const file = Bun.file(rootPath);
		const stats = await file.stat();
		const name = rootPath.split(/[/\\]/).pop() || 'root';

		if (stats.isFile()) {
			return {
				name,
				type: 'file',
				path: rootPath,
				size: stats.size,
				modified: stats.mtime.toISOString(),
				extension: extname(rootPath)
			};
		}

		if (stats.isDirectory()) {
			try {
				const items = await readdir(rootPath);
				const children: FileTreeNode[] = [];

				// Check if this folder should load children:
				// 1. Initial load (depth 0) - always load
				// 2. Folder is in expandedPaths - load recursively
				const shouldLoadChildren = currentDepth < 1 || (expandedPaths && expandedPaths.has(rootPath));

				if (shouldLoadChildren) {
					for (const item of items.slice(0, 100)) { // Limit to 100 items per directory
						const itemPath = join(rootPath, item);

						// Show all files and directories
						try {
							const itemFile = Bun.file(itemPath);
							const itemStats = await itemFile.stat();

							if (itemStats.isFile()) {
								children.push({
									name: item,
									type: 'file',
									path: itemPath,
									size: itemStats.size,
									modified: itemStats.mtime.toISOString(),
									extension: extname(item)
								});
							} else if (itemStats.isDirectory()) {
								// Check if this directory should be expanded
								const isExpanded = expandedPaths && expandedPaths.has(itemPath);

								if (isExpanded) {
									// Recursively load children for expanded folders
									const subTree = await buildFileTree(itemPath, maxDepth, currentDepth + 1, expandedPaths);
									if (subTree) {
										children.push(subTree);
									}
								} else {
									// For collapsed directories, just add basic info without loading children
									children.push({
										name: item,
										type: 'directory',
										path: itemPath,
										modified: itemStats.mtime.toISOString(),
										// Add empty children array to indicate it can be expanded
										children: []
									});
								}
							}
						} catch (error) {
							debug.debug('file', `Cannot access ${itemPath}:`, error);
						}
					}
				}

				// Sort children: directories first, then files
				children.sort((a, b) => {
					if (a.type !== b.type) {
						return a.type === 'directory' ? -1 : 1;
					}
					return a.name.localeCompare(b.name);
				});

				return {
					name,
					type: 'directory',
					path: rootPath,
					children,
					modified: stats.mtime.toISOString()
				};
			} catch {
				// Permission denied or other error reading directory
				return {
					name,
					type: 'directory',
					path: rootPath,
					error: 'Permission denied',
					modified: stats.mtime.toISOString()
				};
			}
		}

		return null;
	} catch (error) {
		debug.error('file', `Error building file tree for ${rootPath}:`, error);
		return null;
	}
}

// Helper function to list directory contents
export async function listDirectoryContents(dirPath: string): Promise<FileTreeNode[]> {
	// Use stat directly instead of Bun.file for directory checking
	const dirFile = Bun.file(dirPath);
	const stats = await dirFile.stat();

	if (!stats.isDirectory()) {
		throw new Error('Path is not a directory');
	}

	const items = await readdir(dirPath);
	const children: FileTreeNode[] = [];

	// Show all files and directories
	for (const item of items.slice(0, 100)) { // Limit to 100 items per directory

		const itemPath = join(dirPath, item);

		try {
			const itemFile = Bun.file(itemPath);
			const itemStats = await itemFile.stat();

			if (itemStats.isFile()) {
				children.push({
					name: item,
					type: 'file',
					path: itemPath,
					size: itemStats.size,
					modified: itemStats.mtime.toISOString(),
					extension: extname(item)
				});
			} else if (itemStats.isDirectory()) {
				children.push({
					name: item,
					type: 'directory',
					path: itemPath,
					modified: itemStats.mtime.toISOString(),
					// Add empty children array to indicate it can be expanded
					children: []
				});
			}
		} catch (error) {
			debug.debug('file', `Cannot access ${itemPath}:`, error);
		}
	}

	// Sort children: directories first, then files
	children.sort((a, b) => {
		if (a.type !== b.type) {
			return a.type === 'directory' ? -1 : 1;
		}
		return a.name.localeCompare(b.name);
	});

	return children;
}

// File content data
export interface FileContentData {
	content: string;
	size: number;
	modified: string;
	extension: string;
	encoding?: string;
	isBinary?: boolean;
	error?: string;
}

// Helper function to read file contents
export async function readFileContents(filePath: string): Promise<FileContentData> {
	const file = Bun.file(filePath);
	if (!(await file.exists())) {
		throw new Error('File does not exist');
	}

	const stats = await file.stat();

	// Check if it's a text file
	const isText = await isTextFile(filePath);

	if (!isText) {
		// Binary file
		const buffer = Buffer.from(await file.arrayBuffer());
		return {
			content: `[Binary file - ${buffer.length} bytes]`,
			size: stats.size,
			modified: stats.mtime.toISOString(),
			extension: extname(filePath),
			isBinary: true
		};
	}

	// Text file - detect encoding and read
	const { content, detectedEncoding } = await readFileWithEncoding(filePath);

	return {
		content,
		size: stats.size,
		modified: stats.mtime.toISOString(),
		extension: extname(filePath),
		encoding: detectedEncoding
	};
}

// Helper function to search files
export async function searchFiles(rootPath: string, query: string): Promise<FileTreeNode[]> {
	const results: FileTreeNode[] = [];

	async function searchRecursive(dirPath: string, depth: number = 0) {
		// Limit search depth to prevent infinite recursion
		if (depth > 5) return;

		try {
			const items = await readdir(dirPath);

			for (const item of items) {
				// Skip common directories that shouldn't be searched
				const skipDirs = ['node_modules', '.git', '.svelte-kit', 'build', 'dist', 'coverage', '.next', '.nuxt', 'target'];
				if (skipDirs.includes(item)) continue;

				const itemPath = join(dirPath, item);

				try {
					const itemFile = Bun.file(itemPath);
					const stats = await itemFile.stat();

					// Check if item name matches query (case insensitive)
					if (item.toLowerCase().includes(query.toLowerCase())) {
						results.push({
							name: item,
							type: stats.isDirectory() ? 'directory' : 'file',
							path: itemPath,
							size: stats.isFile() ? stats.size : undefined,
							modified: stats.mtime.toISOString(),
							extension: stats.isFile() ? extname(item) : undefined
						});
					}

					// Recursively search in directories
					if (stats.isDirectory()) {
						await searchRecursive(itemPath, depth + 1);
					}
				} catch (error) {
					// Skip items we can't access
					debug.debug('file', `Cannot access ${itemPath}:`, error);
				}
			}
		} catch (error) {
			debug.debug('file', `Cannot read directory ${dirPath}:`, error);
		}
	}

	await searchRecursive(rootPath);

	// Sort results: directories first, then files, both alphabetically
	results.sort((a, b) => {
		if (a.type !== b.type) {
			return a.type === 'directory' ? -1 : 1;
		}
		return a.name.localeCompare(b.name);
	});

	// Limit results to prevent overwhelming the UI
	return results.slice(0, 100);
}
