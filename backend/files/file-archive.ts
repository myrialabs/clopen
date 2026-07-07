import { isAbsolute, join, relative, sep } from 'node:path';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import {
	zip,
	tar,
	tarGz,
	tarZstd,
	sevenZip,
	extractStream,
	type ZipEntryInput,
	type TarEntryInput,
	type SevenZipEntryInput,
	type ArchiveFormat
} from '@myrialabs/zipkit';

import { debug } from '$shared/utils/logger';
import { getMaxFileSize, validateFileSize } from './file-size-limit';

/** Container formats Clopen can produce. */
export type ArchiveKind = 'zip' | 'tar' | 'tar.gz' | 'tar.zst' | '7z';

/** Options for {@link createArchiveOperation}. */
export interface CreateArchiveOptions {
	/** Container format (default `'zip'`). */
	format?: ArchiveKind;
	/** ZIP compression method (default `'deflate'`). Ignored by tar/7z. */
	method?: 'store' | 'deflate' | 'zstd';
	/** Compression level (codec-specific; left to the codec default when omitted). */
	level?: number;
	/** Encrypt the archive with WinZip AES-256. ZIP only. */
	password?: string;
}

interface FlatFile {
	name: string;
	data: Uint8Array;
	mode: number;
}

interface FlatDir {
	name: string;
	mode: number;
}

/** Recursively collect files (and empty directories) under `sourcePath`. */
async function collectEntries(sourcePath: string, rootName: string, files: FlatFile[], emptyDirs: FlatDir[]): Promise<void> {
	const stats = await stat(sourcePath);
	if (stats.isFile()) {
		const data = new Uint8Array(await Bun.file(sourcePath).arrayBuffer());
		files.push({ name: rootName, data, mode: stats.mode & 0o777 });
		return;
	}
	if (stats.isDirectory()) {
		const entries = await readdir(sourcePath);
		if (entries.length === 0) {
			emptyDirs.push({ name: `${rootName}/`, mode: stats.mode & 0o777 });
			return;
		}
		for (const entry of entries) {
			await collectEntries(join(sourcePath, entry), `${rootName}/${entry}`, files, emptyDirs);
		}
	}
}

/** Build the archive bytes for the requested container from collected entries. */
async function buildArchive(
	format: ArchiveKind,
	files: FlatFile[],
	emptyDirs: FlatDir[],
	opts: CreateArchiveOptions
): Promise<Uint8Array> {
	if (opts.password && format !== 'zip') {
		throw new Error('Password protection is only supported for ZIP archives');
	}

	if (format === 'zip') {
		const method = opts.method ?? 'deflate';
		const entries: ZipEntryInput[] = [
			...files.map((f) => ({ name: f.name, data: f.data, method, level: opts.level, unixPermissions: f.mode })),
			...emptyDirs.map((d) => ({ name: d.name, data: new Uint8Array(0), unixPermissions: d.mode }))
		];
		return zip(entries, opts.password ? { password: opts.password } : {});
	}

	if (format === '7z') {
		// 7z entries are files only; empty directories aren't represented.
		const entries: SevenZipEntryInput[] = files.map((f) => ({
			name: f.name,
			data: f.data,
			method: opts.method === 'store' ? 'copy' : 'lzma',
			level: opts.level
		}));
		return sevenZip(entries);
	}

	// tar family
	const entries: TarEntryInput[] = [
		...files.map((f) => ({ name: f.name, data: f.data, mode: f.mode })),
		...emptyDirs.map((d) => ({ name: d.name, type: 'directory' as const, mode: d.mode }))
	];
	if (format === 'tar') return tar(entries);
	if (format === 'tar.gz') return tarGz(entries, opts.level !== undefined ? { level: opts.level } : undefined);
	return tarZstd(entries, opts.level !== undefined ? { level: opts.level } : undefined);
}

/**
 * Compress a set of files/directories into a single archive. Supports ZIP
 * (store/deflate/zstd, optional AES-256), tar/`.tar.gz`/`.tar.zst`, and 7z.
 */
export async function createArchiveOperation(
	sourcePaths: string[],
	targetPath: string,
	opts: CreateArchiveOptions = {}
): Promise<{ message: string; path: string; size: number; modified: string }> {
	if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
		throw new Error('At least one source path is required');
	}
	if (!targetPath) {
		throw new Error('Target archive path is required');
	}

	const format = opts.format ?? 'zip';

	try {
		const targetFile = Bun.file(targetPath);
		if (await targetFile.exists()) {
			throw new Error('Target archive already exists');
		}

		const files: FlatFile[] = [];
		const emptyDirs: FlatDir[] = [];
		for (const source of sourcePaths) {
			const name = source.split(sep).pop() ?? '';
			if (!name || name === '.' || name === '..') {
				throw new Error(`Invalid source path: ${source}`);
			}
			await collectEntries(source, name, files, emptyDirs);
		}

		const archive = await buildArchive(format, files, emptyDirs, opts);
		validateFileSize(archive.byteLength);
		await Bun.write(targetPath, archive);
		const stats = await stat(targetPath);

		return {
			message: 'Archive created successfully',
			path: targetPath,
			size: stats.size,
			modified: stats.mtime.toISOString()
		};
	} catch (error) {
		debug.error('file', 'Create archive error:', error);
		if (error instanceof Error) {
			if (error.message.includes('EPERM')) throw new Error('Permission denied while creating archive');
			if (error.message.includes('ENOSPC')) throw new Error('Not enough space on disk');
			throw error;
		}
		throw new Error('Failed to create archive');
	}
}

/** Reject entry paths that are absolute or escape the extraction root. */
function isSafeEntryPath(entryPath: string, targetRoot: string): boolean {
	if (!entryPath) return false;
	if (isAbsolute(entryPath)) return false;
	const normalized = entryPath.replace(/\\/g, '/');
	if (normalized.split('/').some((segment) => segment === '..')) return false;
	const full = join(targetRoot, normalized);
	const rel = relative(targetRoot, full);
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Map a filename to a ZipKit container format; `undefined` → auto-detect. */
function formatFromPath(archivePath: string): ArchiveFormat | undefined {
	const n = archivePath.toLowerCase();
	if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tar.gz';
	if (n.endsWith('.tar.zst') || n.endsWith('.tzst')) return 'tar.zst';
	if (n.endsWith('.tar.xz') || n.endsWith('.txz')) return 'tar.xz';
	if (n.endsWith('.tar.bz2') || n.endsWith('.tbz2')) return 'tar.bz2';
	if (n.endsWith('.tar')) return 'tar';
	if (n.endsWith('.zip')) return 'zip';
	if (n.endsWith('.7z')) return '7z';
	// Lone-stream / ambiguous extensions: let extractStream sniff the magic bytes.
	return undefined;
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let pos = 0;
	for (const chunk of chunks) {
		out.set(chunk, pos);
		pos += chunk.length;
	}
	return out;
}

async function writeEntry(fullPath: string, chunks: Uint8Array[], total: number): Promise<void> {
	await mkdir(join(fullPath, '..'), { recursive: true });
	await writeFile(fullPath, concatChunks(chunks, total));
}

/**
 * Extract an archive into `targetDir`. Auto-detects the container (ZIP, tar,
 * `.tar.gz`/`.tar.zst`, 7z, …) from the filename or magic bytes and streams via
 * ZipKit's {@link extractStream}, which caps the running total of *actually
 * decompressed* bytes at the configured file-size limit — so a crafted archive
 * that forges its uncompressed-size fields still can't blow past the cap. Each
 * entry is path-checked before it touches disk; symlinks are skipped to avoid
 * symlink-escape writes.
 */
export async function extractArchiveOperation(
	archivePath: string,
	targetDir: string,
	password?: string
): Promise<{ message: string; path: string; entries: number; modified: string }> {
	if (!archivePath) throw new Error('Archive path is required');
	if (!targetDir) throw new Error('Target directory is required');

	const archiveFile = Bun.file(archivePath);
	if (!(await archiveFile.exists())) throw new Error('Archive does not exist');

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
			if (!targetStats.isDirectory()) throw new Error('Target path exists and is not a directory');
		}
		// The target directory is created lazily, only as entries are written, so a
		// failed extraction — e.g. an encrypted archive before its password is
		// entered, or an incorrect one — never leaves an empty folder behind.

		const data = new Uint8Array(await archiveFile.arrayBuffer());
		const entryCount = await extractWithinLimit(data, archivePath, targetDir, limit, limitMB, password);

		// Ensure the directory exists even for an archive that yielded no file
		// entries, so the stat below has something to read.
		await mkdir(targetDir, { recursive: true });
		const targetStats = await stat(targetDir);
		return {
			message: 'Archive extracted successfully',
			path: targetDir,
			entries: entryCount,
			modified: targetStats.mtime.toISOString()
		};
	} catch (error) {
		debug.error('file', 'Extract archive error:', error);
		if (error instanceof Error) {
			// Translate ZipKit's technical encryption errors into a clean message the
			// UI can detect to prompt for (or re-prompt) a password.
			if (/encrypted|wrong password|bad password|decrypt/i.test(error.message)) {
				throw new Error(password ? 'Incorrect password for this archive' : 'This archive is password-protected');
			}
			if (error.message.includes('EPERM')) throw new Error('Permission denied while extracting archive');
			if (error.message.includes('ENOSPC')) throw new Error('Not enough space on disk');
			throw error;
		}
		throw new Error('Failed to extract archive');
	}
}

/**
 * Stream-extract an archive, translating ZipKit's cap error into Clopen's
 * user-facing size-limit message. `maxTotalBytes` bounds actual decompressed
 * output, so a zip bomb (or one that forges its metadata) is rejected before it
 * can allocate past the limit.
 */
async function extractWithinLimit(
	data: Uint8Array,
	archivePath: string,
	targetDir: string,
	limit: number,
	limitMB: number,
	password?: string
): Promise<number> {
	let entryCount = 0;
	let currentPath: string | null = null;
	let chunks: Uint8Array[] = [];
	let currentTotal = 0;

	try {
		for await (const { info, chunk, done } of extractStream(data, {
			maxTotalBytes: limit,
			format: formatFromPath(archivePath),
			password
		})) {
			if (!isSafeEntryPath(info.name, targetDir)) {
				throw new Error(`Unsafe path in archive: ${info.name}`);
			}
			const normalized = info.name.replace(/\\/g, '/');
			const fullPath = join(targetDir, normalized.split('/').join(sep));

			if (info.type === 'directory') {
				await mkdir(fullPath, { recursive: true });
				continue;
			}
			// Skip symlinks: recreating them from an untrusted archive risks
			// symlink-escape writes on later entries.
			if (info.type === 'symlink') continue;

			if (currentPath !== fullPath) {
				currentPath = fullPath;
				chunks = [];
				currentTotal = 0;
			}
			if (chunk.length) {
				chunks.push(chunk);
				currentTotal += chunk.length;
			}
			if (done) {
				await writeEntry(fullPath, chunks, currentTotal);
				entryCount++;
				currentPath = null;
				chunks = [];
				currentTotal = 0;
			}
		}
	} catch (error) {
		if (error instanceof Error && /maxTotalBytes|remaining cap/.test(error.message)) {
			throw new Error(`Extracted content exceeds maximum allowed size of ${limitMB}MB`);
		}
		throw error;
	}

	return entryCount;
}
