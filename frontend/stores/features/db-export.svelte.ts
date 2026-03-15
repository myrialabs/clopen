/**
 * Database Export & Import Store — Svelte 5 Runes
 *
 * Handles streaming export (CSV, JSON, SQL Dump) and batch import
 * with visual column mapping.
 */

import ws from '$frontend/utils/ws';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import type {
	ExportFormat,
	ExportOptions,
	ColumnMapping,
	ImportPreview,
	ImportBatchResult
} from '$shared/types/db-export';

// ─── State ────────────────────────────────────────────────────────────────────

export const dbExportState = $state({
	// Export
	isExportOpen: false,
	isExporting: false,
	exportProgress: 0, // 0–100
	exportTotal: 0,
	exportFetched: 0,
	exportFormat: 'csv' as ExportFormat,
	exportOptions: {
		includeHeaders: true,
		prettyPrint: false,
		includeCreateTable: true,
		batchSize: 2000
	} as Omit<ExportOptions, 'format' | 'batchSize'> & { batchSize: number },

	// Import
	isImportOpen: false,
	isImporting: false,
	importProgress: 0,
	importTotal: 0,
	importInserted: 0,
	importFailed: 0,
	importErrors: [] as string[],
	/** File parsed headers and sample rows */
	importPreview: null as ImportPreview | null,
	/** Visual column mapping (source → target) */
	columnMappings: [] as ColumnMapping[],
	importSkipErrors: true
});

// ─── Export Actions ───────────────────────────────────────────────────────────

export function openExport(): void {
	dbExportState.isExportOpen = true;
	dbExportState.exportProgress = 0;
	dbExportState.exportFetched = 0;
	dbExportState.exportTotal = 0;
}

export function closeExport(): void {
	if (dbExportState.isExporting) return;
	dbExportState.isExportOpen = false;
}

function triggerDownload(content: Uint8Array | string, filename: string, mimeType: string): void {
	const blob =
		typeof content === 'string'
			? new Blob([content], { type: mimeType })
			: new Blob([content.buffer as ArrayBuffer], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

function escapeCsv(v: unknown): string {
	if (v === null || v === undefined) return '';
	const s = String(v);
	if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
		return `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

function qIdentSql(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function formatSqlVal(v: unknown): string {
	if (v === null || v === undefined) return 'NULL';
	if (typeof v === 'boolean') return v ? '1' : '0';
	if (typeof v === 'number' || typeof v === 'bigint') return String(v);
	return `'${String(v).replace(/'/g, "''")}'`;
}

function rowsToInserts(
	rows: Record<string, unknown>[],
	tableName: string
): string {
	if (!rows.length) return '';
	const cols = Object.keys(rows[0]);
	const colList = cols.map(qIdentSql).join(', ');
	return (
		rows
			.map((row) => {
				const vals = cols.map((c) => formatSqlVal(row[c])).join(', ');
				return `INSERT INTO ${qIdentSql(tableName)} (${colList}) VALUES (${vals});`;
			})
			.join('\n') + '\n'
	);
}

/**
 * Stream-export all rows from the active table in the chosen format.
 * Fetches server-side in batches and assembles client-side.
 */
export async function startExport(
	connectionId: string,
	tableName: string,
	schema: string | undefined,
	format: ExportFormat
): Promise<void> {
	dbExportState.isExporting = true;
	dbExportState.exportProgress = 0;
	dbExportState.exportFetched = 0;

	const batchSize = dbExportState.exportOptions.batchSize;
	const date = new Date().toISOString().slice(0, 10);
	const baseFilename = `${tableName}_${date}`;

	// Accumulators
	const csvLines: string[] = [];
	const jsonRows: Record<string, unknown>[] = [];
	let sqlContent = '';
	let columns: string[] = [];
	let firstBatch = true;

	try {
		// For SQL format, fetch CREATE TABLE first
		if (format === 'sql') {
			const schemaResult = await ws.http('db:export:schema', {
				connectionId,
				tableName,
				schema
			});
			sqlContent = `-- Export: ${tableName} (${date})\n\n${schemaResult.sql}\n`;
		}

		let offset = 0;
		let done = false;

		while (!done) {
			const batch = await ws.http('db:export:batch', {
				connectionId,
				tableName,
				schema,
				offset,
				batchSize
			});

			if (firstBatch) {
				columns = batch.rows.length > 0 ? Object.keys(batch.rows[0]) : [];
				dbExportState.exportTotal = batch.total;
				firstBatch = false;
			}

			// Accumulate based on format
			if (format === 'csv') {
				if (offset === 0 && dbExportState.exportOptions.includeHeaders) {
					csvLines.push(columns.join(','));
				}
				for (const row of batch.rows) {
					csvLines.push(columns.map((c) => escapeCsv(row[c])).join(','));
				}
			} else if (format === 'json') {
				jsonRows.push(...batch.rows);
			} else {
				sqlContent += rowsToInserts(batch.rows, tableName);
			}

			offset += batch.rows.length;
			dbExportState.exportFetched = offset;
			dbExportState.exportProgress =
				batch.total > 0 ? Math.round((offset / batch.total) * 100) : 100;

			done = batch.done || batch.rows.length === 0;
		}

		// Trigger download
		if (format === 'csv') {
			triggerDownload(csvLines.join('\n'), `${baseFilename}.csv`, 'text/csv;charset=utf-8;');
		} else if (format === 'json') {
			const content = dbExportState.exportOptions.prettyPrint
				? JSON.stringify(jsonRows, null, 2)
				: JSON.stringify(jsonRows);
			triggerDownload(content, `${baseFilename}.json`, 'application/json');
		} else {
			triggerDownload(sqlContent + '\n-- End of export\n', `${baseFilename}.sql`, 'application/sql');
		}

		addNotification({
			type: 'success',
			title: 'Export Complete',
			message: `${dbExportState.exportFetched.toLocaleString()} rows exported as ${format.toUpperCase()}`,
			duration: 4000
		});
		dbExportState.isExportOpen = false;
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'Export Failed',
			message: err instanceof Error ? err.message : 'Export failed',
			duration: 5000
		});
	} finally {
		dbExportState.isExporting = false;
	}
}

// ─── Import Actions ───────────────────────────────────────────────────────────

export function openImport(): void {
	dbExportState.isImportOpen = true;
	dbExportState.importPreview = null;
	dbExportState.columnMappings = [];
	dbExportState.importProgress = 0;
	dbExportState.importInserted = 0;
	dbExportState.importFailed = 0;
	dbExportState.importErrors = [];
	dbExportState.importTotal = 0;
}

export function closeImport(): void {
	if (dbExportState.isImporting) return;
	dbExportState.isImportOpen = false;
}

function parseCsvLine(line: string): string[] {
	const result: string[] = [];
	let current = '';
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') {
			if (inQuotes && line[i + 1] === '"') {
				current += '"';
				i++;
			} else {
				inQuotes = !inQuotes;
			}
		} else if (ch === ',' && !inQuotes) {
			result.push(current);
			current = '';
		} else {
			current += ch;
		}
	}
	result.push(current);
	return result;
}

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
	const lines = text.trim().split('\n');
	if (lines.length < 1) return { headers: [], rows: [] };
	const headers = parseCsvLine(lines[0]);
	const rows = lines.slice(1).map((line) => {
		const values = parseCsvLine(line);
		const row: Record<string, string> = {};
		headers.forEach((h, i) => {
			row[h] = values[i] ?? '';
		});
		return row;
	});
	return { headers, rows };
}

/**
 * Parse a file client-side to extract headers and sample rows.
 * For SQL files, skip mapping and go straight to import.
 */
export async function previewImportFile(
	file: File,
	tableColumns: string[]
): Promise<'preview-ready' | 'sql-file'> {
	const ext = file.name.split('.').pop()?.toLowerCase();

	if (ext === 'sql') {
		// SQL files are executed directly — no mapping needed
		return 'sql-file';
	}

	const text = await file.text();
	let headers: string[] = [];
	let sampleRows: Record<string, string>[] = [];

	if (ext === 'csv') {
		const parsed = parseCsv(text);
		headers = parsed.headers;
		sampleRows = parsed.rows.slice(0, 5);
	} else if (ext === 'json') {
		const parsed = JSON.parse(text);
		const arr: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : [parsed];
		if (arr.length > 0) {
			headers = Object.keys(arr[0]);
			sampleRows = arr.slice(0, 5).map((r) =>
				Object.fromEntries(
					Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])
				)
			);
		}
	} else {
		throw new Error('Unsupported format. Use .csv, .json, or .sql');
	}

	dbExportState.importPreview = { headers, sampleRows, format: ext as 'csv' | 'json' };

	// Auto-match: exact name match (case-insensitive)
	dbExportState.columnMappings = headers.map((src) => {
		const match = tableColumns.find((t) => t.toLowerCase() === src.toLowerCase());
		return { sourceColumn: src, targetColumn: match ?? null };
	});

	return 'preview-ready';
}

/**
 * Stream-import rows from a file using the current column mappings.
 * Sends batches of rows to the server.
 */
export async function startImport(
	file: File,
	connectionId: string,
	tableName: string,
	schema: string | undefined
): Promise<void> {
	dbExportState.isImporting = true;
	dbExportState.importProgress = 0;
	dbExportState.importInserted = 0;
	dbExportState.importFailed = 0;
	dbExportState.importErrors = [];

	const ext = file.name.split('.').pop()?.toLowerCase();

	try {
		const text = await file.text();

		// SQL file: execute directly via the query endpoint
		if (ext === 'sql') {
			const { default: wsClient } = await import('$frontend/utils/ws');
			const result = await wsClient.http('db:query:execute', {
				connectionId,
				sql: text
			});
			if (result.error) {
				addNotification({ type: 'error', title: 'SQL Import Failed', message: result.error, duration: 6000 });
			} else {
				addNotification({
					type: 'success',
					title: 'SQL Import Complete',
					message: 'SQL file executed successfully',
					duration: 3000
				});
				dbExportState.isImportOpen = false;
			}
			return;
		}

		// Parse all rows from file
		let allRows: Record<string, unknown>[] = [];
		if (ext === 'csv') {
			const { rows } = parseCsv(text);
			allRows = rows;
		} else if (ext === 'json') {
			const parsed = JSON.parse(text);
			allRows = Array.isArray(parsed) ? parsed : [parsed];
		} else {
			throw new Error('Unsupported format. Use .csv, .json, or .sql');
		}

		if (!allRows.length) {
			addNotification({ type: 'error', title: 'Import Failed', message: 'No rows found in file', duration: 4000 });
			return;
		}

		dbExportState.importTotal = allRows.length;
		const batchSize = 200;
		const mappings = dbExportState.columnMappings;
		let inserted = 0;
		let failed = 0;
		const errors: string[] = [];

		for (let i = 0; i < allRows.length; i += batchSize) {
			const batch = allRows.slice(i, i + batchSize);
			const result: ImportBatchResult = await ws.http('db:import:batch', {
				connectionId,
				tableName,
				schema,
				rows: batch,
				mappings,
				skipErrors: dbExportState.importSkipErrors
			});

			inserted += result.inserted;
			failed += result.failed;
			for (const e of result.errors) {
				if (errors.length < 20) errors.push(e);
			}

			dbExportState.importInserted = inserted;
			dbExportState.importFailed = failed;
			dbExportState.importErrors = errors;
			dbExportState.importProgress = Math.round(((i + batch.length) / allRows.length) * 100);

			// Stop if errors and skip-errors is disabled
			if (!dbExportState.importSkipErrors && failed > 0) break;
		}

		if (failed === 0) {
			addNotification({
				type: 'success',
				title: 'Import Complete',
				message: `${inserted.toLocaleString()} rows imported`,
				duration: 4000
			});
			dbExportState.isImportOpen = false;
		} else {
			addNotification({
				type: 'error',
				title: 'Import Partial',
				message: `${inserted.toLocaleString()} inserted, ${failed.toLocaleString()} failed`,
				duration: 6000
			});
		}
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'Import Failed',
			message: err instanceof Error ? err.message : 'Import failed',
			duration: 5000
		});
	} finally {
		dbExportState.isImporting = false;
	}
}
