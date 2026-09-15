import { describe, expect, it } from 'bun:test';
import {
	sortByFootprint,
	summarizeStorage,
	type ProjectResourceEntry,
	type ProjectStorage,
	type StorageState
} from './overview';

function storage(state: StorageState, sizeBytes = 0, opts?: { files?: number; dirs?: number; truncated?: boolean; error?: string }): ProjectStorage {
	return {
		state,
		sizeBytes,
		fileCount: opts?.files ?? 0,
		dirCount: opts?.dirs ?? 0,
		truncated: opts?.truncated ?? false,
		error: opts?.error ?? null
	};
}

function entry(
	id: string,
	storageValue: ProjectStorage,
	opts?: { status?: 'running' | 'idle'; lastOpened?: string; cpuPercent?: number | null }
): ProjectResourceEntry {
	return {
		id,
		name: id,
		path: `/tmp/${id}`,
		created_at: '2026-01-01T00:00:00.000Z',
		last_opened_at: opts?.lastOpened ?? '2026-02-01T00:00:00.000Z',
		status: opts?.status ?? 'idle',
		cpuPercent: opts?.cpuPercent ?? 0,
		memRssBytes: 0,
		memPercent: 0,
		storage: storageValue
	};
}

describe('summarizeStorage', () => {
	it('sums measured entries and counts the rest by state', () => {
		const totals = summarizeStorage([
			entry('a', storage('ready', 100, { files: 5, dirs: 1 })),
			entry('b', storage('ready', 200, { files: 7, dirs: 3 })),
			entry('busy', storage('ready', 500, { files: 50, dirs: 9 }), { status: 'running' }),
			entry('cold', storage('measuring')),
			entry('gone', storage('unavailable', 0, { error: 'ENOENT: no such file or directory' }))
		]);
		expect(totals).toEqual({
			measuredCount: 3,
			measuringCount: 1,
			unavailableCount: 1,
			totalStorageBytes: 800,
			totalFiles: 62,
			totalDirs: 13
		});
	});

	it('keeps a pending walk out of the totals instead of reading it as 0 B', () => {
		expect(summarizeStorage([entry('cold', storage('measuring'))])).toEqual({
			measuredCount: 0,
			measuringCount: 1,
			unavailableCount: 0,
			totalStorageBytes: 0,
			totalFiles: 0,
			totalDirs: 0
		});
	});
});

describe('sortByFootprint', () => {
	it('ranks by sizeBytes DESC across statuses', () => {
		const sorted = sortByFootprint([
			entry('s', storage('ready', 10)),
			entry('xl', storage('ready', 200)),
			entry('xxl', storage('ready', 500)),
			entry('biggest', storage('ready', 900), { status: 'running', cpuPercent: 12.5 }),
			entry('tiny', storage('ready', 1))
		]);
		expect(sorted.map((e) => e.id)).toEqual(['biggest', 'xxl', 'xl', 's', 'tiny']);
		expect(sorted[0].status).toBe('running');
	});

	it('lists measured projects first, then measuring, then unavailable', () => {
		const sorted = sortByFootprint([
			entry('gone', storage('unavailable', 0, { error: 'ENOENT' })),
			entry('cold', storage('measuring')),
			entry('partial', storage('ready', 400, { truncated: true })),
			entry('full', storage('ready', 300))
		]);
		expect(sorted.map((e) => e.id)).toEqual(['partial', 'full', 'cold', 'gone']);
		expect(sorted[0].storage.truncated).toBe(true);
	});

	it('breaks size ties by oldest last_opened_at first', () => {
		const sorted = sortByFootprint([
			entry('newer', storage('ready', 100), { lastOpened: '2026-03-01T00:00:00.000Z' }),
			entry('older', storage('ready', 100), { lastOpened: '2026-01-15T00:00:00.000Z' })
		]);
		expect(sorted.map((e) => e.id)).toEqual(['older', 'newer']);
	});

	it('does not mutate the caller array', () => {
		const entries = [entry('a', storage('ready', 1)), entry('b', storage('ready', 2))];
		sortByFootprint(entries);
		expect(entries.map((e) => e.id)).toEqual(['a', 'b']);
	});
});
