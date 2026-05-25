import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { zipSync, Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';

import { debug } from '$shared/utils/logger';
import { getMaxFileSize, validateFileSize } from './file-size-limit';

interface ZipTree {
	[path: string]: Uint8Array | ZipTree;
}

function setInTree(tree: ZipTree, parts: string[], value: Uint8Array | ZipTree): void {
	if (parts.length === 0) return;
	if (parts.length === 1) {
		tree[parts[0]] = value;
		return;
	}
	const head = parts[0];
	const existing = tree[head];
	const child: ZipTree = existing && !(existing instanceof Uint8Array)
		? (existing as ZipTree)
		: {};
	tree[head] = child;
	setInTree(child, parts.slice(1), value);
}

async function readPathIntoTree(sourcePath: string, rootName: string, tree: ZipTree): Promise<void> {
	const stats = await stat(sourcePath);
	if (stats.isFile()) {
		const data = new Uint8Array(await Bun.file(sourcePath).arrayBuffer());
		setInTree(tree, rootName.split('/'), data);
		return;
	}
	if (stats.isDirectory()) {
		const entries = await readdir(sourcePath);
		if (entries.length === 0) {
			setInTree(tree, rootName.split('/'), {} as ZipTree);
			return;
		}
		for (const entry of entries) {
			await readPathIntoTree(
				join(sourcePath, entry),
				`${rootName}/${entry}`,
				tree
			);
		}
	}
}

export async function createZipOperation(sourcePaths: string[], targetZipPath: string): Promise<{ message: string; path: string; size: number; modified: string }> {
	if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
		throw new Error('At least one source path is required');
	}
	if (!targetZipPath) {
		throw new Error('Target zip path is required');
	}

	try {
		const targetFile = Bun.file(targetZipPath);
		if (await targetFile.exists()) {
			throw new Error('Target archive already exists');
		}

		const tree: ZipTree = {};

		for (const source of sourcePaths) {
			const name = basename(source);
			if (!name || name === '.' || name === '..') {
				throw new Error(`Invalid source path: ${source}`);
			}
			await readPathIntoTree(source, name, tree);
		}

		const zipped = zipSync(tree as Record<string, Uint8Array>, { level: 6 });
		validateFileSize(zipped.byteLength);
		await Bun.write(targetZipPath, zipped);
		const stats = await stat(targetZipPath);

		return {
			message: 'Archive created successfully',
			path: targetZipPath,
			size: stats.size,
			modified: stats.mtime.toISOString()
		};
	} catch (error) {
		debug.error('file', 'Create zip error:', error);
		if (error instanceof Error) {
			if (error.message.includes('EPERM')) {
				throw new Error('Permission denied while creating archive');
			}
			if (error.message.includes('ENOSPC')) {
				throw new Error('Not enough space on disk');
			}
			throw error;
		}
		throw new Error('Failed to create archive');
	}
}

function isSafeEntryPath(entryPath: string, targetRoot: string): boolean {
	if (!entryPath) return false;
	if (isAbsolute(entryPath)) return false;
	const normalized = entryPath.replace(/\\/g, '/');
	if (normalized.split('/').some((segment) => segment === '..')) return false;
	const full = join(targetRoot, normalized);
	const rel = relative(targetRoot, full);
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export async function extractZipOperation(archivePath: string, targetDir: string): Promise<{ message: string; path: string; entries: number; modified: string }> {
	if (!archivePath) {
		throw new Error('Archive path is required');
	}
	if (!targetDir) {
		throw new Error('Target directory is required');
	}

	const archiveFile = Bun.file(archivePath);
	if (!(await archiveFile.exists())) {
		throw new Error('Archive does not exist');
	}

	const limit = getMaxFileSize();
	const limitMB = Math.floor(limit / (1024 * 1024));
	const stats = await stat(archivePath);
	if (stats.size > limit) {
		throw new Error(`Archive exceeds maximum allowed size of ${limitMB}MB`);
	}

	try {
		const targetExists = await Bun.file(targetDir).exists();
		if (targetExists) {
			const targetStats = await stat(targetDir);
			if (!targetStats.isDirectory()) {
				throw new Error('Target path exists and is not a directory');
			}
		} else {
			await mkdir(targetDir, { recursive: true });
		}

		const data = new Uint8Array(await archiveFile.arrayBuffer());
		const entryCount = await extractWithinLimit(data, targetDir, limit, limitMB);

		const targetStats = await stat(targetDir);
		return {
			message: 'Archive extracted successfully',
			path: targetDir,
			entries: entryCount,
			modified: targetStats.mtime.toISOString()
		};
	} catch (error) {
		debug.error('file', 'Extract zip error:', error);
		if (error instanceof Error) {
			if (error.message.includes('EPERM')) {
				throw new Error('Permission denied while extracting archive');
			}
			if (error.message.includes('ENOSPC')) {
				throw new Error('Not enough space on disk');
			}
			throw error;
		}
		throw new Error('Failed to extract archive');
	}
}

const STREAM_CHUNK_SIZE = 64 * 1024;

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let pos = 0;
	for (const chunk of chunks) {
		out.set(chunk, pos);
		pos += chunk.length;
	}
	return out;
}

async function writeEntry(fullPath: string, content: Uint8Array): Promise<void> {
	await mkdir(dirname(fullPath), { recursive: true });
	await writeFile(fullPath, content);
}

/**
 * Stream-extract a ZIP, aborting as soon as the running total of *actual*
 * decompressed bytes exceeds the limit. Feeding the compressed data in small
 * chunks bounds how much a single decode step can emit, so a crafted archive
 * cannot allocate more than the limit before being rejected — unlike trusting
 * the uncompressed-size fields in the central directory, which an attacker
 * controls and can forge to defeat a pre-decompression size check.
 */
async function extractWithinLimit(
	data: Uint8Array,
	targetDir: string,
	limit: number,
	limitMB: number
): Promise<number> {
	let totalBytes = 0;
	let entryCount = 0;
	let failure: Error | null = null;
	const writes: Promise<void>[] = [];

	const unzipper = new Unzip((file) => {
		if (failure) return;

		if (!isSafeEntryPath(file.name, targetDir)) {
			failure = new Error(`Unsafe path in archive: ${file.name}`);
			return;
		}

		const normalized = file.name.replace(/\\/g, '/');
		const fullPath = join(targetDir, normalized.split('/').join(sep));

		if (normalized.endsWith('/')) {
			writes.push(mkdir(fullPath, { recursive: true }).then(() => undefined));
			return;
		}

		const chunks: Uint8Array[] = [];
		let fileBytes = 0;
		file.ondata = (err, chunk, final) => {
			if (failure) return;
			if (err) {
				failure = err;
				return;
			}
			totalBytes += chunk.length;
			if (totalBytes > limit) {
				failure = new Error(`Extracted content exceeds maximum allowed size of ${limitMB}MB`);
				return;
			}
			chunks.push(chunk);
			fileBytes += chunk.length;
			if (final) {
				writes.push(writeEntry(fullPath, concatChunks(chunks, fileBytes)));
				entryCount++;
			}
		};
		file.start();
	});
	unzipper.register(UnzipInflate);
	unzipper.register(UnzipPassThrough);

	for (let offset = 0; offset < data.length && !failure; offset += STREAM_CHUNK_SIZE) {
		const end = Math.min(offset + STREAM_CHUNK_SIZE, data.length);
		unzipper.push(data.subarray(offset, end), end >= data.length);
	}

	if (failure) throw failure;
	await Promise.all(writes);
	return entryCount;
}

