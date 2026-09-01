import { describe, expect, test } from 'bun:test';
import { isDiskUsageStale } from './disk-usage';
import {
	CONTAINER_TIMEOUTS,
	DISK_USAGE_STALE_MS,
	TRANSPORT_GRACE_MS,
	type ContainerDiskUsage
} from '$shared/types/containers';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');

function reading(measuredAt: string | null): ContainerDiskUsage {
	return { rows: [], error: null, measuredAt };
}

describe('isDiskUsageStale', () => {
	test('a reading taken just now is still good', () => {
		expect(isDiskUsageStale(reading(new Date(NOW - 1_000).toISOString()), NOW)).toBe(false);
	});

	test('a reading goes stale once it passes the window', () => {
		const justInside = new Date(NOW - DISK_USAGE_STALE_MS + 1_000).toISOString();
		const justOutside = new Date(NOW - DISK_USAGE_STALE_MS - 1_000).toISOString();
		expect(isDiskUsageStale(reading(justInside), NOW)).toBe(false);
		expect(isDiskUsageStale(reading(justOutside), NOW)).toBe(true);
	});

	test('having no reading at all is stale', () => {
		expect(isDiskUsageStale(null, NOW)).toBe(true);
	});

	test('a reading that did not say when it was taken is stale', () => {
		// Rather than being treated as current, which would pin a number that
		// nothing would ever replace.
		expect(isDiskUsageStale(reading(null), NOW)).toBe(true);
		expect(isDiskUsageStale(reading('not a date'), NOW)).toBe(true);
	});

	test('a reading stamped in the future is not treated as stale', () => {
		// A host whose clock runs ahead should not make the panel re-measure on
		// every open — the invalidation after a prune is what keeps it honest.
		expect(isDiskUsageStale(reading(new Date(NOW + 60_000).toISOString()), NOW)).toBe(false);
	});
});

describe('command budgets', () => {
	// The bug this guards against: the transport gave up at 30s while the backend
	// was still allowed 300s for a prune, so a sweep that was still deleting came
	// back as six failures and the user was invited to run it again.
	test('every command budget leaves room for the transport to outlast it', () => {
		for (const [name, budget] of Object.entries(CONTAINER_TIMEOUTS)) {
			expect(budget + TRANSPORT_GRACE_MS, `${name} must outlast its command`).toBeGreaterThan(
				budget
			);
		}
	});

	test('a full scan is allowed more than any single listing it runs', () => {
		expect(CONTAINER_TIMEOUTS.scan).toBeGreaterThan(CONTAINER_TIMEOUTS.list);
	});

	test('a prune is allowed the longest, because it walks what it deletes', () => {
		const others = Object.entries(CONTAINER_TIMEOUTS)
			.filter(([name]) => name !== 'prune')
			.map(([, budget]) => budget);
		expect(CONTAINER_TIMEOUTS.prune).toBeGreaterThan(Math.max(...others));
	});
});
