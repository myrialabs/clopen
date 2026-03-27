/**
 * Content-Addressable Blob Store
 * Git-like storage for snapshot file contents
 *
 * Structure:
 *   ~/.clopen/snapshots/blobs/{hash[0:2]}/{hash}.gz  - compressed file blobs
 *
 * Deduplication: Same file content across any snapshot is stored only once.
 * Compression: All blobs are gzip compressed to minimize disk usage.
 */

import { join } from 'path';
import fs from 'fs/promises';
import { gzipSync, gunzipSync } from 'zlib';
import { debug } from '$shared/utils/logger';
import { getClopenDir } from '../utils/index.js';

const SNAPSHOTS_DIR = join(getClopenDir(), 'snapshots');
const BLOBS_DIR = join(SNAPSHOTS_DIR, 'blobs');

export interface TreeMap {
	[filepath: string]: string; // filepath -> blob hash
}

interface FileHashCacheEntry {
	mtimeMs: number;
	size: number;
	hash: string;
}

class BlobStore {
	private initialized = false;

	/**
	 * Cache: filepath -> { mtimeMs, size, hash }
	 * Avoids re-reading files that haven't changed (based on mtime + size).
	 */
	private fileHashCache = new Map<string, FileHashCacheEntry>();

	/**
	 * Ensure storage directories exist
	 */
	async init(): Promise<void> {
		if (this.initialized) return;
		await fs.mkdir(BLOBS_DIR, { recursive: true });
		this.initialized = true;
	}

	/**
	 * Compute SHA-256 hash of content (Buffer for binary safety)
	 */
	hashContent(content: Buffer): string {
		const hasher = new Bun.CryptoHasher('sha256');
		hasher.update(content);
		return hasher.digest('hex');
	}

	/**
	 * Get blob file path from hash (using 2-char prefix subdirectory like git)
	 */
	private getBlobPath(hash: string): string {
		const prefix = hash.substring(0, 2);
		return join(BLOBS_DIR, prefix, hash + '.gz');
	}

	/**
	 * Check if a blob exists
	 */
	async hasBlob(hash: string): Promise<boolean> {
		try {
			await fs.access(this.getBlobPath(hash));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Store content as a blob. Returns the hash.
	 * If blob already exists (same hash), it's a no-op (deduplication).
	 * Accepts Buffer to safely handle both text and binary files.
	 */
	async storeBlob(content: Buffer): Promise<string> {
		await this.init();
		const hash = this.hashContent(content);

		// Check if already exists (deduplication)
		if (await this.hasBlob(hash)) {
			return hash;
		}

		// Create prefix directory
		const prefixDir = join(BLOBS_DIR, hash.substring(0, 2));
		await fs.mkdir(prefixDir, { recursive: true });

		// Compress and write (Buffer directly, no encoding conversion)
		const compressed = gzipSync(content);
		await fs.writeFile(this.getBlobPath(hash), compressed);

		return hash;
	}

	/**
	 * Read blob content by hash. Returns Buffer to safely handle binary files.
	 */
	async readBlob(hash: string): Promise<Buffer> {
		const blobPath = this.getBlobPath(hash);
		const compressed = await fs.readFile(blobPath);
		return gunzipSync(compressed);
	}

	/**
	 * Hash a file using mtime cache. Returns { hash, content? }.
	 * If the file hasn't changed (same mtime+size), returns cached hash without reading content.
	 * If the file has changed, reads content, hashes it, stores blob, and caches.
	 * Reads as Buffer to safely handle binary files (images, PDFs, etc.).
	 *
	 * @returns hash and content Buffer (content is null if cache hit and blob already exists)
	 */
	async hashFile(filepath: string, fullPath: string): Promise<{ hash: string; content: Buffer | null; cached: boolean }> {
		await this.init();

		const stat = await fs.stat(fullPath);

		// Check mtime cache
		const cached = this.fileHashCache.get(filepath);
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
			// Verify blob still exists on disk (could have been cleaned up)
			if (await this.hasBlob(cached.hash)) {
				return { hash: cached.hash, content: null, cached: true };
			}
			// Blob was deleted — invalidate cache, fall through to re-read and re-store
			this.fileHashCache.delete(filepath);
		}

		// File changed or cache miss - read as Buffer (binary-safe, no encoding conversion)
		const content = await fs.readFile(fullPath);
		const hash = this.hashContent(content);

		// Store blob (deduplication handled internally)
		await this.storeBlob(content);

		// Update cache
		this.fileHashCache.set(filepath, {
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			hash
		});

		return { hash, content, cached: false };
	}

	/**
	 * Delete multiple blobs by hash.
	 * Also invalidates fileHashCache entries whose hash matches a deleted blob.
	 */
	async deleteBlobs(hashes: string[]): Promise<number> {
		const hashSet = new Set(hashes);
		let deleted = 0;
		for (const hash of hashes) {
			try {
				await fs.unlink(this.getBlobPath(hash));
				deleted++;
			} catch {
				// Ignore - might not exist
			}
		}

		// Invalidate fileHashCache entries pointing to deleted blobs
		for (const [filepath, entry] of this.fileHashCache) {
			if (hashSet.has(entry.hash)) {
				this.fileHashCache.delete(filepath);
			}
		}

		return deleted;
	}

	/**
	 * Scan all blob files on disk and return their hashes.
	 * Used for full garbage collection — compare with DB references to find orphans.
	 */
	async scanAllBlobHashes(): Promise<Set<string>> {
		const hashes = new Set<string>();
		try {
			const prefixDirs = await fs.readdir(BLOBS_DIR);
			for (const prefix of prefixDirs) {
				const prefixPath = join(BLOBS_DIR, prefix);
				const stat = await fs.stat(prefixPath);
				if (!stat.isDirectory()) continue;

				const files = await fs.readdir(prefixPath);
				for (const file of files) {
					if (file.endsWith('.gz')) {
						hashes.add(file.slice(0, -3)); // Remove .gz suffix
					}
				}
			}
		} catch {
			// Directory might not exist yet
		}
		return hashes;
	}
}

// Export singleton
export const blobStore = new BlobStore();
