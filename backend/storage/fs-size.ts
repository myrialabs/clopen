/**
 * Disk usage of a path, measured the way a deletion would free it.
 *
 * Allocated blocks rather than apparent size where the platform reports them: a
 * sparse Chrome cache file or a reflinked worktree occupies far less than its
 * length, and promising the length back would overstate every cleanup. Windows
 * reports no block count, so the size is the best figure there.
 *
 * Everything is asynchronous and yields between directories, so measuring
 * forty gigabytes never holds the event loop the server answers on.
 */

import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';

export interface TreeSize {
	bytes: number;
	files: number;
}

export function allocatedBytes(stat: Stats): number {
	const blocks = (stat as Stats & { blocks?: number }).blocks;
	return typeof blocks === 'number' && blocks > 0 ? blocks * 512 : stat.size;
}

/** Size of a file or directory tree. Missing paths measure 0. Symlinks are not followed. */
export async function measurePath(target: string, signal?: AbortSignal): Promise<TreeSize> {
	let stat: Stats;
	try {
		stat = await fs.lstat(target);
	} catch {
		return { bytes: 0, files: 0 };
	}
	if (!stat.isDirectory()) return { bytes: allocatedBytes(stat), files: 1 };

	const total: TreeSize = { bytes: allocatedBytes(stat), files: 0 };
	const stack: string[] = [target];
	while (stack.length > 0) {
		if (signal?.aborted) break;
		const dir = stack.pop()!;
		let entries: import('node:fs').Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		const stats = await Promise.all(entries.map(entry =>
			fs.lstat(join(dir, entry.name)).then(s => ({ entry, s }), () => null)
		));
		for (const item of stats) {
			if (!item) continue;
			total.bytes += allocatedBytes(item.s);
			if (item.s.isDirectory()) stack.push(join(dir, item.entry.name));
			else total.files++;
		}
	}
	return total;
}

/** Sizes of each direct child of a directory, keyed by name. */
export async function measureChildren(dir: string, signal?: AbortSignal): Promise<Map<string, TreeSize>> {
	const sizes = new Map<string, TreeSize>();
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return sizes;
	}
	for (const name of names) {
		if (signal?.aborted) break;
		sizes.set(name, await measurePath(join(dir, name), signal));
	}
	return sizes;
}

/** Remove a path and report what it occupied. Never throws for a missing path. */
export async function removePath(target: string): Promise<number> {
	const { bytes } = await measurePath(target);
	await fs.rm(target, { recursive: true, force: true });
	return bytes;
}

export async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.lstat(target);
		return true;
	} catch {
		return false;
	}
}

/** Let other work run. Used between units of a long synchronous loop. */
export function yieldToEventLoop(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

/** A file's bytes, chunk by chunk, without holding the whole file in memory. */
export async function* readFileChunks(file: string): AsyncGenerator<Uint8Array> {
	const reader = Bun.file(file).stream().getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		// Also reached when the caller stops early; cancel closes the file.
		await reader.cancel().catch(() => {});
	}
}
