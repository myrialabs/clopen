<script lang="ts">
	import { settings, updateSettings } from '$frontend/stores/features/settings.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { ENGINES } from '$shared/constants/engines';
	import type { EngineType } from '$shared/types/unified';
	import EngineModelPicker from './EngineModelPicker.svelte';

	// Model used to generate Skills, Commands, Subagents, and Instructions from a purpose.
	const artifactGen = $derived(settings.artifactGenerator);
	const artifactsCustom = $derived(!!artifactGen?.useCustomModel);
	const artifactsEngine = $derived(artifactsCustom && artifactGen ? artifactGen.engine : settings.selectedEngine);
	const artifactsModelId = $derived(artifactsCustom && artifactGen ? artifactGen.modelId : settings.selectedModelId);
	const artifactsEngineMeta = $derived(ENGINES.find(e => e.type === artifactsEngine));
	const artifactsModelMeta = $derived(modelStore.getById(artifactsModelId));

	function baseArtifactGen() {
		return artifactGen ?? {
			useCustomModel: false,
			engine: settings.selectedEngine,
			provider: settings.selectedProvider,
			modelId: settings.selectedModelId,
			modelName: settings.selectedModelName
		};
	}

	function toggleArtifactsCustom() {
		const base = baseArtifactGen();
		updateSettings({ artifactGenerator: { ...base, useCustomModel: !base.useCustomModel } });
	}

	function handleArtifactsEngineChange(engineType: EngineType) {
		const base = baseArtifactGen();
		const models = modelStore.getByEngine(engineType);
		const defaultModel = models[0];
		updateSettings({
			artifactGenerator: {
				...base,
				engine: engineType,
				modelId: defaultModel?.engine.model.id || '',
				modelName: defaultModel?.engine.model.name || ''
			}
		});
		modelStore.fetchModels(engineType).then(fetched => {
			if (fetched.length > 0) {
				updateSettings({
					artifactGenerator: { ...baseArtifactGen(), engine: engineType, modelId: fetched[0].engine.model.id, modelName: fetched[0].engine.model.name }
				});
			}
		});
	}

	function handleArtifactsModelChange(modelId: string) {
		const base = baseArtifactGen();
		const model = modelStore.getById(modelId);
		updateSettings({
			artifactGenerator: { ...base, modelId, modelName: model?.engine.model.name || modelId }
		});
	}
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Artifacts</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-4">
		Model used to generate Skills, Commands, Subagents, and Instructions from a purpose.
	</p>

	<button type="button" class="flex items-center gap-3 w-full text-left mb-4" onclick={toggleArtifactsCustom}>
		<div class="relative w-9 h-5 rounded-full transition-colors duration-200 flex-shrink-0
			{artifactsCustom ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-600'}">
			<div class="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200
				{artifactsCustom ? 'translate-x-4.5' : 'translate-x-0.5'}"></div>
		</div>
		<div>
			<span class="text-sm font-medium text-slate-900 dark:text-slate-100">Use custom model</span>
			<p class="text-xs text-slate-500 dark:text-slate-400">Use a different engine and model instead of the assistant model</p>
		</div>
	</button>

	{#if artifactsCustom}
		<EngineModelPicker
			engine={artifactsEngine}
			model={artifactsModelId}
			onEngineChange={handleArtifactsEngineChange}
			onModelChange={handleArtifactsModelChange}
		/>
	{:else}
		<div class="flex items-center gap-3 px-3.5 py-2.5 border border-slate-200 dark:border-slate-700 rounded-lg bg-slate-50 dark:bg-slate-800/50">
			{#if artifactsEngineMeta}
				<div class="flex-shrink-0">
					<div class="flex dark:hidden items-center justify-center w-4 h-4">{@html artifactsEngineMeta.icon.light}</div>
					<div class="hidden dark:flex items-center justify-center w-4 h-4">{@html artifactsEngineMeta.icon.dark}</div>
				</div>
			{/if}
			<div class="flex-1 min-w-0">
				<span class="text-sm font-medium text-slate-900 dark:text-slate-100">{artifactsModelMeta?.engine.model.name || artifactsModelId}</span>
				<span class="text-xs text-slate-500 dark:text-slate-400 ml-1.5">(same as assistant)</span>
			</div>
		</div>
	{/if}
</div>
