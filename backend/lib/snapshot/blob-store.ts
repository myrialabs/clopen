/**
 * Content-Addressable Blob Store
 * Git-like storage for snapshot file contents
 *
 * Structure:
 *   ~/.clopen/snapshots/blobs/{hash[0:2]}/{hash}.gz  - compressed file blobs
 *   ~/.clopen/snapshots/trees/{snapshotId}.json       - tree maps (filepath -> hash)
 *
 * Deduplication: Same file content across any snapshot is stored only once.
 * Compression: All blobs are gzip compressed to minimize disk usage.
 */

import { join } from 'path';
import { homedir } from 'os';
import fs from 'fs/promises';
import { gzipSync, gunzipSync } from 'zlib';
import { debug } from '$shared/utils/logger';

const SNAPSHOTS_DIR = join(homedir(), '.clopen', 'snapshots');
const BLOBS_DIR = join(SNAPSHOTS_DIR, 'blobs');
const TREES_DIR = join(SNAPSHOTS_DIR, 'trees');

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
		await fs.mkdir(TREES_DIR, { recursive: true });
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
	 * Store a tree (snapshot state) as a JSON file.
	 * Returns the tree hash for reference.
	 */
	async storeTree(snapshotId: string, tree: TreeMap): Promise<string> {
		await this.init();
		const treePath = join(TREES_DIR, `${snapshotId}.json`);
		const content = JSON.stringify(tree);
		const treeHash = this.hashContent(Buffer.from(content, 'utf-8'));
		await fs.writeFile(treePath, content, 'utf-8');
		return treeHash;
	}

	/**
	 * Read a tree by snapshot ID
	 */
	async readTree(snapshotId: string): Promise<TreeMap> {
		const treePath = join(TREES_DIR, `${snapshotId}.json`);
		const content = await fs.readFile(treePath, 'utf-8');
		return JSON.parse(content) as TreeMap;
	}

	/**
	 * Check if a tree exists
	 */
	async hasTree(snapshotId: string): Promise<boolean> {
		try {
			await fs.access(join(TREES_DIR, `${snapshotId}.json`));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Resolve a tree to full file contents (as Buffers).
	 * Reads all blobs in parallel for performance.
	 * Returns { filepath: Buffer } map for binary-safe handling.
	 */
	async resolveTree(tree: TreeMap): Promise<Record<string, Buffer>> {
		const result: Record<string, Buffer> = {};

		const entries = Object.entries(tree);
		const blobPromises = entries.map(async ([filepath, hash]) => {
			try {
				const content = await this.readBlob(hash);
				return { filepath, content };
			} catch (err) {
				debug.warn('snapshot', `Could not read blob ${hash} for ${filepath}:`, err);
				return null;
			}
		});

		const results = await Promise.all(blobPromises);
		for (const r of results) {
			if (r) {
				result[r.filepath] = r.content;
			}
		}

		return result;
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
			return { hash: cached.hash, content: null, cached: true };
		}

		// File changed - read as Buffer (binary-safe, no encoding conversion)
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
	 * Delete a tree file (cleanup)
	 */
	async deleteTree(snapshotId: string): Promise<void> {
		try {
			await fs.unlink(join(TREES_DIR, `${snapshotId}.json`));
		} catch {
			// Ignore - might not exist
		}
	}
}

// Export singleton
export const blobStore = new BlobStore();
