<script lang="ts">
	import { settings, updateSettings } from '$frontend/stores/features/settings.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import type { EngineType } from '$shared/types/unified';
	import EngineModelPicker from './EngineModelPicker.svelte';

	function handleAssistantEngineChange(engineType: EngineType) {
		updateSettings({ selectedEngine: engineType });

		const memory = settings.engineModelMemory || {};
		const remembered = memory[engineType];

		modelStore.fetchModels(engineType).then(models => {
			const target = (remembered && models.find(m => m.engine.model.id === remembered.id))
				|| models[0];
			if (target) {
				updateSettings({
					selectedProvider: target.engine.provider,
					selectedModelId: target.engine.model.id,
					selectedModelName: target.engine.model.name,
					engineModelMemory: { ...memory, [engineType]: { provider: target.engine.provider, id: target.engine.model.id, name: target.engine.model.name } }
				});
			} else {
				updateSettings({ selectedProvider: '', selectedModelId: '', selectedModelName: '' });
			}
		});
	}

	function handleAssistantModelChange(modelId: string) {
		const memory = settings.engineModelMemory || {};
		const model = modelStore.getById(modelId);
		const provider = model?.engine.provider || settings.selectedProvider;
		updateSettings({
			selectedProvider: provider,
			selectedModelId: modelId,
			selectedModelName: model?.engine.model.name || modelId,
			engineModelMemory: { ...memory, [settings.selectedEngine]: { provider, id: modelId, name: model?.engine.model.name || modelId } }
		});
	}
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Assistant</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-4">
		Configure the engine and model for chat
	</p>

	<EngineModelPicker
		engine={settings.selectedEngine}
		model={settings.selectedModelId}
		onEngineChange={handleAssistantEngineChange}
		onModelChange={handleAssistantModelChange}
	/>
</div>
