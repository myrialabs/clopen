<!--
  Token Usage Modal Component

  Features:
  - Display token usage statistics
  - Cache read and creation stats
  - Request information
-->

<script lang="ts">
	import Modal from '$frontend/lib/components/common/Modal.svelte';
	import Icon from '$frontend/lib/components/common/Icon.svelte';

	let {
		isOpen = $bindable(),
		tokenUsage,
		timestamp,
		onClose
	}: {
		isOpen: boolean;
		tokenUsage: any;
		timestamp: string;
		onClose: () => void;
	} = $props();

	// Format timestamp
	const formatTime = (timestamp?: string) => {
		if (!timestamp) return 'Unknown';
		const date = new Date(timestamp);
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	};
</script>

<Modal
	bind:isOpen
	title="Token Usage"
	size="md"
	{onClose}
>
	{#snippet children()}
		{#if tokenUsage}
			<div class="space-y-4">
				<!-- Token Usage Stats -->
				<div class="bg-violet-50 dark:bg-violet-900/20 rounded-lg p-4">
					<h4 class="font-medium text-violet-900 dark:text-violet-100 mb-2 flex items-center gap-2">
						<Icon name="lucide:zap" class="w-4 h-4" />
						Token Usage
					</h4>
					<div class="space-y-3 text-slate-600 dark:text-slate-400">
						<div class="flex justify-between items-center">
							<span class="text-sm">Input Tokens:</span>
							<span class="font-mono font-semibold text-violet-600 dark:text-violet-400">
								{(tokenUsage.input_tokens ?? 0).toLocaleString()}
							</span>
						</div>
						<div class="flex justify-between items-center">
							<span class="text-sm">Output Tokens:</span>
							<span class="font-mono font-semibold text-violet-600 dark:text-violet-400">
								{(tokenUsage.output_tokens ?? 0).toLocaleString()}
							</span>
						</div>
						<div class="flex justify-between items-center">
							<span class="text-sm">Cache Read:</span>
							<span class="font-mono font-semibold text-green-600 dark:text-green-400">
								{(tokenUsage.cache_read_input_tokens ?? 0).toLocaleString()}
							</span>
						</div>
						<div class="flex justify-between items-center">
							<span class="text-sm">Cache Creation:</span>
							<span class="font-mono font-semibold text-violet-600 dark:text-violet-400">
								{(tokenUsage.cache_creation_input_tokens ?? 0).toLocaleString()}
							</span>
						</div>
						<!-- Total -->
						<div class="border-t border-violet-200/50 dark:border-violet-800/50 pt-3 mt-3">
							<div class="flex justify-between items-center">
								<span class="text-sm font-medium">Total Tokens:</span>
								<span class="font-mono font-bold text-lg text-violet-600 dark:text-violet-400">
									{((tokenUsage.input_tokens || 0) + (tokenUsage.output_tokens || 0)).toLocaleString()}
								</span>
							</div>
						</div>
					</div>
				</div>

				<!-- Request Info -->
				<div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-4 border border-slate-200 dark:border-slate-700">
					<h4 class="font-medium text-slate-900 dark:text-slate-100 mb-2 flex items-center gap-2">
						<Icon name="lucide:info" class="w-4 h-4" />
						Request Info
					</h4>
					<div class="space-y-2">
						<div class="flex justify-between items-center">
							<span class="text-sm text-slate-600 dark:text-slate-400">Time:</span>
							<span class="text-sm font-mono text-slate-900 dark:text-slate-100">
								{formatTime(timestamp || new Date().toISOString())}
							</span>
						</div>
						<div class="flex justify-between items-center">
							<span class="text-sm text-slate-600 dark:text-slate-400">Date:</span>
							<span class="text-sm font-mono text-slate-900 dark:text-slate-100">
								{timestamp ? new Date(timestamp).toLocaleDateString() : 'Unknown'}
							</span>
						</div>
						{#if tokenUsage.service_tier}
							<div class="flex justify-between items-center">
								<span class="text-sm text-slate-600 dark:text-slate-400">Service Tier:</span>
								<span class="text-sm font-medium capitalize text-slate-900 dark:text-slate-100">
									{tokenUsage.service_tier}
								</span>
							</div>
						{/if}
					</div>
				</div>
			</div>
		{:else}
			<div class="text-center py-8">
				<Icon name="lucide:info" class="w-12 h-12 text-slate-400 mx-auto mb-2" />
				<p class="text-slate-600 dark:text-slate-400">No token usage data available</p>
				<p class="text-sm text-slate-500 dark:text-slate-500 mt-1">This message doesn't contain token usage information</p>
			</div>
		{/if}
	{/snippet}
</Modal>
