<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import { ENGINES } from '$shared/constants/engines';
	import type { EngineType } from '$shared/types/unified';
	import { permissionsStore } from '$frontend/stores/features/permissions.svelte';

	interface Props {
		showHeader?: boolean;
	}

	const { showHeader = true }: Props = $props();

	type ListKey = 'allow' | 'deny';
	type Suggestion = { value: string; category: 'Built-in' | 'MCP' | 'Subagent' };

	let loaded = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);
	let activeEngine = $state<EngineType>(ENGINES[0].type);

	// Per-engine editable drafts, seeded from the store on load. Each engine keeps
	// its own allow/deny arrays so switching tabs preserves unsaved edits.
	let drafts = $state<Record<string, { allow: string[]; deny: string[] }>>({});

	// Combobox state — which list's dropdown is open + its current query.
	let openList = $state<ListKey | null>(null);
	let allowInput = $state('');
	let denyInput = $state('');

	const activeDraft = $derived(drafts[activeEngine] ?? { allow: [], deny: [] });

	// Full categorized suggestion set for the current engine.
	const allSuggestions = $derived.by<Suggestion[]>(() => {
		const inv = permissionsStore.inventory;
		if (!inv) return [];
		const engineInv = inv.engines.find(e => e.engine === activeEngine);
		const seen = new Set<string>();
		const out: Suggestion[] = [];
		const push = (value: string, category: Suggestion['category']) => {
			if (seen.has(value)) return;
			seen.add(value);
			out.push({ value, category });
		};
		for (const t of engineInv?.builtin ?? []) push(t, 'Built-in');
		for (const t of inv.mcp) push(t, 'MCP');
		for (const t of inv.subagent) push(t, 'Subagent');
		return out;
	});

	function engineName(type: EngineType): string {
		return ENGINES.find(e => e.type === type)?.name ?? type;
	}

	/** Suggestions filtered by query, minus anything already in either list. */
	function filteredFor(list: ListKey, query: string): Suggestion[] {
		const draft = drafts[activeEngine] ?? { allow: [], deny: [] };
		const used = new Set([...draft.allow, ...draft.deny]);
		const q = query.trim().toLowerCase();
		return allSuggestions
			.filter(s => !used.has(s.value) && (!q || s.value.toLowerCase().includes(q)))
			.slice(0, 50);
	}

	onMount(async () => {
		await Promise.all([permissionsStore.fetchSets(), permissionsStore.fetchInventory()]);
		seedDrafts();
		loaded = true;
	});

	function seedDrafts() {
		const next: Record<string, { allow: string[]; deny: string[] }> = {};
		for (const engine of ENGINES) {
			const set = permissionsStore.globalSet(engine.type);
			next[engine.type] = { allow: [...set.allow], deny: [...set.deny] };
		}
		drafts = next;
	}

	function addPattern(list: ListKey, raw: string) {
		const value = raw.trim();
		if (!value) return;
		const draft = drafts[activeEngine] ?? { allow: [], deny: [] };
		if (!draft[list].includes(value)) {
			drafts = { ...drafts, [activeEngine]: { ...draft, [list]: [...draft[list], value] } };
		}
		if (list === 'allow') allowInput = '';
		else denyInput = '';
	}

	function removePattern(list: ListKey, value: string) {
		const draft = drafts[activeEngine];
		if (!draft) return;
		drafts = { ...drafts, [activeEngine]: { ...draft, [list]: draft[list].filter(t => t !== value) } };
	}

	const dirty = $derived.by(() => {
		const set = permissionsStore.globalSet(activeEngine);
		const draft = activeDraft;
		const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
		return !same([...set.allow], draft.allow) || !same([...set.deny], draft.deny);
	});

	async function save() {
		saving = true;
		error = null;
		try {
			await permissionsStore.saveGlobal(activeEngine, activeDraft.allow, activeDraft.deny);
			seedDrafts();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Save failed';
		} finally {
			saving = false;
		}
	}
</script>

<div class="space-y-6">
	{#if showHeader}
		<div>
			<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Permissions</h3>
			<p class="text-sm text-slate-600 dark:text-slate-500">Allow or deny tools per engine.</p>
		</div>
	{/if}

	<!-- Consolidated help card (semantics + MCP + wildcard) -->
	<div class="flex items-start gap-2.5 p-3 rounded-xl bg-slate-500/5 dark:bg-slate-400/5 border border-slate-200 dark:border-slate-700/60">
		<Icon name="lucide:info" class="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
		<div class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed space-y-1">
			<p>
				<strong class="text-slate-600 dark:text-slate-300">Deny wins;</strong> set an allowlist to restrict an engine to only the listed tools.
				Rules apply globally on the next chat stream. Patterns support a trailing <code class="text-[11px]">*</code> wildcard (e.g. <code class="text-[11px]">mcp__github__*</code>).
			</p>
			<p>MCP tools are mainly managed in <strong class="text-slate-600 dark:text-slate-300">Connectors</strong> — adding one here is an extra engine-level block.</p>
		</div>
	</div>

	<!-- Engine tabs -->
	<div class="flex flex-wrap gap-1.5">
		{#each ENGINES as engine (engine.type)}
			{@const isActive = activeEngine === engine.type}
			<button
				type="button"
				onclick={() => { activeEngine = engine.type; openList = null; }}
				class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors
					{isActive
						? 'bg-violet-500/10 border-violet-500/30 text-violet-600 dark:text-violet-400'
						: 'bg-transparent border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
			>
				{engine.name}
			</button>
		{/each}
	</div>

	{#if !loaded}
		<div class="space-y-3">
			{#each [0, 1] as i (i)}
				<div class="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl animate-pulse space-y-3">
					<div class="space-y-1.5">
						<div class="h-3.5 w-16 rounded bg-slate-200 dark:bg-slate-800"></div>
						<div class="h-3 w-56 rounded bg-slate-200 dark:bg-slate-800"></div>
					</div>
					<div class="flex flex-wrap gap-1.5">
						<div class="h-5 w-20 rounded-full bg-slate-200 dark:bg-slate-800"></div>
						<div class="h-5 w-24 rounded-full bg-slate-200 dark:bg-slate-800"></div>
					</div>
					<div class="h-8 w-full rounded-lg bg-slate-200 dark:bg-slate-800"></div>
				</div>
			{/each}
		</div>
	{:else}
		<!-- Deny list -->
		{@render patternEditor('deny', 'Deny', 'Blocked tools. Denied tools never run, even if also allowed.', denyInput, (v: string) => (denyInput = v))}

		<!-- Allow list -->
		{@render patternEditor('allow', 'Allow', 'Optional allowlist. When non-empty, only these tools may run (everything else is blocked).', allowInput, (v: string) => (allowInput = v))}

		{#if error}
			<p class="text-xs text-red-500">{error}</p>
		{/if}

		<div class="flex items-center justify-end">
			<Button variant="primary" loading={saving} disabled={!dirty} onclick={save}>Save {engineName(activeEngine)}</Button>
		</div>
	{/if}
</div>

{#snippet patternEditor(list: ListKey, label: string, hint: string, inputValue: string, setInput: (v: string) => void)}
	{@const items = list === 'allow' ? activeDraft.allow : activeDraft.deny}
	{@const suggestions = openList === list ? filteredFor(list, inputValue) : []}
	{@const isDeny = list === 'deny'}
	<div class="space-y-2">
		<div>
			<p class="text-sm font-semibold text-slate-700 dark:text-slate-300">{label}</p>
			<p class="text-[11px] text-slate-400">{hint}</p>
		</div>

		{#if items.length > 0}
			<div class="flex flex-wrap gap-1.5">
				{#each items as pattern (pattern)}
					<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono font-semibold
						{isDeny
							? 'bg-red-500/10 text-red-600 dark:text-red-400'
							: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'}">
						{pattern}
						<button type="button" onclick={() => removePattern(list, pattern)} aria-label="Remove {pattern}" class="hover:opacity-70">
							<Icon name="lucide:x" class="w-3 h-3" />
						</button>
					</span>
				{/each}
			</div>
		{/if}

		<!-- Custom combobox: input + filtered dropdown -->
		<div class="relative">
			<div class="flex items-center gap-2">
				<div class="relative flex-1">
					<input
						type="text"
						value={inputValue}
						oninput={(e) => { setInput(e.currentTarget.value); openList = list; }}
						onfocus={() => (openList = list)}
						onblur={() => setTimeout(() => { if (openList === list) openList = null; }, 120)}
						onkeydown={(e) => {
							if (e.key === 'Enter') { e.preventDefault(); addPattern(list, e.currentTarget.value); openList = null; }
							else if (e.key === 'Escape') { openList = null; }
						}}
						placeholder="Add a tool name or pattern…"
						class="w-full px-3 py-1.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400"
					/>
					{#if openList === list && suggestions.length > 0}
						<ul class="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg py-1">
							{#each suggestions as s (s.value)}
								<li>
									<button
										type="button"
										onpointerdown={(e) => { e.preventDefault(); addPattern(list, s.value); }}
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
				<Button variant="secondary" onclick={() => addPattern(list, inputValue)}>Add</Button>
			</div>
		</div>
	</div>
{/snippet}
