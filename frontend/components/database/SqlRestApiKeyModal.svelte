<script lang="ts">
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		dbRestApiState,
		closeKeyModal,
		createKey,
		deleteKey,
		toggleKey
	} from '$frontend/stores/features/db-sql-rest-api.svelte';

	let newKeyName = $state('');
	let newKeyExpiry = $state('');
	let isCreating = $state(false);

	async function handleCreateKey(e: Event): Promise<void> {
		e.preventDefault();
		if (!newKeyName.trim() || !dbRestApiState.keyEndpoint) return;
		isCreating = true;
		try {
			const expiresAt = newKeyExpiry ? new Date(newKeyExpiry).toISOString() : null;
			await createKey(dbRestApiState.keyEndpoint.id, newKeyName.trim(), expiresAt);
			newKeyName = '';
			newKeyExpiry = '';
		} finally {
			isCreating = false;
		}
	}

	function copySecret(secret: string): void {
		navigator.clipboard.writeText(secret).then(() => {
			addNotification({ type: 'success', title: 'Copied', message: 'API key copied to clipboard', duration: 2000 });
		});
	}

	function formatDate(dateStr: string | null): string {
		if (!dateStr) return 'Never';
		return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function isExpired(expiresAt: string | null): boolean {
		if (!expiresAt) return false;
		return new Date(expiresAt) < new Date();
	}
</script>

{#if dbRestApiState.isKeyModalOpen && dbRestApiState.keyEndpoint}
	<div
		class="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/50"
		role="dialog"
		aria-modal="true"
	>
		<div class="w-full max-w-lg bg-white dark:bg-slate-900 rounded-xl shadow-2xl flex flex-col max-h-[85vh]">

			<!-- Header -->
			<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
				<div>
					<div class="flex items-center gap-2">
						<Icon name="lucide:key" class="w-4 h-4 text-violet-500" />
						<h2 class="text-sm font-semibold text-slate-800 dark:text-slate-100">API Keys</h2>
					</div>
					<p class="text-xs text-slate-400 mt-0.5">/{dbRestApiState.keyEndpoint.slug}</p>
				</div>
				<button
					type="button"
					onclick={closeKeyModal}
					class="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</div>

			<div class="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">

				<!-- New secret banner -->
				{#if dbRestApiState.newKeySecret}
					<div class="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-800">
						<div class="flex items-start gap-2">
							<Icon name="lucide:shield-check" class="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
							<div class="flex-1 min-w-0">
								<p class="text-xs font-semibold text-emerald-700 dark:text-emerald-300">Key created — copy it now!</p>
								<p class="text-xs text-emerald-600 dark:text-emerald-400 mb-2">This is the only time the full key will be shown.</p>
								<div class="flex items-center gap-2">
									<code class="flex-1 text-xs font-mono bg-white dark:bg-slate-900 px-2 py-1.5 rounded border border-emerald-200 dark:border-emerald-700 text-slate-700 dark:text-slate-300 truncate">
										{dbRestApiState.newKeySecret}
									</code>
									<button
										type="button"
										onclick={() => copySecret(dbRestApiState.newKeySecret!)}
										class="shrink-0 p-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white transition-colors"
										title="Copy to clipboard"
									>
										<Icon name="lucide:copy" class="w-3.5 h-3.5" />
									</button>
								</div>
							</div>
						</div>
					</div>
				{/if}

				<!-- Create new key form -->
				<form class="space-y-3" onsubmit={handleCreateKey}>
					<h3 class="text-xs font-semibold text-slate-700 dark:text-slate-300">Create new key</h3>
					<div class="flex items-end gap-2">
						<div class="flex-1">
							<label class="block text-xs text-slate-500 dark:text-slate-400 mb-1">Name *</label>
							<input
								type="text"
								bind:value={newKeyName}
								required
								placeholder="Production API"
								class="w-full px-3 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500"
							/>
						</div>
						<div>
							<label class="block text-xs text-slate-500 dark:text-slate-400 mb-1">Expires (optional)</label>
							<input
								type="date"
								bind:value={newKeyExpiry}
								class="px-3 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-violet-500"
							/>
						</div>
						<button
							type="submit"
							disabled={isCreating || !newKeyName.trim()}
							class="flex items-center gap-1 px-3 py-2 text-xs font-medium rounded-md bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white transition-colors"
						>
							{#if isCreating}
								<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
									<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
									<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
								</svg>
							{:else}
								<Icon name="lucide:plus" class="w-3.5 h-3.5" />
							{/if}
							Generate
						</button>
					</div>
				</form>

				<!-- Existing keys -->
				<div>
					<h3 class="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
						Existing keys ({dbRestApiState.keys.length})
					</h3>
					{#if dbRestApiState.isKeysLoading}
						<div class="flex items-center gap-2 py-4 text-slate-400 text-xs">
							<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
								<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
								<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
							</svg>
							Loading keys…
						</div>
					{:else if dbRestApiState.keys.length === 0}
						<p class="text-xs text-slate-400 italic">No API keys yet.</p>
					{:else}
						<div class="space-y-2">
							{#each dbRestApiState.keys as key (key.id)}
								{@const expired = isExpired(key.expiresAt)}
								<div class="flex items-center gap-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
									<!-- Status dot -->
									<div class="w-2 h-2 rounded-full shrink-0 {key.enabled && !expired ? 'bg-emerald-400' : 'bg-slate-300 dark:bg-slate-600'}"></div>

									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-2">
											<span class="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">{key.name}</span>
											{#if expired}
												<span class="px-1.5 py-0.5 rounded text-xs bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400">Expired</span>
											{:else if !key.enabled}
												<span class="px-1.5 py-0.5 rounded text-xs bg-slate-100 dark:bg-slate-700 text-slate-500">Disabled</span>
											{/if}
										</div>
										<div class="flex items-center gap-3 mt-0.5">
											<code class="text-xs font-mono text-slate-400">{key.keyPrefix}••••••••</code>
											<span class="text-xs text-slate-400">
												Last used: {formatDate(key.lastUsedAt)}
											</span>
											{#if key.expiresAt}
												<span class="text-xs text-slate-400">
													Expires: {formatDate(key.expiresAt)}
												</span>
											{/if}
										</div>
									</div>

									<!-- Actions -->
									<div class="flex items-center gap-1 shrink-0">
										<button
											type="button"
											onclick={() => toggleKey(key.id, !key.enabled)}
											class="p-1.5 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
											title={key.enabled ? 'Disable key' : 'Enable key'}
										>
											<Icon name={key.enabled ? 'lucide:toggle-right' : 'lucide:toggle-left'} class="w-4 h-4" />
										</button>
										<button
											type="button"
											onclick={() => deleteKey(key.id)}
											class="p-1.5 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
											title="Revoke key"
										>
											<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
										</button>
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Usage hint -->
				<div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
					<p class="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Usage</p>
					<code class="text-xs font-mono text-slate-500 dark:text-slate-400">
						GET /sql-api/{dbRestApiState.keyEndpoint.slug}?param=value<br />
						X-Api-Key: &lt;your-key&gt;
					</code>
					<p class="text-xs text-slate-400 mt-1">Or use <code class="font-mono">?api_key=&lt;key&gt;</code> query parameter.</p>
				</div>
			</div>

			<!-- Footer -->
			<div class="px-5 py-3 border-t border-slate-200 dark:border-slate-800 shrink-0 flex justify-end">
				<button
					type="button"
					onclick={closeKeyModal}
					class="px-4 py-2 text-xs rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
				>
					Close
				</button>
			</div>
		</div>
	</div>
{/if}
