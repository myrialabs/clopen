/**
 * Database Health Dashboard Store — Svelte 5 Runes
 */

import ws from '$frontend/utils/ws';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import type { DBHealthMetrics, DBHealthAlert, DBHealthTPS } from '$shared/types/db-health';
import { HEALTH_THRESHOLDS } from '$shared/types/db-health';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Number of historical data points to keep for charts */
const HISTORY_MAX = 30;

// ─── State ────────────────────────────────────────────────────────────────────

export const dbHealthState = $state({
	isOpen: false,
	connectionId: null as string | null,
	current: null as DBHealthMetrics | null,
	/** Rolling history for sparkline / line charts */
	history: [] as DBHealthMetrics[],
	isLoading: false,
	fetchedAt: null as string | null,
	autoRefresh: false,
	refreshIntervalSec: 5,
	_intervalId: null as ReturnType<typeof setInterval> | null,
	/** Per-poll TPS delta (computed from successive commit/rollback counts) */
	_prevTpsRaw: null as { commits: number; rollbacks: number; ts: number } | null
});

// ─── Computed alerts ──────────────────────────────────────────────────────────

export function computeAlerts(m: DBHealthMetrics): DBHealthAlert[] {
	const alerts: DBHealthAlert[] = [];

	// Connections %
	if (m.connections.max && m.connections.max > 0) {
		const total = m.connections.active + m.connections.idle + m.connections.waiting;
		const pct = (total / m.connections.max) * 100;
		if (pct >= HEALTH_THRESHOLDS.connectionsPctCritical) {
			alerts.push({ level: 'critical', metric: 'connections', message: `Connection usage at ${pct.toFixed(0)}% of max (${total}/${m.connections.max})` });
		} else if (pct >= HEALTH_THRESHOLDS.connectionsPctWarning) {
			alerts.push({ level: 'warning', metric: 'connections', message: `Connection usage at ${pct.toFixed(0)}% of max (${total}/${m.connections.max})` });
		}
	}

	// Cache hit ratio
	if (m.memory?.cacheHitRatio !== null && m.memory?.cacheHitRatio !== undefined) {
		const ratio = m.memory.cacheHitRatio;
		if (ratio < HEALTH_THRESHOLDS.cacheHitCritical) {
			alerts.push({ level: 'critical', metric: 'cache', message: `Cache hit ratio critically low: ${ratio.toFixed(1)}%` });
		} else if (ratio < HEALTH_THRESHOLDS.cacheHitWarning) {
			alerts.push({ level: 'warning', metric: 'cache', message: `Cache hit ratio below threshold: ${ratio.toFixed(1)}%` });
		}
	}

	// Slow queries
	if (m.slowQueries.length > 0) {
		alerts.push({ level: 'warning', metric: 'slow_queries', message: `${m.slowQueries.length} slow quer${m.slowQueries.length === 1 ? 'y' : 'ies'} detected (>${HEALTH_THRESHOLDS.slowQueryThresholdMs / 1000}s)` });
	}

	return alerts;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

export function openHealthDashboard(connectionId: string): void {
	dbHealthState.connectionId = connectionId;
	dbHealthState.isOpen = true;
	dbHealthState.history = [];
	dbHealthState.current = null;
	dbHealthState.fetchedAt = null;
	dbHealthState._prevTpsRaw = null;
	fetchHealthMetrics();
}

export function closeHealthDashboard(): void {
	dbHealthState.isOpen = false;
	stopAutoRefresh();
}

export async function fetchHealthMetrics(): Promise<void> {
	if (!dbHealthState.connectionId) return;
	dbHealthState.isLoading = true;
	try {
		const result: DBHealthMetrics = await ws.http('db:health:metrics', {
			connectionId: dbHealthState.connectionId
		});

		// Compute real TPS delta from cumulative counters (PG, MySQL)
		if (result.tps) {
			const now = Date.now();
			const prev = dbHealthState._prevTpsRaw;
			if (prev) {
				const deltaSec = (now - prev.ts) / 1000;
				if (deltaSec > 0) {
					const deltaOps = (result.tps.commits - prev.commits) + (result.tps.rollbacks - prev.rollbacks);
					result.tps = { ...result.tps, tps: Math.max(0, Math.round((deltaOps / deltaSec) * 10) / 10) };
				}
			}
			dbHealthState._prevTpsRaw = { commits: result.tps.commits, rollbacks: result.tps.rollbacks, ts: now };
		}

		dbHealthState.current = result;
		dbHealthState.fetchedAt = result.timestamp;

		// Push to history, cap at max
		dbHealthState.history = [...dbHealthState.history, result].slice(-HISTORY_MAX);
	} catch {
		addNotification({ type: 'error', title: 'Health Dashboard', message: 'Failed to fetch metrics', duration: 4000 });
	} finally {
		dbHealthState.isLoading = false;
	}
}

export function startAutoRefresh(): void {
	if (dbHealthState._intervalId) return;
	dbHealthState.autoRefresh = true;
	dbHealthState._intervalId = setInterval(
		() => fetchHealthMetrics(),
		dbHealthState.refreshIntervalSec * 1000
	);
}

export function stopAutoRefresh(): void {
	if (dbHealthState._intervalId) {
		clearInterval(dbHealthState._intervalId);
		dbHealthState._intervalId = null;
	}
	dbHealthState.autoRefresh = false;
}

export function toggleAutoRefresh(): void {
	if (dbHealthState.autoRefresh) {
		stopAutoRefresh();
	} else {
		startAutoRefresh();
	}
}

export function setRefreshInterval(sec: number): void {
	dbHealthState.refreshIntervalSec = sec;
	if (dbHealthState.autoRefresh) {
		stopAutoRefresh();
		startAutoRefresh();
	}
}
