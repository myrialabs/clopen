<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		dbSqlEditorState,
		generateSqlFromNl,
		explainQueryWithAi,
		clearAiState
	} from '$frontend/stores/features/db-sql-editor.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';

	interface Props {
		connectionId: string | null;
		currentSql: string;
		onInsertSql: (sql: string) => void;
	}

	const { connectionId, currentSql, onInsertSql }: Props = $props();

	const MODELS = [
		{ id: 'claude-code:haiku', label: 'Haiku 4.5 (Fast)' },
		{ id: 'claude-code:sonnet', label: 'Sonnet 4.6 (Balanced)' },
		{ id: 'claude-code:opus', label: 'Opus 4.6 (Powerful)' }
	] as const;

	const hasConnection = $derived(!!connectionId);
	const hasCurrentSql = $derived(!!currentSql.trim());

	async function handleGenerate() {
		if (!connectionId) return;
		await generateSqlFromNl(connectionId);
	}

	async function handleExplain() {
		if (!connectionId || !currentSql.trim()) return;
		await explainQueryWithAi(connectionId, currentSql);
	}

	function handleInsert() {
		if (dbSqlEditorState.aiGeneratedSql) {
			onInsertSql(dbSqlEditorState.aiGeneratedSql);
			addNotification({
				type: 'success',
				title: 'SQL inserted',
				message: 'Generated SQL loaded into editor',
				duration: 2500
			});
		}
	}

	async function handleCopy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			addNotification({ type: 'success', title: 'Copied', message: 'SQL copied to clipboard', duration: 2000 });
		} catch {
			// ignore
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
			e.preventDefault();
			if (hasConnection && !dbSqlEditorState.isGeneratingSql) handleGenerate();
		}
	}
</script>

<div class="flex flex-col h-full min-h-0 overflow-y-auto">
	<!-- Header: model selector -->
	<div class="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0 bg-slate-50 dark:bg-slate-900/30">
		<Icon name="lucide:sparkles" class="w-3.5 h-3.5 text-violet-500 shrink-0" />
		<span class="text-xs font-medium text-slate-600 dark:text-slate-400">AI SQL Assistant</span>
		<div class="flex-1"></div>
		<select
			bind:value={dbSqlEditorState.aiModel}
			class="text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded px-2 py-0.5 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-violet-500"
		>
			{#each MODELS as m}
				<option value={m.id}>{m.label}</option>
			{/each}
		</select>
		<button
			type="button"
			class="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
			onclick={clearAiState}
			title="Clear all AI results"
		>
			<Icon name="lucide:rotate-ccw" class="w-3 h-3" />
		</button>
	</div>

	<div class="flex flex-col gap-0 flex-1 min-h-0">
		<!-- ── Generate SQL section ─────────────────────────────────────────── -->
		<div class="px-3 pt-3 pb-2 shrink-0">
			<p class="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">
				Natural language → SQL
			</p>

			<!-- Prompt input -->
			<div class="relative" onkeydown={handleKeydown} role="none">
				<textarea
					bind:value={dbSqlEditorState.aiPrompt}
					placeholder={hasConnection
						? 'e.g. "Show me the 10 most recent orders with customer names"'
						: 'Connect to a database first'}
					disabled={!hasConnection || dbSqlEditorState.isGeneratingSql}
					rows={3}
					class="w-full text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md px-2.5 py-2 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 resize-none focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-50 disabled:cursor-not-allowed leading-relaxed"
				></textarea>
			</div>

			<div class="flex items-center gap-2 mt-1.5">
				<button
					type="button"
					onclick={handleGenerate}
					disabled={!hasConnection || !dbSqlEditorState.aiPrompt.trim() || dbSqlEditorState.isGeneratingSql}
					class="flex items-center gap-1.5 px-3 py-1 bg-violet-600 hover:bg-violet-700 disabled:bg-violet-600/40 disabled:cursor-not-allowed rounded text-xs font-medium text-white transition-colors"
				>
					{#if dbSqlEditorState.isGeneratingSql}
						<svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
						Generating...
					{:else}
						<Icon name="lucide:wand" class="w-3 h-3" />
						Generate SQL
					{/if}
				</button>
				<span class="text-xs text-slate-400 dark:text-slate-600">Ctrl+Enter</span>
			</div>
		</div>

		<!-- Generated SQL output -->
		{#if dbSqlEditorState.aiGeneratedSql}
			<div class="mx-3 mb-3 rounded-md border border-violet-200 dark:border-violet-800/50 bg-violet-50 dark:bg-violet-950/20 shrink-0">
				<!-- SQL code block -->
				<div class="relative">
					<pre class="text-xs font-mono text-slate-800 dark:text-slate-200 px-3 pt-2.5 pb-1.5 leading-relaxed overflow-x-auto whitespace-pre-wrap break-all">{dbSqlEditorState.aiGeneratedSql}</pre>
					<div class="flex items-center gap-1 px-2 pb-1.5">
						<button
							type="button"
							onclick={handleInsert}
							class="flex items-center gap-1 px-2 py-0.5 rounded bg-violet-600 hover:bg-violet-700 text-white text-xs font-medium transition-colors"
							title="Load into SQL editor"
						>
							<Icon name="lucide:arrow-up-to-line" class="w-3 h-3" />
							Insert into editor
						</button>
						<button
							type="button"
							onclick={() => handleCopy(dbSqlEditorState.aiGeneratedSql!)}
							class="flex items-center gap-1 px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs font-medium transition-colors"
							title="Copy SQL"
						>
							<Icon name="lucide:copy" class="w-3 h-3" />
							Copy
						</button>
					</div>
				</div>

				<!-- Brief explanation -->
				{#if dbSqlEditorState.aiGeneratedExplanation}
					<div class="border-t border-violet-200 dark:border-violet-800/40 px-3 py-2">
						<p class="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
							{dbSqlEditorState.aiGeneratedExplanation}
						</p>
					</div>
				{/if}
			</div>
		{/if}

		<!-- ── Divider ─────────────────────────────────────────────────────── -->
		<div class="border-t border-slate-200 dark:border-slate-800 mx-3 shrink-0"></div>

		<!-- ── Explain Query section ───────────────────────────────────────── -->
		<div class="px-3 pt-3 pb-2 shrink-0">
			<p class="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">
				Explain current query
			</p>
			<div class="flex items-center gap-2">
				<button
					type="button"
					onclick={handleExplain}
					disabled={!hasConnection || !hasCurrentSql || dbSqlEditorState.isExplainingWithAi}
					class="flex items-center gap-1.5 px-3 py-1 border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed rounded text-xs font-medium text-slate-600 dark:text-slate-300 transition-colors"
				>
					{#if dbSqlEditorState.isExplainingWithAi}
						<svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
						Explaining...
					{:else}
						<Icon name="lucide:book-open" class="w-3 h-3" />
						Explain query
					{/if}
				</button>
				{#if !hasCurrentSql}
					<span class="text-xs text-slate-400">Write a query in the editor first</span>
				{/if}
			</div>
		</div>

		<!-- Explanation output -->
		{#if dbSqlEditorState.aiExplainSummary}
			<div class="mx-3 mb-3 rounded-md border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50 dark:bg-emerald-950/20 px-3 py-2.5 shrink-0">
				<!-- Summary -->
				<p class="text-xs text-slate-700 dark:text-slate-300 leading-relaxed font-medium mb-2">
					{dbSqlEditorState.aiExplainSummary}
				</p>

				<!-- Steps -->
				{#if dbSqlEditorState.aiExplainSteps.length > 0}
					<ol class="flex flex-col gap-1">
						{#each dbSqlEditorState.aiExplainSteps as step, i}
							<li class="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
								<span class="shrink-0 w-4 h-4 rounded-full bg-emerald-200 dark:bg-emerald-800 text-emerald-800 dark:text-emerald-200 flex items-center justify-center text-[10px] font-bold mt-0.5">
									{i + 1}
								</span>
								<span>{step}</span>
							</li>
						{/each}
					</ol>
				{/if}
			</div>
		{/if}

		<!-- Error display -->
		{#if dbSqlEditorState.aiError && !dbSqlEditorState.isGeneratingSql && !dbSqlEditorState.isExplainingWithAi}
			<div class="mx-3 mb-3 rounded-md border border-red-200 dark:border-red-800/50 bg-red-50 dark:bg-red-950/20 px-3 py-2 shrink-0">
				<div class="flex items-start gap-2">
					<Icon name="lucide:circle-x" class="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
					<p class="text-xs text-red-700 dark:text-red-300 leading-relaxed">{dbSqlEditorState.aiError}</p>
				</div>
			</div>
		{/if}

		<!-- Empty state -->
		{#if !dbSqlEditorState.aiGeneratedSql && !dbSqlEditorState.aiExplainSummary && !dbSqlEditorState.aiError && !dbSqlEditorState.isGeneratingSql && !dbSqlEditorState.isExplainingWithAi}
			<div class="flex flex-col items-center justify-center flex-1 gap-2 text-slate-300 dark:text-slate-600 pb-6">
				<Icon name="lucide:bot" class="w-8 h-8 opacity-50" />
				<span class="text-xs">Describe what you want in plain English</span>
			</div>
		{/if}
	</div>
</div>
