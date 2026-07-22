<script lang="ts">
	import { settings, updateSettings } from '$frontend/stores/features/settings.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { setActiveSection } from '$frontend/stores/ui/settings-modal.svelte';
	import type { EngineType } from '$shared/types/unified';
	import EngineModelPicker from './EngineModelPicker.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';

	const isAdmin = $derived(authStore.isAdmin);

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
		Default engine and model used when you start a new chat.
	</p>

	<div class="flex items-start gap-2.5 p-3 mb-4 rounded-xl bg-slate-500/5 dark:bg-slate-400/5 border border-slate-200 dark:border-slate-700/60">
		<Icon name="lucide:info" class="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
		<p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
			Just the default — override it per chat anytime from the model picker in the chat input.
			{#if isAdmin}
				Accounts are managed under <button type="button" class="text-violet-600 dark:text-violet-400 hover:underline cursor-pointer font-medium" onclick={() => setActiveSection('engines')}>Settings → Engines</button>.
			{/if}
		</p>
	</div>

	<EngineModelPicker
		engine={settings.selectedEngine}
		model={settings.selectedModelId}
		onEngineChange={handleAssistantEngineChange}
		onModelChange={handleAssistantModelChange}
	/>
</div>
