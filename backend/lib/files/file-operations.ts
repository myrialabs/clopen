import { dirname, extname, join } from 'path';
import { stat as fsStat } from 'node:fs/promises';

import { debug } from '$shared/utils/logger';

// Import Bun native functions and create wrappers for better API compatibility
const { spawn } = Bun;

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

async function mkdir(path: string, options?: { recursive?: boolean }) {
	// Pure Bun approach: create directory by writing a temp file
	try {
		const tempFile = join(path, '.bun_mkdir_temp');
		await Bun.write(tempFile, '');
		// Clean up the temp file
		try {
			if (process.platform === 'win32') {
				await spawn(['cmd', '/c', 'del', '/f', '/q', tempFile.replace(/\//g, '\\')], {
					stdout: 'ignore',
					stderr: 'ignore'
				}).exited;
			} else {
				await spawn(['rm', '-f', tempFile], {
					stdout: 'ignore',
					stderr: 'ignore'
				}).exited;
			}
		} catch {
			// Ignore cleanup errors
		}
	} catch (error) {
		throw new Error(`Failed to create directory ${path}: ${error}`);
	}
}

async function copyFile(src: string, dest: string) {
	const srcFile = Bun.file(src);
	const content = await srcFile.arrayBuffer();
	await Bun.write(dest, content);
}

async function copyDirectory(src: string, dest: string) {
	// Create destination directory
	await mkdir(dest, { recursive: true });

	// List items in source
	const items = await readdir(src);

	for (const item of items) {
		const srcPath = join(src, item);
		const destPath = join(dest, item);

		const file = Bun.file(srcPath);
		try {
			const stats = await file.stat();
			if (stats.isDirectory()) {
				await copyDirectory(srcPath, destPath);
			} else {
				await copyFile(srcPath, destPath);
			}
		} catch {
			// Skip items that can't be read
			continue;
		}
	}
}

async function rename(oldPath: string, newPath: string) {
	if (process.platform === 'win32') {
		const proc = spawn(['cmd', '/c', 'move', oldPath.replace(/\//g, '\\'), newPath.replace(/\//g, '\\')], { stdout: 'ignore', stderr: 'ignore' });
		await proc.exited;
	} else {
		const proc = spawn(['mv', oldPath, newPath], { stdout: 'ignore', stderr: 'ignore' });
		await proc.exited;
	}
}

async function unlink(path: string) {
	if (process.platform === 'win32') {
		const proc = spawn(['cmd', '/c', 'del', '/f', '/q', path.replace(/\//g, '\\')], { stdout: 'ignore', stderr: 'ignore' });
		await proc.exited;
	} else {
		const proc = spawn(['rm', '-f', path], { stdout: 'ignore', stderr: 'ignore' });
		await proc.exited;
	}
}

async function rm(path: string, options?: { recursive?: boolean }) {
	if (process.platform === 'win32') {
		const proc = spawn(['cmd', '/c', 'rmdir', '/s', '/q', path.replace(/\//g, '\\')], { stdout: 'ignore', stderr: 'ignore' });
		await proc.exited;
	} else {
		const proc = spawn(['rm', '-rf', path], { stdout: 'ignore', stderr: 'ignore' });
		await proc.exited;
	}
}

async function rmdir(path: string, options?: { recursive?: boolean }) {
	return rm(path, options);
}

export async function writeFileOperation(filePath: string, content: string) {
	if (!filePath) {
		throw new Error('File path is required');
	}

	if (typeof content !== 'string') {
		throw new Error('Content must be a string');
	}

	try {
		debug.log('file', 'Writing file:', { filePath, contentLength: content.length });
		await Bun.write(filePath, content);
		const file = Bun.file(filePath);
		const stats = await file.stat();
		debug.log('file', 'File written successfully:', { size: stats.size });

		return {
			message: 'File saved successfully',
			size: stats.size,
			modified: stats.mtime.toISOString()
		};
	} catch (error) {
		debug.error('file', 'Write file error:', error);
		throw new Error(`Failed to write file: ${error}`);
	}
}

export async function createFileOperation(filePath: string, content: string = '') {
	if (!filePath) {
		throw new Error('File path is required');
	}

	try {
		// Normalize path for Windows only
		const normalizedFilePath = process.platform === 'win32' ?
			filePath.replace(/\//g, '\\') : filePath;

		// Create parent directory if it doesn't exist
		const parentDir = dirname(normalizedFilePath);
		const parentFile = Bun.file(parentDir);
		if (!(await parentFile.exists())) {
			await mkdir(parentDir, { recursive: true });
		}

		// Create empty file if it doesn't exist
		const file = Bun.file(normalizedFilePath);
		if (!(await file.exists())) {
			await Bun.write(normalizedFilePath, content);
			const stats = await file.stat();

			return {
				message: 'File created successfully',
				path: normalizedFilePath,
				size: stats.size,
				modified: stats.mtime.toISOString()
			};
		} else {
			throw new Error('File already exists');
		}
	} catch (error) {
		debug.error('file', 'Create file error:', error);
		if (error instanceof Error) {
			if (error.message === 'File already exists') {
				throw error;
			}
			if (error.message.includes('EPERM')) {
				throw new Error('Permission denied - you may not have sufficient permissions to create files in this location');
			} else if (error.message.includes('ENOENT')) {
				throw new Error('Invalid path or parent directory does not exist');
			}
			throw error;
		}
		throw new Error('Failed to create file');
	}
}

export async function createDirectoryOperation(dirPath: string) {
	if (!dirPath) {
		throw new Error('Directory path is required');
	}

	try {
		// Normalize path for Windows only
		const normalizedDirPath = process.platform === 'win32' ?
			dirPath.replace(/\//g, '\\') : dirPath;

		const dirFile = Bun.file(normalizedDirPath);
		if (!(await dirFile.exists())) {
			await mkdir(normalizedDirPath, { recursive: true });
			const stats = await dirFile.stat();

			return {
				message: 'Directory created successfully',
				path: normalizedDirPath,
				modified: stats.mtime.toISOString()
			};
		} else {
			throw new Error('Directory already exists');
		}
	} catch (error) {
		debug.error('file', 'Create directory error:', error);
		if (error instanceof Error) {
			if (error.message === 'Directory already exists') {
				throw error;
			}
			if (error.message.includes('EPERM')) {
				throw new Error('Permission denied - you may not have sufficient permissions to create directories in this location');
			} else if (error.message.includes('ENOENT')) {
				throw new Error('Invalid path or parent directory does not exist');
			}
			throw error;
		}
		throw new Error('Failed to create directory');
	}
}

export async function renameOperation(oldPath: string, newPath: string) {
	if (!oldPath || !newPath) {
		throw new Error('Both old and new paths are required');
	}

	try {
		// Normalize paths for Windows only
		const normalizedOldPath = process.platform === 'win32' ?
			oldPath.replace(/\//g, '\\') : oldPath;
		const normalizedNewPath = process.platform === 'win32' ?
			newPath.replace(/\//g, '\\') : newPath;

		const oldFile = Bun.file(normalizedOldPath);
		const newFile = Bun.file(normalizedNewPath);

		if (!(await oldFile.exists())) {
			throw new Error('Source path does not exist');
		}

		if (await newFile.exists()) {
			throw new Error('Destination path already exists');
		}

		// On Windows, add a small delay to handle file locks
		if (process.platform === 'win32') {
			await new Promise(resolve => setTimeout(resolve, 100));
		}

		await rename(normalizedOldPath, normalizedNewPath);
		const stats = await newFile.stat();

		return {
			message: 'File/directory renamed successfully',
			oldPath: normalizedOldPath,
			newPath: normalizedNewPath,
			modified: stats.mtime.toISOString()
		};
	} catch (error) {
		debug.error('file', 'Rename error:', error);
		if (error instanceof Error) {
			if (error.message === 'Source path does not exist' ||
			    error.message === 'Destination path already exists') {
				throw error;
			}
			if (error.message.includes('EPERM')) {
				throw new Error('Permission denied - file may be in use or you may not have sufficient permissions');
			} else if (error.message.includes('ENOENT')) {
				throw new Error('File or directory not found');
			} else if (error.message.includes('EEXIST')) {
				throw new Error('Destination already exists');
			}
			throw error;
		}
		throw new Error('Failed to rename');
	}
}

export async function duplicateOperation(sourcePath: string, targetPath: string) {
	if (!sourcePath || !targetPath) {
		throw new Error('Both source and target paths are required');
	}

	try {
		// Normalize paths for Windows only
		const normalizedSourcePath = process.platform === 'win32' ?
			sourcePath.replace(/\//g, '\\') : sourcePath;
		const normalizedTargetPath = process.platform === 'win32' ?
			targetPath.replace(/\//g, '\\') : targetPath;

		// Use node:fs stat to check existence (works for both files AND directories)
		let sourceStats;
		try {
			sourceStats = await fsStat(normalizedSourcePath);
		} catch {
			throw new Error('Source file does not exist');
		}

		let targetExists = false;
		try {
			await fsStat(normalizedTargetPath);
			targetExists = true;
		} catch {
			// Target doesn't exist - good
		}

		if (targetExists) {
			throw new Error('Target file already exists');
		}

		// On Windows, add a small delay to handle file locks
		if (process.platform === 'win32') {
			await new Promise(resolve => setTimeout(resolve, 100));
		}

		if (sourceStats.isFile()) {
			await copyFile(normalizedSourcePath, normalizedTargetPath);
		} else if (sourceStats.isDirectory()) {
			await copyDirectory(normalizedSourcePath, normalizedTargetPath);
		} else {
			throw new Error('Unsupported file type');
		}

		const targetStats = await fsStat(normalizedTargetPath);

		return {
			message: sourceStats.isDirectory() ? 'Folder duplicated successfully' : 'File duplicated successfully',
			sourcePath: normalizedSourcePath,
			targetPath: normalizedTargetPath,
			size: sourceStats.isDirectory() ? 0 : targetStats.size,
			modified: targetStats.mtime.toISOString()
		};
	} catch (error) {
		debug.error('file', 'Duplicate error:', error);
		if (error instanceof Error) {
			if (error.message === 'Source file does not exist' ||
			    error.message === 'Target file already exists') {
				throw error;
			}
			if (error.message.includes('EPERM')) {
				throw new Error('Permission denied - file may be in use or you may not have sufficient permissions');
			} else if (error.message.includes('ENOENT')) {
				throw new Error('File or directory not found');
			} else if (error.message.includes('EEXIST')) {
				throw new Error('Target file already exists');
			}
			throw error;
		}
		throw new Error('Failed to duplicate file');
	}
}

export async function uploadFileOperation(file: { name: string; type: string; size: number; data: Uint8Array } | any, targetPath: string) {
	if (!file || !file.name || !file.data) {
		throw new Error('File is required for upload');
	}

	if (!targetPath) {
		throw new Error('Target path is required');
	}

	try {
		// Normalize target path for Windows only
		const normalizedTargetPath = process.platform === 'win32' ?
			targetPath.replace(/\//g, '\\') : targetPath;
		const finalPath = join(normalizedTargetPath, file.name);

		// Create parent directory if it doesn't exist
		const targetDir = Bun.file(normalizedTargetPath);
		if (!(await targetDir.exists())) {
			await mkdir(normalizedTargetPath, { recursive: true });
		}

		// Check if file already exists
		const finalFile = Bun.file(finalPath);
		if (await finalFile.exists()) {
			throw new Error('File already exists');
		}

		// Write file
		await Bun.write(finalPath, file.data);
		const stats = await finalFile.stat();

		return {
			message: 'File uploaded successfully',
			path: finalPath,
			size: stats.size,
			modified: stats.mtime.toISOString()
		};
	} catch (error) {
		debug.error('file', 'Upload file error:', error);
		if (error instanceof Error) {
			if (error.message === 'File already exists') {
				throw error;
			}
			if (error.message.includes('EPERM')) {
				throw new Error('Permission denied - you may not have sufficient permissions to upload files to this location');
			} else if (error.message.includes('ENOENT')) {
				throw new Error('Target directory does not exist or is invalid');
			} else if (error.message.includes('ENOSPC')) {
				throw new Error('Not enough space on disk');
			}
			throw error;
		}
		throw new Error('Failed to upload file');
	}
}

export async function deleteOperation(filePath: string, force: boolean = false) {
	if (!filePath) {
		throw new Error('File path is required');
	}

	const file = Bun.file(filePath);
	let stats;
	try {
		stats = await file.stat();
	} catch {
		throw new Error('File or directory does not exist');
	}

	try {
		if (stats.isFile()) {
			await unlink(filePath);
			return {
				message: 'File deleted successfully',
				path: filePath
			};
		} else if (stats.isDirectory()) {
			// Check if directory is empty
			const items = await readdir(filePath);
			if (items.length > 0 && !force) {
				throw new Error('Directory is not empty. Empty the directory first or use force delete.');
			}

			if (force && items.length > 0) {
				// Use rm with recursive option for force delete
				// This is safer than manual recursion and handles edge cases better
				await rm(filePath, { recursive: true });
			} else {
				// For empty directories, use rmdir
				await rmdir(filePath);
			}

			return {
				message: 'Directory deleted successfully',
				path: filePath
			};
		} else {
			throw new Error('Path is neither a file nor directory');
		}
	} catch (error) {
		debug.error('file', 'Delete error:', error);
		if (error instanceof Error) {
			if (error.message === 'Directory is not empty. Empty the directory first or use force delete.' ||
			    error.message === 'Path is neither a file nor directory') {
				throw error;
			}
			if (error.message.includes('EPERM')) {
				throw new Error('Permission denied - the folder may be in use or protected');
			} else if (error.message.includes('ENOTEMPTY')) {
				throw new Error('Directory is not empty');
			} else if (error.message.includes('EBUSY')) {
				throw new Error('Resource is busy or locked');
			}
			throw error;
		}
		throw new Error('Failed to delete');
	}
}
