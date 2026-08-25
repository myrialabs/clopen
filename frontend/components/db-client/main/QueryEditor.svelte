<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import MonacoCodeEditor from '$frontend/components/common/editor/MonacoCodeEditor.svelte';
	import ConfirmDestructive from '../shared/ConfirmDestructive.svelte';
	import ResultPanel from './ResultPanel.svelte';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';
	import { debug } from '$shared/utils/logger';
	import { classifyQuery, languageForDriver, type QueryClass } from './classify';
	import { splitSqlStatements } from '$shared/utils/db-client/split-sql';
	import type { DbDriver } from '$shared/types/db-client';

	const SQL_DRIVERS: DbDriver[] = ['mysql', 'postgres', 'sqlite', 'mssql'];

	interface Props {
		connectionId: string;
		driver: DbDriver;
		database?: string;
	}

	const { connectionId, driver, database }: Props = $props();

	const view = $derived(dbClientStore.getView(connectionId));
	const queryText = $derived(view.query.text ?? '');
	const result = $derived(view.query.result ?? null);
	const errorMsg = $derived(view.query.error ?? null);
	const running = $derived(view.query.running ?? false);

	let confirmOpen = $state(false);
	let pendingClass = $state<QueryClass>('unknown');
	let pendingBatch = $state(false);
	let confirmClearOpen = $state(false);
	let forceSyncTick = $state(0);
	let queryToExecute = $state('');
	let pendingStatementsCount = $state(0);
	let editorComponent = $state<any>(null);

	let editorRatio = $state(0.35);
	let containerEl = $state<HTMLDivElement | null>(null);
	let isDragging = $state(false);

	const language = $derived(languageForDriver(driver));
	const classification = $derived(classifyQuery(driver, queryText));

	// Only SQL drivers split on `;`; Mongo/Redis payloads are always single.
	// SQL Server additionally separates batch-sensitive DDL by blank lines.
	const statements = $derived(
		SQL_DRIVERS.includes(driver)
			? splitSqlStatements(queryText, { splitOnBlankLine: driver === 'mssql' })
			: [queryText.trim()].filter(Boolean)
	);
	const isMultiStatement = $derived(statements.length > 1);
	const batchHasDestructive = $derived(
		statements.some((s) => {
			const c = classifyQuery(driver, s);
			return c === 'write' || c === 'ddl';
		})
	);

	function onChange(value: string): void {
		dbClientStore.setQueryText(connectionId, value);
	}

	async function runRead(query: string): Promise<void> {
		const q = query.trim();
		if (!q) return;
		dbClientStore.setQueryRunning(connectionId, true);
		dbClientStore.setQueryError(connectionId, null);
		try {
			const out = await dbClientStore.executeRead(connectionId, q, { database });
			dbClientStore.setQueryResult(connectionId, out);
			dbClientStore.setQueryError(connectionId, null);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			dbClientStore.setQueryResult(connectionId, null);
			dbClientStore.setQueryError(connectionId, msg);
		} finally {
			dbClientStore.setQueryRunning(connectionId, false);
		}
	}

	async function runWrite(query: string): Promise<void> {
		const q = query.trim();
		if (!q) return;
		dbClientStore.setQueryRunning(connectionId, true);
		dbClientStore.setQueryError(connectionId, null);
		try {
			const out = await dbClientStore.executeWrite(connectionId, q, { database });
			dbClientStore.setQueryResult(connectionId, out);
			dbClientStore.setQueryError(connectionId, null);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			dbClientStore.setQueryResult(connectionId, null);
			dbClientStore.setQueryError(connectionId, msg);
		} finally {
			dbClientStore.setQueryRunning(connectionId, false);
		}
	}

	async function runBatch(query: string): Promise<void> {
		const q = query.trim();
		if (!q) return;
		dbClientStore.setQueryRunning(connectionId, true);
		dbClientStore.setQueryError(connectionId, null);
		try {
			const out = await dbClientStore.executeBatch(connectionId, q, { database });
			dbClientStore.setQueryResult(connectionId, out);
			dbClientStore.setQueryError(connectionId, null);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			dbClientStore.setQueryResult(connectionId, null);
			dbClientStore.setQueryError(connectionId, msg);
		} finally {
			dbClientStore.setQueryRunning(connectionId, false);
		}
	}

	function run(): void {
		let query = queryText;
		if (editorComponent) {
			const editor = editorComponent.getEditor();
			if (editor) {
				const selection = editor.getSelection();
				if (selection) {
					const selected = editor.getModel()?.getValueInRange(selection);
					if (selected && selected.trim()) {
						query = selected;
					}
				}
			}
		}

		const trimmedQuery = query.trim();
		if (!trimmedQuery) return;

		const currentStatements = SQL_DRIVERS.includes(driver)
			? splitSqlStatements(query, { splitOnBlankLine: driver === 'mssql' })
			: [trimmedQuery].filter(Boolean);

		const currentIsMulti = currentStatements.length > 1;
		const currentClass = classifyQuery(driver, query);

		pendingBatch = currentIsMulti;
		pendingClass = currentClass;
		pendingStatementsCount = currentStatements.length;

		if (currentIsMulti) {
			const hasDestructive = currentStatements.some((s) => {
				const c = classifyQuery(driver, s);
				return c === 'write' || c === 'ddl';
			});
			if (hasDestructive) {
				pendingClass = currentStatements.some((s) => classifyQuery(driver, s) === 'ddl') ? 'ddl' : 'write';
				queryToExecute = query;
				confirmOpen = true;
				return;
			}
			runBatch(query);
			return;
		}

		if (currentClass === 'write' || currentClass === 'ddl') {
			queryToExecute = query;
			confirmOpen = true;
			return;
		}

		runRead(query);
	}

	function confirmRun(): void {
		if (pendingBatch) {
			runBatch(queryToExecute);
			return;
		}
		if (pendingClass === 'read') runRead(queryToExecute);
		else runWrite(queryToExecute);
	}

	async function cancel(): Promise<void> {
		try {
			await dbClientStore.cancel(connectionId);
		} catch (e) {
			debug.warn('db-client', 'cancel failed:', e);
		}
		dbClientStore.setQueryRunning(connectionId, false);
	}

	function clearEditor(): void {
		dbClientStore.setQueryText(connectionId, '');
		dbClientStore.setQueryResult(connectionId, null);
		dbClientStore.setQueryError(connectionId, null);
		forceSyncTick++;
	}

	function requestClear(): void {
		if (queryText.trim()) {
			confirmClearOpen = true;
		} else {
			clearEditor();
		}
	}

	function handleKeydown(e: KeyboardEvent): void {
		const meta = e.metaKey || e.ctrlKey;
		if (meta && e.key === 'Enter') {
			e.preventDefault();
			run();
		} else if (e.key === 'Escape' && running) {
			e.preventDefault();
			cancel();
		} else if (meta && (e.key === 'k' || e.key === 'K')) {
			e.preventDefault();
			requestClear();
		}
	}

	function startResize(e: PointerEvent): void {
		if (!containerEl) return;
		isDragging = true;
		(e.target as HTMLElement).setPointerCapture(e.pointerId);
		e.preventDefault();
	}

	function moveResize(e: PointerEvent): void {
		if (!isDragging || !containerEl) return;
		const rect = containerEl.getBoundingClientRect();
		const offset = e.clientY - rect.top;
		const ratio = offset / rect.height;
		editorRatio = Math.min(0.85, Math.max(0.15, ratio));
	}

	function endResize(e: PointerEvent): void {
		if (!isDragging) return;
		isDragging = false;
		(e.target as HTMLElement).releasePointerCapture(e.pointerId);
	}

	function resizeKey(e: KeyboardEvent): void {
		const step = 0.05;
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			editorRatio = Math.max(0.15, editorRatio - step);
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			editorRatio = Math.min(0.85, editorRatio + step);
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="flex flex-col h-full min-h-0">
	<div class="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0">
		{#if running}
			<button
				type="button"
				class="flex items-center gap-1 px-3 py-1 rounded-md bg-red-600 hover:bg-red-700 text-white text-xs font-semibold"
				onclick={cancel}
			>
				<Icon name="lucide:square" class="w-3.5 h-3.5" /> Cancel (Esc)
			</button>
		{:else}
			<button
				type="button"
				class="flex items-center gap-1 px-3 py-1 rounded-md bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold disabled:opacity-50"
				onclick={run}
				disabled={!queryText.trim()}
				title="Run (Cmd+Enter)"
			>
				<Icon name="lucide:play" class="w-3.5 h-3.5" /> Run
			</button>
		{/if}
		<button
			type="button"
			class="flex items-center gap-1 px-2 py-1 rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs"
			onclick={requestClear}
			title="Clear (Cmd+K)"
		>
			<Icon name="lucide:eraser" class="w-3.5 h-3.5" /> Clear
		</button>
		<div class="flex-1"></div>
		<span class="text-xs text-slate-500 dark:text-slate-400 shrink-0">{driver}</span>
	</div>

	<div bind:this={containerEl} class="flex-1 min-h-0 flex flex-col {isDragging ? 'select-none cursor-row-resize' : ''}">
		<div class="min-h-[80px] overflow-hidden flex flex-col" style="flex: {editorRatio} 1 0;">
			<MonacoCodeEditor
				bind:this={editorComponent}
				value={queryText}
				{language}
				path={"db-client/queries/default"}
				disableMouseWheelZoom={true}
				forceSync={forceSyncTick}
				{onChange}
			/>
		</div>
		<button
			type="button"
			aria-label="Resize editor and result"
			tabindex="0"
			class="shrink-0 relative z-10 flex items-center justify-center h-3 w-full cursor-row-resize transition-colors duration-150 focus:outline-none {isDragging ? 'bg-violet-500/10' : 'hover:bg-violet-500/5'}"
			onpointerdown={startResize}
			onpointermove={moveResize}
			onpointerup={endResize}
			onpointercancel={endResize}
			onkeydown={resizeKey}
		>
			<div class="h-0.5 w-12 rounded transition-all duration-150 {isDragging ? 'bg-violet-600 scale-110' : 'bg-violet-500/30'}"></div>
		</button>
		<div class="min-h-[80px] overflow-hidden flex flex-col" style="flex: {1 - editorRatio} 1 0;">
			<ResultPanel result={result} error={errorMsg} running={running} />
		</div>
	</div>
</div>

<ConfirmDestructive
	bind:isOpen={confirmOpen}
	title={pendingBatch
		? `Run ${pendingStatementsCount} statements?`
		: pendingClass === 'ddl'
			? 'Run DDL statement?'
			: 'Run write statement?'}
	message={pendingBatch
		? `This batch of ${pendingStatementsCount} statements includes ${pendingClass === 'ddl' ? 'schema (DDL)' : 'write'} operations that modify data.${SQL_DRIVERS.includes(driver) ? ' It runs in a transaction where supported (rolled back on failure).' : ''} Continue?`
		: `Classification: ${pendingClass}. This will modify data. Continue?`}
	confirmText="Run"
	onConfirm={confirmRun}
	onClose={() => (confirmOpen = false)}
/>

<ConfirmDestructive
	bind:isOpen={confirmClearOpen}
	title="Clear query?"
	message={`Clear the query editor? This cannot be undone.`}
	confirmText="Clear"
	onConfirm={() => { clearEditor(); confirmClearOpen = false; }}
	onClose={() => (confirmClearOpen = false)}
/>
