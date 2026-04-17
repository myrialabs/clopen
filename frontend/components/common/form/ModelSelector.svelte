<script lang="ts">
	import { DEFAULT_MODEL_ID } from '$shared/constants/engines';
	import type { EngineModel } from '$shared/types/unified';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { formatTokens } from '$frontend/utils/format';

	let {
		value = $bindable(DEFAULT_MODEL_ID),
		disabled = false,
		onModelChange
	}: {
		value?: string;
		disabled?: boolean;
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
			{#each availableModels as model (model.engine.model.id)}
				<option value={model.engine.model.id}>
					{model.engine.model.name} — {model.engine.provider}
				</option>
			{/each}
		</select>

		<div class="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none">
			<Icon name="lucide:chevron-down" class="w-4 h-4 text-slate-500" />
		</div>
	</div>

	{#if selectedModel}
		<div
			class="mt-3 p-3 bg-slate-100/80 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-800"
		>
			<div class="flex items-center space-x-2 mb-2">
				<Icon name="lucide:star" class="w-4 h-4 text-violet-600" />
				<h4 class="font-medium text-sm text-slate-900 dark:text-slate-100">
					{selectedModel.engine.model.name}
				</h4>
				<span class="text-xs px-1.5 py-0.5 bg-slate-200 dark:bg-slate-700 rounded text-slate-500 uppercase">{selectedModel.engine.provider}</span>
			</div>

			<div class="flex items-center space-x-4 text-xs text-slate-600 dark:text-slate-500">
				<div class="flex items-center space-x-1">
					<Icon name="lucide:layers" class="w-3 h-3" />
					<span>Input: {formatTokens(selectedModel.limit.input)} tokens</span>
				</div>
			</div>
		</div>
	{/if}
</div>
