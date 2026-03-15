/**
 * Database Health Dashboard Types
 */

export interface DBHealthConnections {
	active: number;
	idle: number;
	waiting: number;
	/** Max allowed connections (null if unknown) */
	max: number | null;
}

export interface DBHealthTPS {
	/** Total commits since last poll */
	commits: number;
	/** Total rollbacks since last poll */
	rollbacks: number;
	/** Combined TPS (per-second rate computed from delta) */
	tps: number;
}

export interface DBHealthMemory {
	/** Used buffer/cache memory in MB */
	usedMb: number;
	/** Total allocated memory in MB (null if unknown) */
	totalMb: number | null;
	/** Buffer/page cache hit ratio 0–100 (null if unknown) */
	cacheHitRatio: number | null;
}

export interface DBHealthDisk {
	/** Database file / data size in MB */
	dbSizeMb: number;
}

export interface DBSlowQuery {
	query: string;
	/** Execution duration in milliseconds */
	durationMs: number;
	user?: string;
	database?: string;
	state?: string;
}

export interface DBHealthMetrics {
	timestamp: string;
	dbType: string;
	connections: DBHealthConnections;
	/** null for databases that don't expose TPS counters */
	tps: DBHealthTPS | null;
	/** null for databases that don't expose memory metrics */
	memory: DBHealthMemory | null;
	/** null for non-file databases */
	disk: DBHealthDisk | null;
	/** Queries currently running above the slow-query threshold */
	slowQueries: DBSlowQuery[];
}

export interface DBHealthAlert {
	level: 'warning' | 'critical';
	metric: string;
	message: string;
}

/** Thresholds used to compute alerts */
export const HEALTH_THRESHOLDS = {
	connectionsPctWarning: 80,
	connectionsPctCritical: 95,
	cacheHitWarning: 90,
	cacheHitCritical: 70,
	slowQueryThresholdMs: 2000
} as const;
