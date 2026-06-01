<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import MonacoCodeEditor from '$frontend/components/common/editor/MonacoCodeEditor.svelte';
	import ConfirmDestructive from '../shared/ConfirmDestructive.svelte';
	import ResultPanel from './ResultPanel.svelte';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';
	import { debug } from '$shared/utils/logger';
	import { classifyQuery, languageForDriver, type QueryClass } from './classify';
	import type { DbDriver } from '$shared/types/db-client';

	interface Props {
		connectionId: string;
		driver: DbDriver;
		database?: string;
	}

	const { connectionId, driver, database }: Props = $props();

	const view = $derived(dbClientStore.getView(connectionId));
	const queryText = $derived(view.query.text);
	const result = $derived(view.query.result);
	const errorMsg = $derived(view.query.error);
	const running = $derived(view.query.running);

	let confirmOpen = $state(false);
	let pendingClass = $state<QueryClass>('unknown');

	let editorRatio = $state(0.35);
	let containerEl = $state<HTMLDivElement | null>(null);
	let isDragging = $state(false);

	const language = $derived(languageForDriver(driver));
	const classification = $derived(classifyQuery(driver, queryText));

	function onChange(value: string): void {
		dbClientStore.setQueryText(connectionId, value);
	}

	async function runRead(): Promise<void> {
		const query = queryText.trim();
		if (!query) return;
		dbClientStore.setQueryRunning(connectionId, true);
		dbClientStore.setQueryError(connectionId, null);
		try {
			const out = await dbClientStore.executeRead(connectionId, query, { database });
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

	async function runWrite(): Promise<void> {
		const query = queryText.trim();
		if (!query) return;
		dbClientStore.setQueryRunning(connectionId, true);
		dbClientStore.setQueryError(connectionId, null);
		try {
			const out = await dbClientStore.executeWrite(connectionId, query, { database });
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
		const c = classification;
		pendingClass = c;
		if (c === 'write' || c === 'ddl') {
			confirmOpen = true;
			return;
		}
		runRead();
	}

	function confirmRun(): void {
		if (pendingClass === 'read') runRead();
		else runWrite();
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
			clearEditor();
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
			onclick={clearEditor}
			title="Clear (Cmd+K)"
		>
			<Icon name="lucide:eraser" class="w-3.5 h-3.5" /> Clear
		</button>
		<div class="flex-1"></div>
		<span class="text-[10px] text-slate-400">{driver}</span>
	</div>

	<div bind:this={containerEl} class="flex-1 min-h-0 flex flex-col {isDragging ? 'select-none cursor-row-resize' : ''}">
		<div class="min-h-[80px] overflow-hidden" style="flex: {editorRatio} 1 0;">
			<MonacoCodeEditor
				value={queryText}
				{language}
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
	title={pendingClass === 'ddl' ? 'Run DDL statement?' : 'Run write statement?'}
	message={`Classification: ${pendingClass}. This will modify data. Continue?`}
	confirmText="Run"
	onConfirm={confirmRun}
	onClose={() => (confirmOpen = false)}
/>
