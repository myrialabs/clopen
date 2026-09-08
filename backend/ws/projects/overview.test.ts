import { describe, expect, it } from 'bun:test';
import { pickTopEntries, summarizeIdleStats, type ProjectEntry } from './overview';

function entry(
	id: string,
	sizeBytes: number,
	opts?: {
		status?: 'running' | 'idle';
		error?: string;
		truncated?: boolean;
		lastOpened?: string;
		files?: number;
		dirs?: number;
		cpuPercent?: number | null;
	}
): ProjectEntry {
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
		storage: {
			sizeBytes,
			fileCount: opts?.files ?? 10,
			dirCount: opts?.dirs ?? 2,
			truncated: opts?.truncated ?? false,
			...(opts?.error ? { error: opts.error } : {})
		}
	};
}

describe('summarizeIdleStats', () => {
	it('sums only error-free idle entries', () => {
		const totals = summarizeIdleStats([
			entry('a', 100, { files: 5, dirs: 1 }),
			entry('b', 200, { files: 7, dirs: 3 }),
			entry('gone', 0, { error: 'ENOENT: no such file or directory' }),
			entry('busy', 500, { status: 'running', files: 50, dirs: 9 })
		]);
		expect(totals).toEqual({
			measurableCount: 2,
			totalStorageIdle: 300,
			totalFilesIdle: 12,
			totalDirsIdle: 4
		});
	});

	it('returns zeros when nothing is measurable', () => {
		expect(summarizeIdleStats([entry('gone', 0, { error: 'gone' })])).toEqual({
			measurableCount: 0,
			totalStorageIdle: 0,
			totalFilesIdle: 0,
			totalDirsIdle: 0
		});
	});
});

describe('pickTopEntries', () => {
	it('ranks by sizeBytes DESC across statuses and caps at 5', () => {
		const entries = [
			entry('s', 10),
			entry('m', 50),
			entry('l', 90),
			entry('xl', 200),
			entry('xxl', 500),
			entry('xxxl', 900, { status: 'running', cpuPercent: 12.5 }),
			entry('tiny', 1)
		];
		const top = pickTopEntries(entries);
		expect(top.map((e) => e.id)).toEqual(['xxxl', 'xxl', 'xl', 'l', 'm']);
		expect(top[0].status).toBe('running');
	});

	it('never ranks error entries but keeps partial (truncated) ones', () => {
		const top = pickTopEntries([
			entry('gone', 999_999, { error: 'ENOENT' }),
			entry('partial', 400, { truncated: true }),
			entry('full', 300)
		]);
		expect(top.map((e) => e.id)).toEqual(['partial', 'full']);
		expect(top[0].storage.truncated).toBe(true);
	});

	it('breaks size ties by oldest last_opened_at first', () => {
		const top = pickTopEntries([
			entry('newer', 100, { lastOpened: '2026-03-01T00:00:00.000Z' }),
			entry('older', 100, { lastOpened: '2026-01-15T00:00:00.000Z' })
		]);
		expect(top.map((e) => e.id)).toEqual(['older', 'newer']);
	});
});
