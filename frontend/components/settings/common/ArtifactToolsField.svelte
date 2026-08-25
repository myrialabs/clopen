<script lang="ts">
	/**
	 * Per-engine tool allowlist for subagents. Mirrors the "Permission overlay"
	 * combobox in Settings → Profiles: engine tabs, each with a chip list + typed
	 * suggestions drawn from that engine's tool inventory.
	 *
	 * Tools are stored per engine (EngineType → comma-separated list; absent/empty
	 * = all tools). Only Claude reads a native allowlist today; other engines are
	 * best-effort (OpenCode drops it, the rest have no per-agent slot).
	 */
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import { permissionsStore } from '$frontend/stores/features/permissions.svelte';
	import type { EngineValueMap } from '$frontend/stores/features/artifacts';
	import { ENGINES } from '$shared/constants/engines';
	import type { EngineType } from '$shared/types/unified';

	interface Props {
		value: EngineValueMap;
		onChange: (next: EngineValueMap) => void;
		label?: string;
	}

	let { value, onChange, label = 'Tool allowlist' }: Props = $props();

	let showConfig = $state(false);
	let activeEngine = $state<EngineType>(ENGINES[0].type);
	let toolInput = $state('');
	let listOpen = $state(false);

	onMount(() => { void permissionsStore.fetchInventory(); });

	const configuredCount = $derived(Object.values(value).filter(v => v && v.trim()).length);

	function toolsFor(engine: EngineType): string[] {
		return (value[engine] ?? '').split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
	}
	const activeTools = $derived(toolsFor(activeEngine));

	const suggestions = $derived.by<{ value: string; category: 'Built-in' | 'MCP' }[]>(() => {
		const inv = permissionsStore.inventory;
		if (!inv) return [];
		const seen = new Set<string>();
		const out: { value: string; category: 'Built-in' | 'MCP' }[] = [];
		const push = (v: string, category: 'Built-in' | 'MCP') => {
			if (seen.has(v)) return;
			seen.add(v);
			out.push({ value: v, category });
		};
		for (const t of inv.engines.find(e => e.engine === activeEngine)?.builtin ?? []) push(t, 'Built-in');
		for (const t of inv.mcp) push(t, 'MCP');
		return out;
	});
	const filtered = $derived.by(() => {
		const used = new Set(activeTools);
		const q = toolInput.trim().toLowerCase();
		return suggestions.filter(s => !used.has(s.value) && (!q || s.value.toLowerCase().includes(q))).slice(0, 50);
	});

	function setTools(engine: EngineType, tools: string[]) {
		const next = { ...value };
		if (tools.length) next[engine] = tools.join(', '); else delete next[engine];
		onChange(next);
	}
	function addTool(raw: string) {
		const v = raw.trim();
		if (!v) return;
		if (!activeTools.includes(v)) setTools(activeEngine, [...activeTools, v]);
		toolInput = '';
	}
	function removeTool(v: string) {
		setTools(activeEngine, activeTools.filter(t => t !== v));
	}

	function openConfig() {
		activeEngine = ENGINES[0].type;
		toolInput = '';
		showConfig = true;
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
		{#if configuredCount === 0}
			<Icon name="lucide:wrench" class="w-4 h-4 text-slate-400 flex-shrink-0" />
			<span class="flex-1 min-w-0 text-sm text-slate-500 dark:text-slate-400">All tools <span class="text-xs">— no per-engine restriction</span></span>
		{:else}
			<div class="flex-1 min-w-0 flex flex-wrap items-center gap-1.5">
				{#each ENGINES as engine (engine.type)}
					{@const n = toolsFor(engine.type).length}
					{#if n > 0}
						<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-violet-500/10 text-violet-600 dark:text-violet-400">
							{engine.name}: {n} tool{n === 1 ? '' : 's'}
						</span>
					{/if}
				{/each}
			</div>
		{/if}
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
				Restrict which tools this subagent may use, per engine. Leave an engine empty to allow all tools.
			</p>

			<!-- Engine tabs -->
			<div class="flex flex-wrap gap-1">
				{#each ENGINES as engine (engine.type)}
					{@const n = toolsFor(engine.type).length}
					<button
						type="button"
						onclick={() => { activeEngine = engine.type; toolInput = ''; }}
						class="px-2.5 py-1 rounded-lg text-xs border transition-colors {activeEngine === engine.type
							? 'bg-violet-600 border-violet-600 text-white'
							: 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-violet-400'}"
					>
						{engine.name}{#if n > 0}<span class="ml-1 opacity-70">({n})</span>{/if}
					</button>
				{/each}
			</div>

			{#if activeTools.length > 0}
				<div class="flex flex-wrap gap-1.5">
					{#each activeTools as tool (tool)}
						<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono font-semibold bg-violet-500/10 text-violet-600 dark:text-violet-400">
							{tool}
							<button type="button" onclick={() => removeTool(tool)} aria-label="Remove {tool}" class="hover:opacity-70">
								<Icon name="lucide:x" class="w-3 h-3" />
							</button>
						</span>
					{/each}
				</div>
			{/if}

			<div class="relative">
				<input
					type="text"
					value={toolInput}
					oninput={(e) => { toolInput = e.currentTarget.value; listOpen = true; }}
					onfocus={() => (listOpen = true)}
					onblur={() => setTimeout(() => (listOpen = false), 120)}
					onkeydown={(e) => {
						if (e.key === 'Enter') { e.preventDefault(); addTool(e.currentTarget.value); listOpen = false; }
						else if (e.key === 'Escape') { listOpen = false; }
					}}
					placeholder="Add a tool name…"
					class="w-full px-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400"
				/>
				{#if listOpen && filtered.length > 0}
					<ul class="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg py-1">
						{#each filtered as s (s.value)}
							<li>
								<button
									type="button"
									onpointerdown={(e) => { e.preventDefault(); addTool(s.value); }}
									class="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-left hover:bg-violet-500/10 transition-colors group"
								>
									<span class="text-xs font-mono text-slate-700 dark:text-slate-200 truncate">{s.value}</span>
									<span class="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400 group-hover:text-violet-500">{s.category}</span>
								</button>
							</li>
						{/each}
					</ul>
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
