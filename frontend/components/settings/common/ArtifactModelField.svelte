<script lang="ts">
	/**
	 * Per-engine model picker for artifacts (Commands / Subagents). Mirrors the
	 * "Permission overlay" in Settings → Profiles: engine tabs, each engine either
	 * Inherits the session model or pins a specific model from that engine's catalog.
	 *
	 * An artifact is materialized into every engine, so model is stored per engine
	 * (EngineType → model id; absent = inherit). Model only truly applies where the
	 * engine has a native slot (Claude, OpenCode); other engines are best-effort.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import type { EngineValueMap } from '$frontend/stores/features/artifacts';
	import { ENGINES } from '$shared/constants/engines';
	import type { EngineType, EngineModel } from '$shared/types/unified';
	import { formatProvider } from '$frontend/utils/format';

	interface Props {
		value: EngineValueMap;
		onChange: (next: EngineValueMap) => void;
		label?: string;
	}

	let { value, onChange, label = 'Model' }: Props = $props();

	let showConfig = $state(false);
	let activeEngine = $state<EngineType>(ENGINES[0].type);
	let searchQuery = $state('');
	let loadingModels = $state(false);
	// Models for the ACTIVE engine only — kept in local state (not derived from the
	// shared store) so a tab switch clears the list immediately and the previous
	// engine's models can never linger while the new engine loads.
	let engineModels = $state<EngineModel[]>([]);

	// Resolve a model id to a display name (best-effort — needs the engine fetched).
	function modelName(id: string): string {
		return modelStore.getById(id)?.engine.model.name ?? id;
	}

	function openConfig() {
		activeEngine = ENGINES[0].type;
		searchQuery = '';
		showConfig = true;
	}

	async function loadEngine(engine: EngineType) {
		loadingModels = true;
		engineModels = []; // clear immediately → no stale list from the previous tab
		try {
			const fetched = await modelStore.fetchModels(engine);
			if (activeEngine !== engine) return; // superseded by a newer tab switch
			// Some catalogs (e.g. OpenCode) repeat a model id across providers; dedupe
			// by provider+id so the keyed list stays unique.
			const seen = new Set<string>();
			engineModels = fetched.filter(m => {
				if (!(m.modalities.input.text && m.modalities.output.text && m.capabilities.tools)) return false;
				const key = `${m.engine.provider}/${m.engine.model.id}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		} finally {
			if (activeEngine === engine) loadingModels = false;
		}
	}

	// Reload whenever the tab changes while the modal is open.
	$effect(() => {
		if (showConfig) void loadEngine(activeEngine);
	});

	const activeModels = $derived.by(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return engineModels;
		return engineModels.filter(m =>
			m.engine.model.name.toLowerCase().includes(q) || m.engine.model.id.toLowerCase().includes(q)
		);
	});

	function setEngineModel(engine: EngineType, modelId: string | null) {
		const next = { ...value };
		if (modelId) next[engine] = modelId; else delete next[engine];
		onChange(next);
	}
</script>

<div class="space-y-1">
	<div class="flex items-center justify-between">
		<span class="block text-sm font-semibold text-slate-700 dark:text-slate-300">{label} <span class="text-slate-400 font-normal">(optional)</span></span>
		<button
			type="button"
			onclick={openConfig}
			class="flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300 transition-colors cursor-pointer"
		>
			<Icon name="lucide:settings-2" class="w-3 h-3" />
			Configure
		</button>
	</div>
	<button
		type="button"
		onclick={openConfig}
		class="flex items-center gap-2 w-full px-3.5 py-2.5 border border-slate-200 dark:border-slate-700 rounded-lg bg-slate-50 dark:bg-slate-800/50 text-left hover:border-violet-400 transition-colors"
	>
		<div class="flex-1 min-w-0 flex flex-wrap items-center gap-1.5">
			{#each ENGINES as engine (engine.type)}
				{@const custom = value[engine.type]}
				<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium {custom
					? 'bg-violet-500/10 text-violet-600 dark:text-violet-400'
					: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'}">
					{engine.name}: {custom ? modelName(custom) : 'Inherit'}
				</span>
			{/each}
		</div>
	</button>
</div>

<Modal isOpen={showConfig} onClose={() => (showConfig = false)} size="lg">
	{#snippet header()}
		<div class="flex items-center justify-between px-4 py-3 md:px-5 md:py-4">
			<h2 class="text-base font-bold text-slate-900 dark:text-slate-100">Configure {label}</h2>
			<button type="button" class="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-violet-500/10 transition-colors cursor-pointer" onclick={() => (showConfig = false)}>
				<Icon name="lucide:x" class="w-4 h-4" />
			</button>
		</div>
	{/snippet}
	{#snippet children()}
		<div class="space-y-4">
			<p class="text-xs text-slate-500 dark:text-slate-400">
				Pick a model per engine, or leave it on Inherit. A model only applies while the session runs on that engine.
			</p>

			<!-- Engine tabs -->
			<div class="flex flex-wrap gap-1">
				{#each ENGINES as engine (engine.type)}
					<button
						type="button"
						onclick={() => { activeEngine = engine.type; searchQuery = ''; }}
						class="px-2.5 py-1 rounded-lg text-xs border transition-colors {activeEngine === engine.type
							? 'bg-violet-600 border-violet-600 text-white'
							: 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-violet-400'}"
					>
						{engine.name}{#if value[engine.type]}<span class="ml-1 opacity-70">•</span>{/if}
					</button>
				{/each}
			</div>

			<!-- Inherit option -->
			<button
				type="button"
				onclick={() => setEngineModel(activeEngine, null)}
				class="flex items-center gap-3 w-full px-3 py-2 rounded-lg border transition-colors text-left {!value[activeEngine]
					? 'border-violet-600 bg-violet-500/5'
					: 'border-slate-200 dark:border-slate-700 hover:border-violet-400'}"
			>
				<div class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 {!value[activeEngine] ? 'border-violet-600' : 'border-slate-300 dark:border-slate-600'}">
					{#if !value[activeEngine]}<div class="w-2 h-2 rounded-full bg-violet-600"></div>{/if}
				</div>
				<span class="text-sm text-slate-700 dark:text-slate-200">Inherit <span class="text-xs text-slate-400">— use the session's model</span></span>
			</button>

			<!-- Search -->
			<div class="relative">
				<svg viewBox="0 0 24 24" fill="none" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" aria-hidden="true">
					<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
					<path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
				</svg>
				<input
					type="text"
					bind:value={searchQuery}
					placeholder="Search models…"
					class="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400"
				/>
			</div>

			<!-- Model list for the active engine -->
			<div class="max-h-72 overflow-y-auto flex flex-col gap-1">
				{#if loadingModels}
					{#each [0, 1, 2, 3] as i (i)}
						<div class="flex items-center gap-3 px-3 py-2">
							<div class="w-4 h-4 rounded-full bg-slate-200 dark:bg-slate-700 animate-pulse shrink-0"></div>
							<div class="h-3.5 w-40 rounded bg-slate-200 dark:bg-slate-700 animate-pulse"></div>
						</div>
					{/each}
				{:else if activeModels.length === 0}
					<div class="py-4 text-sm text-slate-500 text-center">
						{modelStore.getError(activeEngine) ?? 'No models available for this engine.'}
					</div>
				{:else}
					{#each activeModels as mdl (`${mdl.engine.provider}/${mdl.engine.model.id}`)}
						{@const selected = value[activeEngine] === mdl.engine.model.id}
						<button
							type="button"
							onclick={() => setEngineModel(activeEngine, mdl.engine.model.id)}
							class="flex items-start gap-3 px-3 py-2 rounded-lg text-left transition-colors {selected ? 'bg-violet-500/10' : 'hover:bg-slate-100/80 dark:hover:bg-slate-700/30'}"
						>
							<div class="w-4 h-4 rounded-full border-2 flex items-center justify-center mt-0.5 shrink-0 {selected ? 'border-violet-600' : 'border-slate-300 dark:border-slate-600'}">
								{#if selected}<div class="w-2 h-2 rounded-full bg-violet-600"></div>{/if}
							</div>
							<div class="flex-1 min-w-0">
								<span class="text-sm font-medium text-slate-900 dark:text-slate-100">{mdl.engine.model.name}</span>
								<span class="ml-1.5 text-2xs text-slate-400 dark:text-slate-500">{formatProvider(mdl.engine.provider)}</span>
							</div>
						</button>
					{/each}
				{/if}
			</div>
		</div>
	{/snippet}
	{#snippet footer()}
		<button type="button" onclick={() => (showConfig = false)} class="inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors cursor-pointer">
			Done
		</button>
	{/snippet}
</Modal>
