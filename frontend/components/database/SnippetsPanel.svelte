<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import SnippetFormModal from './SnippetFormModal.svelte';
	import SnippetPreviewModal from './SnippetPreviewModal.svelte';
	import {
		dbSnippetsState,
		fetchSnippets,
		openPreview,
		openForm,
		getAllTags,
		getFilteredSnippets
	} from '$frontend/stores/features/db-sql-snippets.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import ws from '$frontend/utils/ws';

	interface Props {
		onInsert: (sql: string) => void;
		onRun: (sql: string) => void;
	}

	let { onInsert, onRun }: Props = $props();

	const filtered = $derived(getFilteredSnippets());
	const allTags = $derived(getAllTags());

	onMount(async () => {
		await fetchSnippets();
		// Handle share link: #snippet/<token>
		const hash = window.location.hash;
		if (hash.startsWith('#snippet/')) {
			const token = hash.slice('#snippet/'.length);
			if (token) {
				try {
					const snippet = await ws.http('db:snippets:get-by-token', { token });
					if (snippet) {
						openPreview(snippet);
						// Clear hash without triggering navigation
						history.replaceState(null, '', window.location.pathname + window.location.search);
					}
				} catch {
					// Non-fatal — ignore invalid tokens
				}
			}
		}
	});

	function formatDate(dateStr: string): string {
		return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}
</script>

<div class="flex flex-col h-full min-h-0">
	<!-- Toolbar -->
	<div class="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0">
		<!-- Search -->
		<div class="relative flex-1">
			<Icon name="lucide:search" class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
			<input
				type="text"
				bind:value={dbSnippetsState.search}
				placeholder="Search snippets…"
				class="w-full pl-7 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-700 dark:text-slate-300 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
			/>
		</div>
		<!-- New snippet button -->
		<button
			type="button"
			class="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-violet-600 hover:bg-violet-700 text-white text-xs font-medium transition-colors shrink-0"
			onclick={() => openForm()}
		>
			<Icon name="lucide:plus" class="w-3.5 h-3.5" />
			New
		</button>
		<!-- Refresh -->
		<button
			type="button"
			class="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
			onclick={fetchSnippets}
			title="Refresh snippets"
		>
			<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5 {dbSnippetsState.isLoading ? 'animate-spin' : ''}" />
		</button>
	</div>

	<!-- Tag filter -->
	{#if allTags.length > 0}
		<div class="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-100 dark:border-slate-800/50 shrink-0 overflow-x-auto">
			<button
				type="button"
				class="px-2 py-0.5 rounded-full text-xs font-medium transition-colors shrink-0
					{dbSnippetsState.activeTag === null
						? 'bg-violet-600 text-white'
						: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-violet-50 dark:hover:bg-violet-900/30'}"
				onclick={() => (dbSnippetsState.activeTag = null)}
			>
				All
			</button>
			{#each allTags as tag}
				<button
					type="button"
					class="px-2 py-0.5 rounded-full text-xs font-medium transition-colors shrink-0
						{dbSnippetsState.activeTag === tag
							? 'bg-violet-600 text-white'
							: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-violet-50 dark:hover:bg-violet-900/30'}"
					onclick={() => (dbSnippetsState.activeTag = dbSnippetsState.activeTag === tag ? null : tag)}
				>
					{tag}
				</button>
			{/each}
		</div>
	{/if}

	<!-- Snippet list -->
	<div class="flex-1 min-h-0 overflow-y-auto">
		{#if dbSnippetsState.isLoading}
			<div class="flex items-center justify-center h-24 gap-2 text-slate-400 text-xs">
				<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
				</svg>
				Loading snippets…
			</div>
		{:else if filtered.length === 0}
			<div class="flex flex-col items-center justify-center h-32 gap-2 text-slate-400 text-xs">
				<Icon name="lucide:bookmark" class="w-6 h-6 opacity-30" />
				<span>
					{dbSnippetsState.search || dbSnippetsState.activeTag ? 'No snippets match your filter' : 'No snippets yet'}
				</span>
				{#if !dbSnippetsState.search && !dbSnippetsState.activeTag}
					<button
						type="button"
						class="text-violet-500 hover:text-violet-600 transition-colors"
						onclick={() => openForm()}
					>
						Save your first snippet
					</button>
				{/if}
			</div>
		{:else}
			{#each filtered as snippet (snippet.id)}
				<div
					class="w-full text-left px-3 py-2.5 hover:bg-violet-50 dark:hover:bg-violet-900/20 border-b border-slate-100 dark:border-slate-800/50 transition-colors group cursor-pointer"
					role="button"
					tabindex="0"
					onclick={() => openPreview(snippet)}
					onkeydown={(e) => e.key === 'Enter' && openPreview(snippet)}
				>
					<div class="flex items-start gap-2">
						<!-- Icon -->
						<div class="mt-0.5 shrink-0 text-violet-400 dark:text-violet-500">
							{#if snippet.isPublic}
								<Icon name="lucide:users" class="w-3.5 h-3.5" />
							{:else}
								<Icon name="lucide:lock" class="w-3.5 h-3.5" />
							{/if}
						</div>

						<div class="flex-1 min-w-0">
							<!-- Title row -->
							<div class="flex items-center gap-2">
								<span class="text-xs font-medium text-slate-800 dark:text-slate-100 truncate">
									{snippet.title}
								</span>
								{#if snippet.shareToken}
									<span title="Has share link"><Icon name="lucide:link-2" class="w-3 h-3 text-slate-400" /></span>
								{/if}
							</div>

							<!-- SQL preview -->
							<p class="mt-0.5 text-xs font-mono text-slate-500 dark:text-slate-400 truncate">
								{snippet.sql.replace(/\s+/g, ' ').slice(0, 80)}{snippet.sql.length > 80 ? '…' : ''}
							</p>

							<!-- Meta row -->
							<div class="flex items-center gap-2 mt-1 flex-wrap">
								{#if snippet.tags.length > 0}
									{#each snippet.tags.slice(0, 3) as tag}
										<span class="px-1.5 py-0.5 rounded-full text-xs bg-violet-50 dark:bg-violet-900/30 text-violet-500 dark:text-violet-400">
											{tag}
										</span>
									{/each}
									{#if snippet.tags.length > 3}
										<span class="text-xs text-slate-400">+{snippet.tags.length - 3}</span>
									{/if}
								{/if}
								<span class="text-xs text-slate-400 ml-auto shrink-0">
									{snippet.createdBy === authStore.currentUser?.id ? 'You' : snippet.createdByName}
									· {formatDate(snippet.updatedAt)}
								</span>
							</div>
						</div>

						<!-- Row quick-actions (visible on hover) -->
						<div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
							<!-- Insert into editor -->
							<button
								type="button"
								class="p-1.5 rounded-md text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-100 dark:hover:bg-violet-900/30 transition-all"
								onclick={(e) => { e.stopPropagation(); onInsert(snippet.sql); }}
								title="Insert into editor"
							>
								<Icon name="lucide:corner-down-left" class="w-3.5 h-3.5" />
							</button>
							<!-- Run directly -->
							<button
								type="button"
								class="p-1.5 rounded-md text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 transition-all"
								onclick={(e) => { e.stopPropagation(); onRun(snippet.sql); }}
								title="Run snippet"
							>
								<Icon name="lucide:play" class="w-3.5 h-3.5" />
							</button>
						</div>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>

<!-- Modals (rendered at panel level) -->
<SnippetFormModal />
<SnippetPreviewModal {onInsert} {onRun} />
