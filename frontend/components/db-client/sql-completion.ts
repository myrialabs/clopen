/**
 * Wires the DB client's cached schema into the shared Monaco SQL autocomplete,
 * keeping `monaco-loader` free of any feature-store coupling.
 */
import {
	setSqlCompletionSource,
	type SqlCompletionSource
} from '$frontend/components/common/editor/monaco-loader';
import { dbClientStore } from '$frontend/stores/features/db-client.svelte';

let registered = false;

function buildSource(): SqlCompletionSource {
	const connId = dbClientStore.activeConnectionId;
	if (!connId) return { tables: [], columns: [] };

	const tables: SqlCompletionSource['tables'] = [];
	for (const node of dbClientStore.schema[connId] ?? []) {
		if (node.type === 'table') tables.push({ name: node.name, kind: 'table' });
		else if (node.type === 'view') tables.push({ name: node.name, kind: 'view' });
	}

	const columns: SqlCompletionSource['columns'] = [];
	const seen = new Set<string>();
	for (const [key, details] of Object.entries(dbClientStore.objectDetails)) {
		if (!key.startsWith(`${connId}::`) || !details?.columns) continue;
		for (const col of details.columns) {
			if (seen.has(col.name)) continue;
			seen.add(col.name);
			columns.push({ name: col.name, type: col.type });
		}
	}

	return { tables, columns };
}

/** Idempotently register the DB-client schema as the SQL completion source. */
export function ensureSqlCompletion(): void {
	if (registered) return;
	registered = true;
	setSqlCompletionSource(buildSource);
}
