<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { IDisposable, editor } from 'monaco-editor';
	import loader from '@monaco-editor/loader';
	import MonacoEditor from '$frontend/components/common/editor/MonacoEditor.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { registerSqlCompletion } from '$frontend/utils/sql-completion';
	import { dbSqlEditorState } from '$frontend/stores/features/db-sql-editor.svelte';
	import { dbUiState } from '$frontend/stores/features/db-manager.svelte';

	interface Props {
		value: string;
		language: string;
		disabled?: boolean;
		isRunning?: boolean;
		isExplaining?: boolean;
		showExplain?: boolean;
		onRun: () => void;
		onExplain?: () => void;
	}

	let {
		value = $bindable(''),
		language,
		disabled = false,
		isRunning = false,
		isExplaining = false,
		showExplain = false,
		onRun,
		onExplain
	}: Props = $props();

	let completionDisposable: IDisposable | null = null;
	// Reference to the inner MonacoEditor instance — used for imperative setValue / focus calls
	let monacoEditorRef: { setValue: (v: string) => void; focus: () => void } | undefined = $state();

	/**
	 * Directly set the Monaco editor value without relying on the reactive binding chain.
	 * Called by QueryPanel when inserting/running a snippet so the editor visually updates immediately.
	 */
	export function forceSetValue(sql: string): void {
		value = sql;
		monacoEditorRef?.setValue(sql);
	}

	/** Focus the Monaco editor — called after connection/tab switches to restore cursor. */
	export function focusEditor(): void {
		monacoEditorRef?.focus();
	}

	/**
	 * Override Monaco's built-in Cmd+P binding so Quick Table Search opens instead of
	 * Monaco's "Go to Symbol" overlay. The DOM keydown event no longer propagates once
	 * Monaco handles a command, so we set dbUiState directly from here.
	 */
	async function handleEditorMount(editorInstance: editor.IStandaloneCodeEditor) {
		const monaco = await loader.init();
		// Override Cmd+P → Quick Table Search (instead of Monaco's "Go to Symbol")
		editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => {
			dbUiState.showQuickSearch = true;
		});
		// Override Cmd+Enter → Execute query (instead of Monaco's "Insert Line Below")
		editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
			if (!disabled && !isRunning) onRun();
		});
		// Cmd+Shift+Enter → Explain query
		editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => {
			if (showExplain && onExplain && !isExplaining) onExplain();
		});
	}

	function handleKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
			e.preventDefault();
			if (!disabled && !isRunning) onRun();
		}
	}

	onMount(async () => {
		// loader.init() returns the cached monaco instance if already loaded
		const monaco = await loader.init();
		completionDisposable = registerSqlCompletion(monaco, () => dbSqlEditorState.schemaCache);
	});

	onDestroy(() => {
		completionDisposable?.dispose();
	});
</script>

<div class="flex flex-col h-full" onkeydown={handleKeydown} role="none">
	<!-- Editor area -->
	<div class="flex-1 min-h-0">
		<MonacoEditor
			bind:this={monacoEditorRef}
			bind:value
			{language}
			height="100%"
			options={{
				lineNumbers: 'off',
				minimap: { enabled: false },
				scrollBeyondLastLine: false,
				padding: { top: 8, bottom: 8 }
			}}
			onEditorMount={handleEditorMount}
		/>
	</div>

	<!-- Toolbar (SQL only) -->
	{#if language === 'sql'}
		<div class="flex items-center gap-1 px-2 py-1 border-t border-slate-200 dark:border-slate-800 shrink-0 bg-slate-50 dark:bg-slate-900/50">
			<button
				type="button"
				class="flex items-center gap-1.5 px-3 py-1 bg-violet-600 hover:bg-violet-700 disabled:bg-violet-600/50 rounded text-xs font-medium text-white transition-all disabled:cursor-not-allowed"
				onclick={onRun}
				disabled={disabled || isRunning}
				title="Run query (Ctrl+Enter)"
			>
				{#if isRunning}
					<svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
					</svg>
					Running...
				{:else}
					<Icon name="lucide:play" class="w-3 h-3" />
					Run
				{/if}
			</button>

			{#if showExplain}
				<button
					type="button"
					class="flex items-center gap-1.5 px-3 py-1 border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 rounded text-xs font-medium text-slate-600 dark:text-slate-300 transition-all disabled:cursor-not-allowed"
					onclick={onExplain}
					disabled={disabled || isExplaining}
					title="Explain query execution plan"
				>
					{#if isExplaining}
						<svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
						Analyzing...
					{:else}
						<Icon name="lucide:zap" class="w-3 h-3" />
						Explain
					{/if}
				</button>
			{/if}
		</div>
	{/if}
</div>
