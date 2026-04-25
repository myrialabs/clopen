/**
 * Shared helpers for the MySQL + PostgreSQL adapters built on Bun.sql.
 *
 * Per the PHASE 0 findings, Bun.sql returns an array of row objects with
 * extra meta props attached (`.count`, `.command`, `.lastInsertRowid`,
 * `.affectedRows`). This module normalizes that shape into the
 * driver-agnostic `DbClientQueryResult`.
 */

import type { DbClientQueryResult } from '$shared/types/db-client';

interface BunSqlResultMeta {
	count?: number;
	command?: string;
	lastInsertRowid?: number | bigint;
	affectedRows?: number;
}

export function normalizeBunSqlResult(
	raw: unknown,
	durationMs: number
): DbClientQueryResult {
	const rows = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
	const meta = (raw ?? {}) as BunSqlResultMeta;

	const columns = rows.length > 0
		? Object.keys(rows[0]).map((name) => ({ name, type: null as string | null }))
		: [];

	return {
		columns,
		rows,
		rowCount: typeof meta.count === 'number' ? meta.count : rows.length,
		affectedRows: typeof meta.affectedRows === 'number' ? meta.affectedRows : null,
		durationMs,
		driverMeta: {
			command: meta.command ?? null,
			lastInsertRowid: meta.lastInsertRowid?.toString() ?? null
		}
	};
}
