<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { dbRestApiState, closeDocs } from '$frontend/stores/features/db-sql-rest-api.svelte';

	const specUrl = $derived(typeof window !== 'undefined' ? `${window.location.origin}/sql-api/spec` : '/sql-api/spec');
	const docsUrl = $derived(typeof window !== 'undefined' ? `${window.location.origin}/sql-api/docs` : '/sql-api/docs');
</script>

{#if dbRestApiState.isDocsOpen}
	<div
		class="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/50"
		role="dialog"
		aria-modal="true"
	>
		<div class="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl flex flex-col max-h-[85vh]">

			<!-- Header -->
			<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
				<div class="flex items-center gap-2">
					<Icon name="lucide:book-open" class="w-4 h-4 text-violet-500" />
					<h2 class="text-sm font-semibold text-slate-800 dark:text-slate-100">API Documentation</h2>
				</div>
				<button
					type="button"
					onclick={closeDocs}
					class="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</div>

			<div class="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">

				<!-- Swagger UI link -->
				<div class="p-4 rounded-lg bg-violet-50 dark:bg-violet-900/20 border border-violet-200 dark:border-violet-800">
					<div class="flex items-center gap-3">
						<div class="w-8 h-8 rounded-lg bg-violet-600 flex items-center justify-center shrink-0">
							<Icon name="lucide:globe" class="w-4 h-4 text-white" />
						</div>
						<div class="flex-1 min-w-0">
							<p class="text-xs font-semibold text-violet-800 dark:text-violet-200">Swagger UI</p>
							<p class="text-xs text-violet-600 dark:text-violet-400 mt-0.5">Interactive API documentation with try-it-out support</p>
						</div>
						<a
							href={docsUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md bg-violet-600 hover:bg-violet-700 text-white transition-colors shrink-0"
						>
							<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
							Open docs
						</a>
					</div>
				</div>

				<!-- Endpoints reference -->
				{#if dbRestApiState.endpoints.length === 0}
					<p class="text-xs text-slate-400 italic text-center py-4">No endpoints created yet.</p>
				{:else}
					<div class="space-y-3">
						<h3 class="text-xs font-semibold text-slate-700 dark:text-slate-300">Endpoints</h3>
						{#each dbRestApiState.endpoints as ep (ep.id)}
							<div class="p-3 rounded-lg border border-slate-200 dark:border-slate-700">
								<!-- Route badge + name -->
								<div class="flex items-start gap-2">
									<span class="px-2 py-0.5 rounded text-xs font-mono font-semibold bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">GET</span>
									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-2 flex-wrap">
											<code class="text-xs font-mono text-slate-600 dark:text-slate-300">/sql-api/{ep.slug}</code>
											{#if !ep.enabled}
												<span class="px-1.5 py-0.5 rounded text-xs bg-slate-100 dark:bg-slate-700 text-slate-500">Disabled</span>
											{/if}
											{#if ep.isPublic}
												<span class="px-1.5 py-0.5 rounded text-xs bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400">Public</span>
											{:else}
												<span class="px-1.5 py-0.5 rounded text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400">
													<Icon name="lucide:key" class="inline w-2.5 h-2.5 mr-0.5" />Key required
												</span>
											{/if}
										</div>
										{#if ep.description}
											<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{ep.description}</p>
										{/if}
									</div>
								</div>

								<!-- Parameters -->
								{#if ep.params.length > 0}
									<div class="mt-2.5 space-y-1">
										{#each ep.params as p}
											<div class="flex items-center gap-2 text-xs">
												<code class="font-mono text-violet-600 dark:text-violet-400">{p.name}</code>
												<span class="text-slate-400">({p.type})</span>
												{#if p.required}
													<span class="text-red-400">required</span>
												{:else}
													<span class="text-slate-400">optional{p.defaultValue ? `, default: ${p.defaultValue}` : ''}</span>
												{/if}
												{#if p.description}
													<span class="text-slate-400">— {p.description}</span>
												{/if}
											</div>
										{/each}
									</div>
								{/if}

								<!-- Rate limit info -->
								<div class="mt-2 flex items-center gap-3 text-xs text-slate-400">
									<span>
										<Icon name="lucide:gauge" class="inline w-3 h-3 mr-0.5" />
										{ep.rateLimitRequests} req / {ep.rateLimitWindowSecs}s
									</span>
									{#if ep.cacheTtlSecs > 0}
										<span>
											<Icon name="lucide:clock" class="inline w-3 h-3 mr-0.5" />
											Cache: {ep.cacheTtlSecs}s
										</span>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}

				<!-- OpenAPI spec link -->
				<div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
					<p class="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">OpenAPI 3.0 Spec</p>
					<div class="flex items-center gap-2">
						<code class="flex-1 text-xs font-mono text-slate-500 dark:text-slate-400 truncate">{specUrl}</code>
						<a
							href={specUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="shrink-0 text-xs text-violet-500 hover:text-violet-600 transition-colors"
						>
							<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
						</a>
					</div>
				</div>
			</div>

			<div class="px-5 py-3 border-t border-slate-200 dark:border-slate-800 shrink-0 flex justify-end">
				<button
					type="button"
					onclick={closeDocs}
					class="px-4 py-2 text-xs rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
				>
					Close
				</button>
			</div>
		</div>
	</div>
{/if}
