<script lang="ts">
	import { onMount } from 'svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import SqlRestApiFormModal from './SqlRestApiFormModal.svelte';
	import SqlRestApiKeyModal from './SqlRestApiKeyModal.svelte';
	import SqlRestApiDocsModal from './SqlRestApiDocsModal.svelte';
	import {
		dbRestApiState,
		fetchEndpoints,
		deleteEndpoint,
		openForm,
		openKeyModal,
		openLogModal,
		openDocs,
		getFilteredEndpoints
	} from '$frontend/stores/features/db-sql-rest-api.svelte';
	import type { SqlApiEndpoint } from '$shared/types/sql-rest-api';

	interface Props {
		connectionId: string;
	}

	let { connectionId }: Props = $props();

	const filtered = $derived(getFilteredEndpoints());

	/** Endpoint pending delete — shows custom confirm dialog */
	let pendingDelete = $state<SqlApiEndpoint | null>(null);

	onMount(async () => {
		await fetchEndpoints(connectionId);
	});

	function formatDate(dateStr: string): string {
		return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	function copyUrl(ep: SqlApiEndpoint): void {
		const url = `${window.location.origin}/sql-api/${ep.slug}`;
		navigator.clipboard.writeText(url).then(() => {
			addNotification({ type: 'success', title: 'URL copied', message: url, duration: 2500 });
		});
	}

	async function handleDelete(): Promise<void> {
		if (!pendingDelete) return;
		const ep = pendingDelete;
		pendingDelete = null;
		await deleteEndpoint(ep.id);
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
				bind:value={dbRestApiState.search}
				placeholder="Search endpoints…"
				class="w-full pl-7 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-700 dark:text-slate-300 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
			/>
		</div>

		<!-- Docs button -->
		<button
			type="button"
			onclick={openDocs}
			class="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs transition-colors border border-slate-200 dark:border-slate-700 shrink-0"
			title="View API docs"
		>
			<Icon name="lucide:book-open" class="w-3.5 h-3.5" />
			Docs
		</button>

		<!-- New endpoint -->
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
			onclick={() => fetchEndpoints(connectionId)}
			title="Refresh"
		>
			<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5 {dbRestApiState.isLoading ? 'animate-spin' : ''}" />
		</button>
	</div>

	<!-- List -->
	<div class="flex-1 min-h-0 overflow-y-auto">
		{#if dbRestApiState.isLoading}
			<div class="flex items-center justify-center h-24 gap-2 text-slate-400 text-xs">
				<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
				</svg>
				Loading endpoints…
			</div>
		{:else if filtered.length === 0}
			<div class="flex flex-col items-center justify-center h-36 gap-2 text-slate-400 text-xs px-6 text-center">
				<Icon name="lucide:cable" class="w-7 h-7 opacity-25" />
				{#if dbRestApiState.search}
					<span>No endpoints match your search</span>
				{:else}
					<span>No REST API endpoints yet</span>
					<button
						type="button"
						onclick={() => openForm()}
						class="text-violet-500 hover:text-violet-600 transition-colors"
					>
						Create your first endpoint →
					</button>
				{/if}
			</div>
		{:else}
			{#each filtered as ep (ep.id)}
				<div class="group px-3 py-3 hover:bg-violet-50 dark:hover:bg-violet-900/20 border-b border-slate-100 dark:border-slate-800/50 transition-colors">
					<div class="flex items-start gap-2">

						<!-- Status dot -->
						<div class="mt-1 w-2 h-2 rounded-full shrink-0 {ep.enabled ? 'bg-emerald-400' : 'bg-slate-300 dark:bg-slate-600'}"></div>

						<div class="flex-1 min-w-0">
							<!-- Name + badges -->
							<div class="flex items-center gap-2 flex-wrap">
								<span class="text-xs font-medium text-slate-800 dark:text-slate-100">{ep.name}</span>
								{#if ep.isPublic}
									<span class="px-1.5 py-0.5 rounded text-xs bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">Public</span>
								{:else}
									<span class="px-1.5 py-0.5 rounded text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
										<Icon name="lucide:key" class="inline w-2.5 h-2.5 mr-0.5" />Private
									</span>
								{/if}
								{#if !ep.enabled}
									<span class="px-1.5 py-0.5 rounded text-xs bg-slate-100 dark:bg-slate-700 text-slate-500">Disabled</span>
								{/if}
							</div>

							<!-- URL -->
							<div class="flex items-center gap-1 mt-0.5">
								<span class="px-1.5 py-0.5 rounded text-xs font-mono font-semibold bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">GET</span>
								<code class="text-xs font-mono text-slate-500 dark:text-slate-400 truncate">/sql-api/{ep.slug}</code>
							</div>

							<!-- Description + meta -->
							{#if ep.description}
								<p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400 truncate">{ep.description}</p>
							{/if}

							<!-- Params preview -->
							{#if ep.params.length > 0}
								<div class="flex items-center gap-1.5 mt-1 flex-wrap">
									{#each ep.params as p}
										<span class="px-1.5 py-0.5 rounded text-xs font-mono bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
											{p.name}{p.required ? '' : '?'}
										</span>
									{/each}
								</div>
							{/if}

							<!-- Footer meta -->
							<div class="flex items-center gap-3 mt-1 text-xs text-slate-400">
								<span><Icon name="lucide:gauge" class="inline w-3 h-3 mr-0.5" />{ep.rateLimitRequests}/{ep.rateLimitWindowSecs}s</span>
								{#if ep.cacheTtlSecs > 0}
									<span><Icon name="lucide:clock" class="inline w-3 h-3 mr-0.5" />Cache {ep.cacheTtlSecs}s</span>
								{/if}
								<span class="ml-auto">{formatDate(ep.updatedAt)}</span>
							</div>
						</div>

						<!-- Row actions (visible on hover) -->
						<div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
							<!-- Copy URL -->
							<button
								type="button"
								onclick={() => copyUrl(ep)}
								class="p-1.5 rounded-md text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-100 dark:hover:bg-violet-900/30 transition-all"
								title="Copy endpoint URL"
							>
								<Icon name="lucide:link-2" class="w-3.5 h-3.5" />
							</button>
							<!-- Manage keys -->
							<button
								type="button"
								onclick={() => openKeyModal(ep)}
								class="p-1.5 rounded-md text-slate-400 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-all"
								title="Manage API keys"
							>
								<Icon name="lucide:key" class="w-3.5 h-3.5" />
							</button>
							<!-- Request log -->
							<button
								type="button"
								onclick={() => openLogModal(ep)}
								class="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
								title="View request log"
							>
								<Icon name="lucide:scroll-text" class="w-3.5 h-3.5" />
							</button>
							<!-- Edit -->
							<button
								type="button"
								onclick={() => openForm(ep)}
								class="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
								title="Edit endpoint"
							>
								<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
							</button>
							<!-- Delete -->
							<button
								type="button"
								onclick={() => (pendingDelete = ep)}
								class="p-1.5 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 transition-all"
								title="Delete endpoint"
							>
								<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
							</button>
						</div>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>

<!-- Request Log slide-over -->
{#if dbRestApiState.isLogOpen && dbRestApiState.logEndpoint}
	<div
		class="fixed inset-0 z-50 flex items-center justify-end p-4 bg-black/40"
		role="dialog"
		aria-modal="true"
	>
		<div class="w-full max-w-md h-full bg-white dark:bg-slate-900 rounded-xl shadow-2xl flex flex-col">
			<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
				<div>
					<div class="flex items-center gap-2">
						<Icon name="lucide:scroll-text" class="w-4 h-4 text-violet-500" />
						<h2 class="text-sm font-semibold text-slate-800 dark:text-slate-100">Request Log</h2>
					</div>
					<p class="text-xs text-slate-400 mt-0.5">/{dbRestApiState.logEndpoint.slug}</p>
				</div>
				<button
					type="button"
					onclick={() => (dbRestApiState.isLogOpen = false)}
					class="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</div>
			<div class="flex-1 min-h-0 overflow-y-auto">
				{#if dbRestApiState.isLogsLoading}
					<div class="flex items-center justify-center h-16 gap-2 text-slate-400 text-xs">
						<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
						</svg>
						Loading…
					</div>
				{:else if dbRestApiState.logs.length === 0}
					<div class="flex items-center justify-center h-20 text-slate-400 text-xs">No requests yet</div>
				{:else}
					{#each dbRestApiState.logs as log (log.id)}
						<div class="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800/50">
							<div class="flex items-center gap-2">
								<!-- Status code badge -->
								<span class="px-1.5 py-0.5 rounded text-xs font-mono font-semibold {
									log.statusCode < 300 ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' :
									log.statusCode < 500 ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400' :
									'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
								}">{log.statusCode}</span>
								<span class="text-xs text-slate-500 dark:text-slate-400 truncate">
									{new Date(log.requestedAt).toLocaleTimeString()}
								</span>
								{#if log.executionTimeMs !== null}
									<span class="text-xs text-slate-400 ml-auto">{log.executionTimeMs}ms</span>
								{/if}
							</div>
							{#if log.error}
								<p class="mt-0.5 text-xs text-red-500 truncate">{log.error}</p>
							{/if}
							{#if Object.keys(log.params).length > 0}
								<p class="mt-0.5 text-xs font-mono text-slate-400 truncate">
									{Object.entries(log.params).map(([k, v]) => `${k}=${v}`).join('&')}
								</p>
							{/if}
							<p class="text-xs text-slate-400 mt-0.5">{log.ipAddress ?? 'unknown IP'}</p>
						</div>
					{/each}
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- Modals -->
<SqlRestApiFormModal {connectionId} />
<SqlRestApiKeyModal />
<SqlRestApiDocsModal />

<!-- Custom delete confirmation dialog -->
{#if pendingDelete}
	<div
		class="fixed inset-0 z-[400] flex items-center justify-center p-4 bg-black/50"
		role="dialog"
		aria-modal="true"
	>
		<div class="w-full max-w-sm bg-white dark:bg-slate-900 rounded-xl shadow-2xl p-5 space-y-4">
			<div class="flex items-start gap-3">
				<div class="w-9 h-9 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center shrink-0">
					<Icon name="lucide:trash-2" class="w-4 h-4 text-red-600 dark:text-red-400" />
				</div>
				<div>
					<h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">Delete endpoint?</h3>
					<p class="text-xs text-slate-500 dark:text-slate-400 mt-1">
						<code class="font-mono text-red-600 dark:text-red-400">GET /sql-api/{pendingDelete.slug}</code>
						will be permanently removed. All API keys for this endpoint will also be deleted.
					</p>
				</div>
			</div>
			<div class="flex justify-end gap-2 pt-1">
				<button
					type="button"
					onclick={() => (pendingDelete = null)}
					class="px-4 py-2 text-xs rounded-lg text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
				>
					Cancel
				</button>
				<button
					type="button"
					onclick={handleDelete}
					class="px-4 py-2 text-xs font-medium rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors"
				>
					Delete endpoint
				</button>
			</div>
		</div>
	</div>
{/if}
