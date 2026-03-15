/**
 * Data Generator Store — Svelte 5 Runes
 *
 * Manages state for the database data seeding modal.
 * Sends batched generation requests to the backend until the desired
 * row count is reached, streaming progress back to the UI.
 */

import ws from '$frontend/utils/ws';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import type {
	DataGenColumnConfig,
	DataGenColumnInfo,
	FakerStrategy
} from '$shared/types/data-generator';

// ─── State ────────────────────────────────────────────────────────────────────

export const datagenState = $state({
	isOpen: false,
	isInspecting: false,
	isGenerating: false,

	connectionId: '',
	tableName: '',
	schema: undefined as string | undefined,

	/** Enriched column info fetched from the server */
	columnInfos: [] as DataGenColumnInfo[],
	/** User-editable per-column configs (derived from columnInfos + user edits) */
	columnConfigs: [] as DataGenColumnConfig[],

	rowCount: 100,
	batchSize: 500,

	// Progress
	insertedTotal: 0,
	failedTotal: 0,
	progressPct: 0,
	errors: [] as string[]
});

// ─── Open / Close ─────────────────────────────────────────────────────────────

export async function openDatagen(
	connectionId: string,
	tableName: string,
	schema?: string
): Promise<void> {
	datagenState.isOpen = true;
	datagenState.connectionId = connectionId;
	datagenState.tableName = tableName;
	datagenState.schema = schema;
	datagenState.columnInfos = [];
	datagenState.columnConfigs = [];
	datagenState.insertedTotal = 0;
	datagenState.failedTotal = 0;
	datagenState.progressPct = 0;
	datagenState.errors = [];

	await inspectTable();
}

export function closeDatagen(): void {
	if (datagenState.isGenerating) return;
	datagenState.isOpen = false;
}

// ─── Inspect ──────────────────────────────────────────────────────────────────

async function inspectTable(): Promise<void> {
	datagenState.isInspecting = true;
	try {
		const raw = await ws.http('db:datagen:schema', {
			connectionId: datagenState.connectionId,
			tableName: datagenState.tableName,
			schema: datagenState.schema
		});

		datagenState.columnInfos = raw as DataGenColumnInfo[];
		// Build default configs from suggestions
		datagenState.columnConfigs = datagenState.columnInfos.map(
			(info): DataGenColumnConfig => ({
				columnName: info.columnName,
				strategy: info.suggestedStrategy as FakerStrategy,
				options:
					info.suggestedStrategy === 'integer'
						? { min: 1, max: 1_000_000 }
						: info.suggestedStrategy === 'float'
							? { min: 0, max: 1000, decimals: 2 }
							: undefined,
				fkTable: info.fkTable,
				fkColumn: info.fkColumn,
				skip: info.autoIncrement
			})
		);
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'Data Generator',
			message: err instanceof Error ? err.message : 'Failed to inspect table',
			duration: 4000
		});
		datagenState.isOpen = false;
	} finally {
		datagenState.isInspecting = false;
	}
}

// ─── Generation ───────────────────────────────────────────────────────────────

export async function startGeneration(): Promise<void> {
	if (datagenState.isGenerating) return;

	datagenState.isGenerating = true;
	datagenState.insertedTotal = 0;
	datagenState.failedTotal = 0;
	datagenState.progressPct = 0;
	datagenState.errors = [];

	const { connectionId, tableName, schema, columnConfigs, rowCount, batchSize } = datagenState;
	let offset = 0;
	let done = false;

	try {
		while (!done) {
			const result = await ws.http('db:datagen:batch', {
				connectionId,
				tableName,
				schema,
				columnConfigs,
				batchSize,
				batchOffset: offset,
				totalRows: rowCount
			});

			datagenState.insertedTotal += result.inserted;
			datagenState.failedTotal += result.failed;

			for (const e of result.errors) {
				if (datagenState.errors.length < 10) {
					datagenState.errors = [...datagenState.errors, e];
				}
			}

			offset += result.inserted + result.failed;
			datagenState.progressPct = Math.min(100, Math.round((offset / rowCount) * 100));
			done = result.done || offset >= rowCount;

			if (datagenState.failedTotal > 0 && datagenState.insertedTotal === 0) {
				// All rows failed — abort early
				break;
			}
		}

		if (datagenState.failedTotal === 0) {
			addNotification({
				type: 'success',
				title: 'Data Generated',
				message: `${datagenState.insertedTotal.toLocaleString()} rows inserted into "${tableName}"`,
				duration: 4000
			});
			datagenState.isOpen = false;
		} else {
			addNotification({
				type: 'error',
				title: 'Generation Partial',
				message: `${datagenState.insertedTotal.toLocaleString()} inserted, ${datagenState.failedTotal.toLocaleString()} failed`,
				duration: 6000
			});
		}
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'Data Generator Failed',
			message: err instanceof Error ? err.message : 'Generation failed',
			duration: 5000
		});
	} finally {
		datagenState.isGenerating = false;
	}
}

// ─── Column config helpers ────────────────────────────────────────────────────

export function setColumnStrategy(columnName: string, strategy: FakerStrategy): void {
	datagenState.columnConfigs = datagenState.columnConfigs.map((c) =>
		c.columnName === columnName ? { ...c, strategy } : c
	);
}

export function setColumnSkip(columnName: string, skip: boolean): void {
	datagenState.columnConfigs = datagenState.columnConfigs.map((c) =>
		c.columnName === columnName ? { ...c, skip } : c
	);
}

export function setColumnOptions(
	columnName: string,
	options: DataGenColumnConfig['options']
): void {
	datagenState.columnConfigs = datagenState.columnConfigs.map((c) =>
		c.columnName === columnName ? { ...c, options } : c
	);
}
