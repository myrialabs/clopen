<script lang="ts">
	import { DEFAULT_MODEL } from '$shared/constants/engines';
	import type { EngineModel } from '$shared/types/engine';
	import { settings } from '$frontend/lib/stores/features/settings.svelte';
	import { modelStore } from '$frontend/lib/stores/features/models.svelte';
	import Icon from '$frontend/lib/components/common/Icon.svelte';

	let {
		value = $bindable(DEFAULT_MODEL),
		disabled = false,
		showDescription = true,
		showCapabilities = true,
		onModelChange
	}: {
		value?: string;
		disabled?: boolean;
		showDescription?: boolean;
		showCapabilities?: boolean;
		onModelChange?: (model: EngineModel) => void;
	} = $props();

	const selectedModel = $derived(modelStore.getById(value));

	// Show models for the currently selected engine
	const availableModels = $derived(modelStore.getByEngine(settings.selectedEngine));

	function handleModelChange(event: Event) {
		const target = event.target as HTMLSelectElement;
		const newValue = target.value;
		value = newValue;

		const model = modelStore.getById(newValue);
		if (model) {
			onModelChange?.(model);
		}
	}

	function formatContextWindow(tokens: number): string {
		if (tokens >= 1000000) {
			return `${(tokens / 1000000).toFixed(1)}M tokens`;
		} else if (tokens >= 1000) {
			return `${(tokens / 1000).toFixed(0)}K tokens`;
		}
		return `${tokens} tokens`;
	}
</script>

<div>
	<div class="relative">
		<select
			bind:value
			onchange={handleModelChange}
			{disabled}
			class="w-full px-4 py-3 pr-10 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-sm text-slate-900 dark:text-slate-100 appearance-none outline-none"
			class:opacity-50={disabled}
		>
			{#each availableModels as model (model.id)}
				<option value={model.id}>
					{model.name}{model.recommended ? ' (Default)' : ''} — {model.provider}
				</option>
			{/each}
		</select>

		<div class="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none">
			<Icon name="lucide:chevron-down" class="w-4 h-4 text-slate-500" />
		</div>
	</div>

	{#if selectedModel && showDescription}
		<div
			class="mt-3 p-3 bg-slate-100/80 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-800"
		>
			<div class="flex items-center space-x-2 mb-2">
				<Icon name="lucide:star" class="w-4 h-4 text-violet-600" />
				<h4 class="font-medium text-sm text-slate-900 dark:text-slate-100">
					{selectedModel.name}
					{#if selectedModel.recommended}
						<span class="ml-1 text-xs text-violet-600">(Default)</span>
					{/if}
				</h4>
				<span class="text-xs px-1.5 py-0.5 bg-slate-200 dark:bg-slate-700 rounded text-slate-500 uppercase">{selectedModel.provider}</span>
			</div>

			<p class="text-xs text-slate-500 mb-2">
				{selectedModel.description}
			</p>

			<div class="flex items-center space-x-4 text-xs text-slate-600 dark:text-slate-500">
				<div class="flex items-center space-x-1">
					<Icon name="lucide:layers" class="w-3 h-3" />
					<span>Context: {formatContextWindow(selectedModel.contextWindow)}</span>
				</div>
			</div>

			{#if showCapabilities && selectedModel.capabilities.length > 0}
				<div class="mt-2">
					<div class="flex flex-wrap gap-1">
						{#each selectedModel.capabilities as capability (capability)}
							<span
								class="px-2 py-1 bg-violet-500/10 dark:bg-violet-500/20 text-violet-600 text-xs rounded-full"
							>
								{capability}
							</span>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>
