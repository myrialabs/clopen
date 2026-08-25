<script lang="ts">
	/**
	 * Settings → Model → Memory.
	 *
	 * The model only, mirroring the Artifacts page next to it. What memory *does*
	 * is configured separately under Settings → Memory — they are different
	 * questions and answering both on one page made each harder to find.
	 *
	 * WHY THIS PAGE STILL EXISTS, since recording is automatic and needs no agent
	 * and no tool call: "automatic" means nobody has to ask for it, not that no
	 * model is involved. Something has to read the finished transcript and decide
	 * what in it is worth keeping weeks from now, in English, without the secrets,
	 * while judging what it supersedes and whether the memories handed to that turn
	 * actually helped. That is a model's job, and this is where it is chosen.
	 *
	 * What is genuinely free is the READ path: retrieval is BM25 plus a local
	 * lookup table plus SQL, with no model and no network call, which is why it can
	 * run on every single turn. The two are easy to conflate, and the wording on
	 * this page is deliberately explicit about which is which.
	 */
	import { onMount } from 'svelte';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { memoryGraphStore } from '$frontend/stores/features/memory-graph.svelte';
	import { settingsModalState } from '$frontend/stores/ui/settings-modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import EngineModelPicker from './EngineModelPicker.svelte';
	import type { EngineType } from '$shared/types/unified';

	let saving = $state(false);
	let error = $state<string | null>(null);

	const config = $derived(memoryGraphStore.config);
	const modelEngine = $derived((config?.model?.engine as EngineType) ?? settings.selectedEngine);
	const modelId = $derived(config?.model?.modelId ?? settings.selectedModelId);

	onMount(() => {
		void load();
	});

	async function load(): Promise<void> {
		const loaded = await memoryGraphStore.fetchConfig();
		// Default to the assistant model rather than asking. Memory that silently
		// records nothing until a dropdown is touched looks broken.
		if (loaded && !loaded.model) await save(assistantModel());
	}

	function assistantModel() {
		return {
			engine: settings.selectedEngine,
			modelId: settings.selectedModelId,
			...(settings.selectedProvider && { providerSlug: settings.selectedProvider })
		};
	}

	async function save(model: { engine: string; modelId: string; providerSlug?: string }): Promise<void> {
		saving = true;
		error = null;
		try {
			await memoryGraphStore.saveConfig({ model });
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}

	function handleEngineChange(engine: EngineType): void {
		const first = modelStore.getByEngine(engine)[0];
		void save({
			engine,
			modelId: first?.engine.model.id ?? '',
			...(first?.engine.provider && { providerSlug: first.engine.provider })
		});
		// The catalog may not be loaded for a newly-picked engine; commit again once
		// it is, so the stored model is one that actually exists.
		void modelStore.fetchModels(engine).then(fetched => {
			if (fetched.length === 0) return;
			void save({
				engine,
				modelId: fetched[0].engine.model.id,
				...(fetched[0].engine.provider && { providerSlug: fetched[0].engine.provider })
			});
		});
	}

	function handleModelChange(id: string): void {
		const model = modelStore.getById(id);
		void save({
			engine: modelEngine,
			modelId: id,
			...(model?.engine.provider && { providerSlug: model.engine.provider })
		});
	}
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Memory</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-4">
		Reads each finished conversation and writes down what is worth keeping. The only place memory
		uses a model.
	</p>

	<!--
		Same shape as the card on Settings → Model → Assistant, and here for the same
		reason: this page answers one of two questions and the other one is a click
		away. It also settles the confusion the page kept causing — "automatic" means
		nobody has to ask for a memory to be recorded, not that no model is involved,
		and the READ path is the half that is genuinely free.
	-->
	<div class="flex items-start gap-2.5 p-3 mb-4 rounded-xl bg-slate-500/5 dark:bg-slate-400/5 border border-slate-200 dark:border-slate-700/60">
		<Icon name="lucide:info" class="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
		<p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
			This model only WRITES memories. Recalling them costs no model call and no network request at
			all, which is why it can run on every turn. What gets recorded, and how much is recalled, is
			set under <button type="button" class="text-violet-600 dark:text-violet-400 hover:underline cursor-pointer font-medium" onclick={() => (settingsModalState.activeSection = 'memory-graph')}>Settings → Infrastructure → Memory</button>.
		</p>
	</div>

	{#if error}
		<div class="mb-4 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-xs text-red-600 dark:text-red-400">
			{error}
		</div>
	{/if}

	{#if !config}
		<p class="text-sm text-slate-400">Loading…</p>
	{:else}
		<EngineModelPicker
			engine={modelEngine}
			model={modelId}
			onEngineChange={handleEngineChange}
			onModelChange={handleModelChange}
		/>

		<p class="mt-3 text-xs text-slate-500 dark:text-slate-400">
			Runs in the background the moment a turn finishes, never while you wait for a reply. A slower
			choice here only delays when a new memory becomes searchable.
			{#if saving}<span class="text-slate-400"> · saving…</span>{/if}
		</p>
	{/if}
</div>
