<script lang="ts">
	/**
	 * One job a model does, as a row: what it is for, what it runs on — the
	 * free model or one picked for it — and, opened, the choice between the two
	 * with a compact picker. Only on the Models page; other menus show the
	 * job's model as a link here (`ModelPurposeLink`), which opens this row.
	 */
	import { onMount, tick } from 'svelte';
	import { slide } from 'svelte/transition';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import { assistantStore } from '$frontend/stores/features/assistant.svelte';
	import { settingsModalState } from '$frontend/stores/ui/settings-modal.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import type { EngineType } from '$shared/types/unified';
	import EngineModelPicker from './EngineModelPicker.svelte';
	import { modelFor, modelSummary, purposeInfo, savePurposeModel, type ModelPurposeId } from './purposes.svelte';

	interface Props {
		purpose: ModelPurposeId;
	}

	const { purpose }: Props = $props();
	let open = $state(false);
	/** "A model of its own" chosen, not saved yet: the picker shows before a model is picked. */
	let choosing = $state(false);
	let row = $state<HTMLElement>();

	const info = $derived(purposeInfo(purpose));
	const current = $derived(modelFor(purpose));
	const summary = $derived(modelSummary(purpose));
	const own = $derived(!current.free || choosing);
	// What the picker starts on: the job's model, else the free one, else the project chat's.
	const shown = $derived(
		current.model ?? assistantStore.freeModel ?? { engine: settings.selectedEngine, provider: settings.selectedProvider, modelId: settings.selectedModelId, modelName: settings.selectedModelName }
	);

	// Opened from a link in another menu: this row, open and in view.
	onMount(() => {
		if (settingsModalState.modelsFocus !== purpose) return;
		settingsModalState.modelsFocus = null;
		open = true;
		void tick().then(() => row?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
	});

	async function save(model: Parameters<typeof savePurposeModel>[1]) {
		try {
			await savePurposeModel(purpose, model);
			choosing = false;
		} catch (error) {
			addNotification({ type: 'error', title: 'Could not save the model', message: error instanceof Error ? error.message : String(error) });
		}
	}

	async function changeEngine(engine: EngineType) {
		const models = await modelStore.fetchModels(engine);
		const first = models[0];
		if (first) await save({ engine, provider: first.engine.provider, modelId: first.engine.model.id, modelName: first.engine.model.name });
	}

	async function changeModel(modelId: string) {
		const model = modelStore.getById(modelId);
		await save({ engine: (model?.engine.type ?? shown.engine) as string, provider: model?.engine.provider ?? shown.provider, modelId, modelName: model?.engine.model.name ?? modelId });
	}

	const chip = (active: boolean) =>
		`px-2.5 py-1 rounded-md text-xs border cursor-pointer ${active ? 'border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300' : 'border-slate-200 dark:border-slate-700 bg-transparent text-slate-600 dark:text-slate-300 hover:border-violet-500/40'}`;
</script>

<div class="rounded-xl border border-slate-200 dark:border-slate-800 scroll-mt-4" bind:this={row}>
	<button type="button" class="flex items-center gap-3 w-full px-4 py-3 text-left bg-transparent border-none cursor-pointer" onclick={() => (open = !open)} aria-expanded={open}>
		<div class="flex-1 min-w-0">
			<p class="text-sm font-semibold text-slate-900 dark:text-slate-100">{info.label}</p>
			<p class="text-xs text-slate-500 dark:text-slate-400 truncate">{info.description}</p>
		</div>
		<span class="max-w-[45%] truncate text-xs {current.free ? 'text-slate-500' : 'text-slate-800 dark:text-slate-200 font-medium'}">{summary}</span>
		<Icon name="lucide:chevron-down" class="w-4 h-4 text-slate-400 shrink-0 transition-transform {open ? 'rotate-180' : ''}" />
	</button>
	{#if open}
		<div class="px-4 pb-4 border-t border-slate-200 dark:border-slate-800 pt-3" transition:slide={{ duration: 180 }}>
			<div class="flex items-center gap-2 mb-3">
				<button type="button" class={chip(!own)} onclick={() => (current.free ? (choosing = false) : save(null))}>Free model</button>
				<button type="button" class={chip(own)} onclick={() => (choosing = true)}>Choose a model</button>
			</div>
			{#if own}
				<EngineModelPicker engine={shown.engine as EngineType} model={shown.modelId} onEngineChange={changeEngine} onModelChange={changeModel} />
			{/if}
		</div>
	{/if}
</div>
