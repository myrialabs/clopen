<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Input from '$frontend/components/common/form/Input.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import { ENGINES } from '$shared/constants/engines';
	import type { EngineType } from '$shared/types/unified';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import {
		profilesStore,
		type Profile,
		type ProfileItemType,
		type ProfileInventoryEntry
	} from '$frontend/stores/features/profiles.svelte';
	import { permissionsStore } from '$frontend/stores/features/permissions.svelte';
	import { debug } from '$shared/utils/logger';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		showHeader?: boolean;
	}
	const { showHeader = true }: Props = $props();

	const profiles = $derived(profilesStore.profiles);
	const inventory = $derived(profilesStore.inventory);

	const TYPE_META: { type: ProfileItemType; label: string; icon: IconName }[] = [
		{ type: 'skill', label: 'Skills', icon: 'lucide:graduation-cap' },
		{ type: 'command', label: 'Commands', icon: 'lucide:terminal' },
		{ type: 'subagent', label: 'Subagents', icon: 'lucide:bot' },
		{ type: 'mcp', label: 'Connectors', icon: 'lucide:plug' }
	];

	let listFilter = $state('');
	let projectDefaultId = $state<number | null>(null);

	const filteredProfiles = $derived.by(() => {
		const q = listFilter.trim().toLowerCase();
		if (!q) return profiles;
		return profiles.filter(p => `${p.name} ${p.description}`.toLowerCase().includes(q));
	});

	async function refreshProjectDefault() {
		const projectId = projectState.currentProject?.id;
		projectDefaultId = projectId ? await profilesStore.projectDefault(projectId) : null;
	}

	onMount(() => {
		void profilesStore.refresh();
		void profilesStore.fetchInventory();
		void permissionsStore.fetchInventory();
		void refreshProjectDefault();
	});

	async function toggleDefault(profile: Profile) {
		const projectId = projectState.currentProject?.id;
		if (!projectId) return;
		const next = projectDefaultId === profile.id ? null : profile.id;
		await profilesStore.setProjectDefault(projectId, next);
		projectDefaultId = next;
	}

	// ── Editor ─────────────────────────────────────────────────────────────────
	type Draft = { allow: string[]; deny: string[] };
	let editorOpen = $state(false);
	let editorMode = $state<'create' | 'edit'>('create');
	let editorId = $state<number | null>(null);
	let edName = $state('');
	let edDescription = $state('');
	let edSelected = $state<Record<ProfileItemType, Set<string>>>({ skill: new Set(), command: new Set(), subagent: new Set(), mcp: new Set() });
	let editorError = $state<string | null>(null);
	let editorSaving = $state(false);

	// Permission overlay drafts, per engine, edited with the same combobox as the
	// Permissions section.
	let showPerms = $state(false);
	let permDrafts = $state<Record<string, Draft>>({});
	let activeEngine = $state<EngineType>(ENGINES[0].type);
	type ListKey = 'allow' | 'deny';
	type Suggestion = { value: string; category: 'Built-in' | 'MCP' | 'Subagent' };
	let openList = $state<ListKey | null>(null);
	let allowInput = $state('');
	let denyInput = $state('');

	function emptySelected(): Record<ProfileItemType, Set<string>> {
		return { skill: new Set(), command: new Set(), subagent: new Set(), mcp: new Set() };
	}
	function emptyPermDrafts(): Record<string, Draft> {
		const out: Record<string, Draft> = {};
		for (const e of ENGINES) out[e.type] = { allow: [], deny: [] };
		return out;
	}

	function openCreate() {
		editorMode = 'create';
		editorId = null;
		edName = '';
		edDescription = '';
		edSelected = emptySelected();
		permDrafts = emptyPermDrafts();
		showPerms = false;
		activeEngine = ENGINES[0].type;
		editorError = null;
		editorOpen = true;
	}

	async function openEdit(profile: Profile) {
		editorMode = 'edit';
		editorId = profile.id;
		edName = profile.name;
		edDescription = profile.description;
		edSelected = {
			skill: new Set(profile.items.skill),
			command: new Set(profile.items.command),
			subagent: new Set(profile.items.subagent),
			mcp: new Set(profile.items.mcp)
		};
		permDrafts = emptyPermDrafts();
		showPerms = false;
		activeEngine = ENGINES[0].type;
		editorError = null;
		editorOpen = true;
		try {
			const sets = await profilesStore.getPermissions(profile.id);
			const next = emptyPermDrafts();
			for (const s of sets) next[s.engine] = { allow: [...s.allow], deny: [...s.deny] };
			permDrafts = next;
			if (sets.some(s => s.allow.length || s.deny.length)) showPerms = true;
		} catch (error) {
			debug.error('settings', 'load profile permissions failed', error);
		}
	}

	function closeEditor() {
		editorOpen = false;
		editorError = null;
	}

	function toggleItem(type: ProfileItemType, slug: string) {
		const set = new Set(edSelected[type]);
		if (set.has(slug)) set.delete(slug); else set.add(slug);
		edSelected = { ...edSelected, [type]: set };
	}

	const totalSelected = $derived(TYPE_META.reduce((n, t) => n + edSelected[t.type].size, 0));

	function invFor(type: ProfileItemType): ProfileInventoryEntry[] {
		return inventory?.[type] ?? [];
	}

	// ── Permission combobox (mirrors PermissionsSettings) ───────────────────────
	const activeDraft = $derived(permDrafts[activeEngine] ?? { allow: [], deny: [] });
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
	function filteredFor(list: ListKey, query: string): Suggestion[] {
		const draft = permDrafts[activeEngine] ?? { allow: [], deny: [] };
		const used = new Set([...draft.allow, ...draft.deny]);
		const q = query.trim().toLowerCase();
		return allSuggestions.filter(s => !used.has(s.value) && (!q || s.value.toLowerCase().includes(q))).slice(0, 50);
	}
	function addPattern(list: ListKey, raw: string) {
		const value = raw.trim();
		if (!value) return;
		const draft = permDrafts[activeEngine] ?? { allow: [], deny: [] };
		if (!draft[list].includes(value)) {
			permDrafts = { ...permDrafts, [activeEngine]: { ...draft, [list]: [...draft[list], value] } };
		}
		if (list === 'allow') allowInput = ''; else denyInput = '';
	}
	function removePattern(list: ListKey, value: string) {
		const draft = permDrafts[activeEngine];
		if (!draft) return;
		permDrafts = { ...permDrafts, [activeEngine]: { ...draft, [list]: draft[list].filter(t => t !== value) } };
	}

	async function saveEditor() {
		if (!edName.trim()) { editorError = 'A name is required'; return; }
		editorSaving = true;
		editorError = null;
		try {
			const payload = {
				name: edName.trim(),
				description: edDescription.trim(),
				items: {
					skill: Array.from(edSelected.skill),
					command: Array.from(edSelected.command),
					subagent: Array.from(edSelected.subagent),
					mcp: Array.from(edSelected.mcp)
				}
			};
			const profile = editorMode === 'create'
				? await profilesStore.create(payload)
				: await profilesStore.update(editorId!, payload);
			// Persist the per-engine overlay. In edit mode every engine is written
			// (so cleared lists delete their row); in create mode only non-empty ones.
			for (const engine of ENGINES) {
				const d = permDrafts[engine.type] ?? { allow: [], deny: [] };
				if (d.allow.length || d.deny.length || editorMode === 'edit') {
					await profilesStore.savePermissions(profile.id, engine.type, d.allow, d.deny);
				}
			}
			closeEditor();
		} catch (error) {
			editorError = error instanceof Error ? error.message : 'Save failed';
		} finally {
			editorSaving = false;
		}
	}

	// ── Delete ───────────────────────────────────────────────────────────────
	let deleteTarget = $state<Profile | null>(null);
	let deleting = $state(false);

	async function confirmDelete() {
		if (!deleteTarget) return;
		deleting = true;
		try {
			await profilesStore.remove(deleteTarget.id);
			if (projectDefaultId === deleteTarget.id) projectDefaultId = null;
			deleteTarget = null;
		} catch (error) {
			debug.error('settings', 'delete profile failed', error);
		} finally {
			deleting = false;
		}
	}
</script>

<div class="space-y-6">
	<div class="flex items-start justify-between gap-3">
		{#if showHeader}
			<div>
				<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Profiles</h3>
				<p class="text-sm text-slate-600 dark:text-slate-500">
					Reusable tool bundles. Pick one per session to scope what's active.
				</p>
			</div>
		{:else}
			<div></div>
		{/if}
	</div>

	{#if profiles.length === 0}
		<div class="flex flex-col items-center gap-2 py-10 text-center">
			<Icon name="lucide:layers" class="w-8 h-8 text-slate-400" />
			<p class="text-sm text-slate-500 dark:text-slate-400">No profiles yet.</p>
			<Button variant="primary" size="sm" class="gap-1.5" onclick={openCreate}>
				<Icon name="lucide:plus" class="w-4 h-4" />
				Create profile
			</Button>
		</div>
	{:else}
		<div class="flex items-center gap-2">
			<div class="relative flex-1">
				<svg viewBox="0 0 24 24" fill="none" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" aria-hidden="true">
					<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
					<path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
				</svg>
				<input
					type="text"
					bind:value={listFilter}
					placeholder="Filter profiles…"
					class="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400"
				/>
			</div>
			<Button variant="primary" size="sm" class="gap-1.5 shrink-0" onclick={openCreate}>
				<Icon name="lucide:plus" class="w-4 h-4" />
				Create
			</Button>
		</div>
		{#if filteredProfiles.length === 0}
			<p class="text-sm text-slate-500 dark:text-slate-400 text-center py-6">No profile matches "{listFilter}".</p>
		{:else}
			<div class="space-y-3">
				{#each filteredProfiles as profile (profile.id)}
					{@const isDefault = projectDefaultId === profile.id}
					<div class="flex items-start gap-3 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
						<Icon name="lucide:layers" class="w-5 h-5 mt-0.5 shrink-0 text-violet-600" />
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2 flex-wrap">
								<span class="font-semibold text-slate-900 dark:text-slate-100">{profile.name}</span>
								<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">{profile.itemCount} item{profile.itemCount === 1 ? '' : 's'}</span>
								{#if isDefault}
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300 font-semibold">project default</span>
								{/if}
							</div>
							{#if profile.description}
								<p class="text-xs text-slate-500 dark:text-slate-400 mt-1.5 line-clamp-2">{profile.description}</p>
							{/if}
							<div class="flex items-center gap-3 flex-wrap mt-2">
								{#each TYPE_META as tm}
									{#if profile.items[tm.type].length > 0}
										<span class="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
											<Icon name={tm.icon} class="w-3.5 h-3.5" />
											{profile.items[tm.type].length} {tm.label.toLowerCase()}
										</span>
									{/if}
								{/each}
							</div>
						</div>
						<div class="flex items-center gap-1 shrink-0">
							{#if projectState.currentProject}
								<button
									type="button"
									class="p-1.5 rounded-lg transition-colors {isDefault ? 'text-violet-600' : 'text-slate-400 hover:text-violet-500'}"
									onclick={() => toggleDefault(profile)}
									title={isDefault ? 'Unpin as project default' : 'Pin as default for this project'}
								>
									<Icon name={isDefault ? 'lucide:pin' : 'lucide:pin-off'} class="w-4 h-4" />
								</button>
							{/if}
							<Button variant="ghost" size="sm" class="gap-1.5" onclick={() => openEdit(profile)}>
								<Icon name="lucide:pencil" class="w-4 h-4" />
								Edit
							</Button>
							<Button variant="ghost" size="sm" class="!text-red-600" onclick={() => (deleteTarget = profile)}>
								<Icon name="lucide:trash-2" class="w-4 h-4" />
							</Button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<!-- Editor modal -->
<Modal isOpen={editorOpen} onClose={closeEditor} title={editorMode === 'create' ? 'Create profile' : 'Edit profile'} size="lg">
	{#snippet children()}
		<div class="space-y-4 text-sm">
			<Input label="Name" required type="text" placeholder="e.g. Frontend mode" bind:value={edName} />
			<Input label="Description" type="text" placeholder="What this profile is for" bind:value={edDescription} />

			<p class="text-xs text-slate-500 dark:text-slate-400">
				Pick the artifacts this profile activates. An item stays active even if globally disabled;
				a type left empty is not restricted.
			</p>

			{#each TYPE_META as tm}
				{@const entries = invFor(tm.type)}
				<div class="space-y-1.5">
					<p class="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-300">
						<Icon name={tm.icon} class="w-4 h-4" />
						{tm.label}
						{#if edSelected[tm.type].size > 0}
							<span class="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300">{edSelected[tm.type].size}</span>
						{/if}
					</p>
					{#if entries.length === 0}
						<p class="text-xs text-slate-400 dark:text-slate-500">None available.</p>
					{:else}
						<div class="flex flex-wrap gap-1.5">
							{#each entries as entry (entry.slug)}
								{@const selected = edSelected[tm.type].has(entry.slug)}
								<button
									type="button"
									onclick={() => toggleItem(tm.type, entry.slug)}
									class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border transition-colors {selected
										? 'bg-violet-600 border-violet-600 text-white'
										: 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:border-violet-400'}"
									title={entry.name}
								>
									{#if selected}<Icon name="lucide:check" class="w-3 h-3" />{/if}
									{entry.name}
								</button>
							{/each}
						</div>
					{/if}
				</div>
			{/each}

			<!-- Permission overlay (optional) -->
			<div class="border-t border-slate-200 dark:border-slate-800 pt-3">
				<button type="button" class="flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300" onclick={() => (showPerms = !showPerms)}>
					<Icon name={showPerms ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-4 h-4" />
					Permission overlay (optional)
				</button>
				{#if showPerms}
					<p class="text-xs text-slate-500 dark:text-slate-400 mt-2">
						Extra per-engine allow/deny applied while this profile is active. Deny always adds a
						restriction (unioned with global/project rules).
					</p>
					<!-- Engine tabs -->
					<div class="flex flex-wrap gap-1 mt-3">
						{#each ENGINES as engine}
							{@const d = permDrafts[engine.type]}
							{@const count = (d?.allow.length ?? 0) + (d?.deny.length ?? 0)}
							<button
								type="button"
								onclick={() => (activeEngine = engine.type)}
								class="px-2.5 py-1 rounded-lg text-xs border transition-colors {activeEngine === engine.type
									? 'bg-violet-600 border-violet-600 text-white'
									: 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-violet-400'}"
							>
								{engine.name}{#if count > 0}<span class="ml-1 opacity-70">({count})</span>{/if}
							</button>
						{/each}
					</div>

					<div class="space-y-4 mt-3">
						{#each (['allow', 'deny'] as ListKey[]) as list}
							{@const isDeny = list === 'deny'}
							{@const items = activeDraft[list]}
							{@const inputValue = isDeny ? denyInput : allowInput}
							{@const suggestions = filteredFor(list, inputValue)}
							<div class="space-y-1.5">
								<p class="text-xs font-semibold {isDeny ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}">
									{isDeny ? 'Deny' : 'Allow'}
								</p>
								{#if items.length > 0}
									<div class="flex flex-wrap gap-1.5">
										{#each items as pattern (pattern)}
											<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono font-semibold
												{isDeny ? 'bg-red-500/10 text-red-600 dark:text-red-400' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'}">
												{pattern}
												<button type="button" onclick={() => removePattern(list, pattern)} aria-label="Remove {pattern}" class="hover:opacity-70">
													<Icon name="lucide:x" class="w-3 h-3" />
												</button>
											</span>
										{/each}
									</div>
								{/if}
								<div class="relative">
									<input
										type="text"
										value={inputValue}
										oninput={(e) => { if (isDeny) denyInput = e.currentTarget.value; else allowInput = e.currentTarget.value; openList = list; }}
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
							</div>
						{/each}
					</div>
				{/if}
			</div>

			{#if editorError}
				<p class="text-xs text-red-500">{editorError}</p>
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<span class="text-xs text-slate-400 mr-auto">{totalSelected} item{totalSelected === 1 ? '' : 's'} selected</span>
		<Button variant="ghost" onclick={closeEditor}>Cancel</Button>
		<Button variant="primary" loading={editorSaving} onclick={saveEditor}>{editorMode === 'create' ? 'Create' : 'Save'}</Button>
	{/snippet}
</Modal>

<!-- Delete confirmation -->
<Modal isOpen={deleteTarget !== null} onClose={() => (deleteTarget = null)} title="Delete profile" size="sm">
	{#snippet children()}
		{#if deleteTarget}
			<p class="text-sm text-slate-600 dark:text-slate-300">
				Delete <span class="font-semibold text-slate-900 dark:text-slate-100">{deleteTarget.name}</span>?
				Sessions using it will fall back to no profile. Artifacts themselves are not affected.
			</p>
		{/if}
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (deleteTarget = null)}>Cancel</Button>
		<Button variant="primary" loading={deleting} class="!bg-red-600 hover:!bg-red-700" onclick={confirmDelete}>Delete</Button>
	{/snippet}
</Modal>
