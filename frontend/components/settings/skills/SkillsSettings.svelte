<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Input from '$frontend/components/common/form/Input.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import ArtifactGenerateBar from '$frontend/components/settings/common/ArtifactGenerateBar.svelte';
	import {
		skillsStore,
		type InstalledSkill,
		type MarketplaceSkill,
		type ParsedSkillPreview,
		type SkillTrigger
	} from '$frontend/stores/features/skills.svelte';
	import { setActiveSection } from '$frontend/stores/ui/settings-modal.svelte';
	import { debug } from '$shared/utils/logger';

	interface Props {
		showHeader?: boolean;
	}

	const { showHeader = true }: Props = $props();

	type Tab = 'installed' | 'browse';
	let activeTab = $state<Tab>('installed');

	/** Filter pills over the installed list — by how a skill is invoked. */
	type TriggerFilter = 'all' | 'auto' | 'slash';
	let triggerFilter = $state<TriggerFilter>('all');

	let installedFilter = $state('');
	let searchInput = $state(skillsStore.catalogSearch);
	let busyId = $state<number | null>(null);

	// Sentinel for infinite scroll in Browse tab
	let sentinelEl = $state<HTMLDivElement | null>(null);

	$effect(() => {
		const el = sentinelEl;
		if (!el) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting && skillsStore.catalogCursor && !skillsStore.catalogLoading) {
					skillsStore.loadMoreCatalog();
				}
			},
			{ rootMargin: '200px' }
		);
		observer.observe(el);
		return () => observer.disconnect();
	});

	const installed = $derived(skillsStore.installed);
	const catalog = $derived(skillsStore.catalog);
	const installedRefs = $derived(skillsStore.installedRefs);

	const counts = $derived({
		all: installed.length,
		auto: installed.filter(s => s.triggers.includes('auto')).length,
		slash: installed.filter(s => s.triggers.includes('slash')).length
	});

	const filteredInstalled = $derived.by(() => {
		const q = installedFilter.trim().toLowerCase();
		return installed
			.filter(s => triggerFilter === 'all' || s.triggers.includes(triggerFilter))
			.filter(s => !q || `${s.name} ${s.slug} ${s.description}`.toLowerCase().includes(q));
	});

	// Only surface UNMANAGED on-disk items (found, not yet adopted). Managed copies
	// already appear in the list above.
	const detected = $derived(
		skillsStore.detected
			.map(g => ({ engine: g.engine, detected: g.detected.filter(d => d.adoptable && !d.managed) }))
			.filter(g => g.detected.length > 0)
	);
	let adoptingKey = $state<string | null>(null);

	async function adopt(engine: string, slug: string, path: string) {
		adoptingKey = `${engine}:${slug}`;
		try {
			await skillsStore.adopt(engine, slug, path);
		} catch (error) {
			debug.error('settings', 'adopt skill failed', error);
		} finally {
			adoptingKey = null;
		}
	}

	onMount(() => {
		void skillsStore.refreshInstalled();
		void skillsStore.refreshDetected();
	});

	// --- Editor modal (create / edit) ---
	let editorOpen = $state(false);
	let editorMode = $state<'create' | 'edit'>('create');
	let editorId = $state<number | null>(null);
	let edName = $state('');
	let edSlug = $state('');
	/** True once the user types in the id field, which stops it tracking the name. */
	let edSlugTouched = $state(false);
	let edDescription = $state('');
	let edLicense = $state('');
	let edBody = $state('');
	let edTriggers = $state<SkillTrigger[]>(['auto']);
	let edArgumentHint = $state('');
	let edUses = $state<string[]>([]);
	let editorError = $state<string | null>(null);
	let editorSaving = $state(false);

	const edIsSlash = $derived(edTriggers.includes('slash'));
	const edIsAuto = $derived(edTriggers.includes('auto'));

	/** Normalise the way the backend does, so the field shows the id that will be saved. */
	function toSlug(input: string): string {
		return input
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 64)
			.replace(/-+$/g, '');
	}

	// While creating, the id follows the name — which is what made the old
	// behaviour feel like magic, except now it is visible and can be overridden.
	$effect(() => {
		if (editorMode === 'create' && !edSlugTouched) edSlug = toSlug(edName);
	});
	/**
	 * Example body, shown as the placeholder so it never has to be deleted before
	 * writing. Derived rather than seeded once, so switching "How it runs" to
	 * "As a command" swaps in an example that actually uses `$ARGUMENTS`.
	 */
	const edBodyPlaceholder = $derived(
		edIsSlash
			? 'Review pull request $ARGUMENTS.\n\nSummarise what changed, then flag anything risky.'
			: '# Instructions\n\nStep-by-step guidance the agent follows when this skill runs.'
	);
	/** Skills this one may require — itself excluded, since a cycle loads nothing extra. */
	const usableSkills = $derived(installed.filter(s => s.id !== editorId));

	function toggleTrigger(trigger: SkillTrigger) {
		const next = edTriggers.includes(trigger)
			? edTriggers.filter(t => t !== trigger)
			: [...edTriggers, trigger];
		// A skill nobody can invoke is not a state worth allowing — keep the last one on.
		edTriggers = next.length > 0 ? next : edTriggers;
	}

	function toggleUses(slug: string) {
		edUses = edUses.includes(slug) ? edUses.filter(u => u !== slug) : [...edUses, slug];
	}

	function openCreate() {
		editorMode = 'create';
		editorId = null;
		edName = '';
		edSlug = '';
		edSlugTouched = false;
		edDescription = '';
		edLicense = '';
		edTriggers = triggerFilter === 'slash' ? ['slash'] : ['auto'];
		edBody = '';
		edArgumentHint = '';
		edUses = [];
		editorError = null;
		editorOpen = true;
	}

	async function openEdit(skill: InstalledSkill) {
		editorMode = 'edit';
		editorId = skill.id;
		edName = skill.name;
		edSlug = skill.slug;
		edSlugTouched = true;
		edDescription = skill.description;
		edLicense = skill.license ?? '';
		edBody = '';
		edTriggers = [...skill.triggers];
		edArgumentHint = skill.argumentHint ?? '';
		edUses = [...skill.uses];
		editorError = null;
		editorOpen = true;
		try {
			const detail = await skillsStore.getDetail(skill.id);
			edBody = detail.body;
		} catch (error) {
			editorError = error instanceof Error ? error.message : 'Failed to load skill';
		}
	}

	function closeEditor() {
		editorOpen = false;
		editorError = null;
	}

	async function saveEditor() {
		if (!edName.trim()) { editorError = 'A name is required'; return; }
		if (!edDescription.trim()) { editorError = 'A description is required'; return; }
		if (!edBody.trim()) { editorError = 'Instructions are required'; return; }
		editorSaving = true;
		editorError = null;
		try {
			const payload = {
				// Create only — the backend ignores it on update, since the id is what
				// `/slug`, `uses:` and Profiles already point at.
				...(editorMode === 'create' && { slug: edSlug.trim() }),
				name: edName.trim(),
				description: edDescription.trim(),
				body: edBody,
				license: edLicense.trim() || undefined,
				triggers: edTriggers,
				argumentHint: edIsSlash ? (edArgumentHint.trim() || null) : null,
				uses: edUses
			};
			if (editorMode === 'create') await skillsStore.create(payload);
			else if (editorId != null) await skillsStore.update(editorId, payload);
			closeEditor();
			activeTab = 'installed';
		} catch (error) {
			editorError = error instanceof Error ? error.message : 'Save failed';
		} finally {
			editorSaving = false;
		}
	}

	// --- Import modal (paste SKILL.md) ---
	let importOpen = $state(false);
	let importText = $state('');
	let importPreview = $state<ParsedSkillPreview | null>(null);
	let importParsing = $state(false);
	let importSaving = $state(false);
	let importError = $state<string | null>(null);

	function openImport() {
		importOpen = true;
		importText = '';
		importPreview = null;
		importError = null;
	}

	function closeImport() {
		importOpen = false;
		importPreview = null;
		importError = null;
	}

	async function runImportPreview() {
		importParsing = true;
		importError = null;
		try {
			importPreview = await skillsStore.parseImport(importText);
		} catch (error) {
			importError = error instanceof Error ? error.message : 'Failed to parse SKILL.md';
		} finally {
			importParsing = false;
		}
	}

	async function commitImport() {
		importSaving = true;
		importError = null;
		try {
			await skillsStore.import(importText);
			closeImport();
			activeTab = 'installed';
		} catch (error) {
			importError = error instanceof Error ? error.message : 'Import failed';
		} finally {
			importSaving = false;
		}
	}

	function onUploadFile(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			importText = String(reader.result ?? '');
			importPreview = null;
		};
		reader.readAsText(file);
		input.value = '';
	}

	// --- Delete confirmation ---
	let deleteTarget = $state<InstalledSkill | null>(null);
	let deleting = $state(false);

	async function confirmDelete() {
		if (!deleteTarget) return;
		deleting = true;
		try {
			await skillsStore.remove(deleteTarget.id);
			deleteTarget = null;
		} catch (error) {
			debug.error('settings', 'delete skill failed', error);
		} finally {
			deleting = false;
		}
	}

	// --- Toggle / install ---
	async function onToggle(skill: InstalledSkill) {
		busyId = skill.id;
		try {
			await skillsStore.toggle(skill.id, !skill.enabled);
		} catch (error) {
			debug.error('settings', 'toggle skill failed', error);
		} finally {
			busyId = null;
		}
	}

	// --- Install modal (review marketplace skill before committing) ---
	let installOpen = $state(false);
	let installTarget = $state<MarketplaceSkill | null>(null);
	let inName = $state('');
	let inDescription = $state('');
	let inLicense = $state('');
	let inBody = $state('');
	let installLoading = $state(false);
	let installSaving = $state(false);
	let installError = $state<string | null>(null);

	async function openInstall(skill: MarketplaceSkill) {
		installTarget = skill;
		inName = skill.name;
		inDescription = skill.description;
		inLicense = '';
		inBody = '';
		installError = null;
		installLoading = true;
		installOpen = true;
		try {
			const detail = await skillsStore.marketplaceDetail(skill.ref);
			inName = detail.name;
			inDescription = detail.description;
			inLicense = detail.license ?? '';
			inBody = detail.body;
		} catch (error) {
			installError = error instanceof Error ? error.message : 'Failed to load skill';
		} finally {
			installLoading = false;
		}
	}

	function closeInstall() {
		installOpen = false;
		installTarget = null;
		installError = null;
	}

	async function confirmInstall() {
		if (!installTarget) return;
		if (!inName.trim()) { installError = 'A name is required'; return; }
		if (!inDescription.trim()) { installError = 'A description is required'; return; }
		installSaving = true;
		installError = null;
		try {
			await skillsStore.install(installTarget.ref, {
				name: inName.trim(),
				description: inDescription.trim(),
				license: inLicense.trim() || null,
				body: inBody
			});
			closeInstall();
		} catch (error) {
			debug.error('settings', 'install skill failed', error);
			installError = error instanceof Error ? error.message : 'Install failed';
		} finally {
			installSaving = false;
		}
	}

	function goBrowse() {
		activeTab = 'browse';
		if (catalog.length === 0 && !skillsStore.catalogLoading) skillsStore.loadCatalog(false);
	}

	function runSearch() {
		skillsStore.searchCatalog(searchInput.trim());
	}

	function formatStars(n: number): string {
		if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
		return String(n);
	}

	const FILTERS: { id: TriggerFilter; label: string }[] = [
		{ id: 'all', label: 'All' },
		{ id: 'auto', label: 'Automatic' },
		{ id: 'slash', label: 'Commands' }
	];
</script>

<div class="space-y-6">
	<!-- Header row: title/description on left, tabs on right -->
	<div class="flex items-start justify-between gap-3">
		{#if showHeader}
			<div>
				<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Skills</h3>
				<p class="text-sm text-slate-600 dark:text-slate-500">
					Reusable instructions the agent loads when they fit, or you run as <code class="text-[11px]">/commands</code>.
				</p>
			</div>
		{:else}
			<div></div>
		{/if}
		<div class="flex gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg shrink-0">
			<button
				type="button"
				class="px-3.5 py-1.5 text-sm font-semibold rounded-md transition-colors
					{activeTab === 'installed'
					? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
					: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
				onclick={() => (activeTab = 'installed')}
			>
				Installed{installed.length ? ` (${installed.length})` : ''}
			</button>
			<button
				type="button"
				class="px-3.5 py-1.5 text-sm font-semibold rounded-md transition-colors
					{activeTab === 'browse'
					? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
					: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
				onclick={goBrowse}
			>
				Browse
			</button>
		</div>
	</div>

	{#if activeTab === 'installed'}
		{#if installed.length === 0}
			<div class="flex flex-col items-center gap-2 py-10 text-center">
				<Icon name="lucide:graduation-cap" class="w-8 h-8 text-slate-400" />
				<p class="text-sm text-slate-500 dark:text-slate-400">No skills yet.</p>
				<div class="flex items-center gap-2">
					<Button variant="primary" size="sm" class="gap-1.5" onclick={openCreate}>
						<Icon name="lucide:plus" class="w-4 h-4" />
						Create skill
					</Button>
					<Button variant="outline" size="sm" class="gap-1.5" onclick={openImport}>
						<Icon name="lucide:upload" class="w-4 h-4" />
						Import
					</Button>
					<Button variant="outline" size="sm" onclick={goBrowse}>Browse</Button>
				</div>
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
						bind:value={installedFilter}
						placeholder="Filter skills…"
						class="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400"
					/>
				</div>
				<Button variant="outline" size="sm" class="gap-1.5 shrink-0" onclick={openImport}>
					<Icon name="lucide:upload" class="w-4 h-4" />
					Import
				</Button>
				<Button variant="primary" size="sm" class="gap-1.5 shrink-0" onclick={openCreate}>
					<Icon name="lucide:plus" class="w-4 h-4" />
					Create
				</Button>
			</div>

			<div class="flex items-center gap-1.5 flex-wrap">
				{#each FILTERS as filter (filter.id)}
					<button
						type="button"
						class="px-2.5 py-1 text-xs font-semibold rounded-full border transition-colors
							{triggerFilter === filter.id
							? 'bg-violet-500/10 border-violet-500/40 text-violet-700 dark:text-violet-300'
							: 'border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
						onclick={() => (triggerFilter = filter.id)}
					>
						{filter.label} ({counts[filter.id]})
					</button>
				{/each}
			</div>

			{#if filteredInstalled.length === 0}
				<p class="text-sm text-slate-500 dark:text-slate-400 text-center py-6">No skill matches this filter.</p>
			{:else}
				<div class="space-y-3">
					{#each filteredInstalled as skill (skill.id)}
						<div class="flex items-start gap-3 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
							<Icon
								name={skill.triggers.includes('slash') && !skill.triggers.includes('auto') ? 'lucide:terminal' : 'lucide:graduation-cap'}
								class="w-5 h-5 mt-0.5 shrink-0 {skill.enabled ? 'text-violet-600' : 'text-slate-400'}"
							/>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2 flex-wrap">
									<span class="font-semibold text-slate-900 dark:text-slate-100">{skill.name}</span>
									{#if skill.triggers.includes('slash')}
										<span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400">/{skill.slug}</span>
										{#if skill.argumentHint}
											<span class="text-[10px] font-mono text-slate-400">{skill.argumentHint}</span>
										{/if}
									{/if}
									{#if skill.triggers.includes('auto')}
										<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">automatic</span>
									{/if}
									{#if skill.version}
										<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">v{skill.version}</span>
									{/if}
								</div>
								{#if skill.description}
									<p class="text-xs text-slate-500 dark:text-slate-400 mt-1.5 line-clamp-2">{skill.description}</p>
								{/if}
								{#if skill.uses.length > 0}
									<p class="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400 mt-1.5">
										<Icon name="lucide:link" class="w-3.5 h-3.5" />
										requires {skill.uses.join(', ')}
									</p>
								{/if}
								{#if !skill.present}
									<p class="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-600 dark:text-amber-400 mt-1.5">
										<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5" />
										SKILL.md missing on disk
									</p>
								{/if}
							</div>
							<div class="flex items-center gap-2 shrink-0">
								<button
									type="button"
									role="switch"
									aria-checked={skill.enabled}
									disabled={busyId === skill.id}
									onclick={() => onToggle(skill)}
									class="relative w-10 h-6 rounded-full transition-colors disabled:opacity-50
										{skill.enabled ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-700'}"
									aria-label={skill.enabled ? 'Disable skill' : 'Enable skill'}
								>
									<span class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform {skill.enabled ? 'translate-x-4' : ''}"></span>
								</button>
								<button
									type="button"
									onclick={() => openEdit(skill)}
									class="flex p-2 rounded-lg text-slate-400 hover:text-violet-600 hover:bg-violet-500/10 transition-colors"
									aria-label="Edit skill"
									title="Edit skill"
								>
									<Icon name="lucide:pencil" class="w-4 h-4" />
								</button>
								<button
									type="button"
									onclick={() => (deleteTarget = skill)}
									class="flex p-2 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-colors"
									aria-label="Delete skill"
								>
									<Icon name="lucide:trash-2" class="w-4 h-4" />
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		{/if}

		{#if detected.length > 0}
			<div class="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-2">
				<p class="text-xs font-semibold text-slate-500 dark:text-slate-400">Detected on disk</p>
				<p class="text-[11px] text-slate-400">
					Skills already on this machine that Clopen doesn't manage. Linking one makes it
					take effect for that engine without moving your file.
				</p>
				{#each detected as group (group.engine)}
					<div class="space-y-1.5">
						<p class="text-[11px] font-semibold capitalize text-slate-500 dark:text-slate-400">{group.engine}</p>
						{#each group.detected as entry (entry.path)}
							<div class="flex items-center gap-2 px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
								<div class="flex-1 min-w-0">
									<p class="text-sm text-slate-900 dark:text-slate-100 truncate">{entry.name}</p>
									<p class="text-[11px] text-slate-400 font-mono truncate">{entry.path}</p>
								</div>
								<Button
									variant="outline"
									size="sm"
									loading={adoptingKey === `${group.engine}:${entry.slug}`}
									onclick={() => adopt(group.engine, entry.slug, entry.path)}
								>
									Link
								</Button>
							</div>
						{/each}
					</div>
				{/each}
			</div>
		{/if}
	{:else}
		<!-- Browse marketplace -->
		<form class="flex gap-2" onsubmit={(e) => { e.preventDefault(); runSearch(); }}>
			<div class="relative flex-1">
				<svg viewBox="0 0 24 24" fill="none" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" aria-hidden="true">
					<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
					<path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
				</svg>
				<input
					type="text"
					bind:value={searchInput}
					placeholder="Search skills (e.g. pdf, frontend, testing)…"
					class="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400"
				/>
			</div>
			{#if skillsStore.catalogLoading}
				<Button variant="outline" size="sm" onclick={() => skillsStore.cancelSearch()}>Cancel</Button>
			{:else}
				<Button type="submit" variant="primary" size="sm" onclick={runSearch}>Search</Button>
			{/if}
		</form>

		{#if skillsStore.catalogError}
			<div class="flex items-start gap-2 p-3 bg-red-500/5 border border-red-500/20 rounded-lg text-sm text-red-600 dark:text-red-400">
				<Icon name="lucide:triangle-alert" class="w-4 h-4 mt-0.5 shrink-0" />
				<span>{skillsStore.catalogError}</span>
			</div>
		{/if}

		{#if skillsStore.catalogLoadingFresh}
			<div class="space-y-3">
				{#each [0, 1, 2, 3, 4] as i (i)}
					<div class="flex items-start gap-3 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl animate-pulse">
						<div class="w-5 h-5 mt-0.5 rounded bg-slate-200 dark:bg-slate-800"></div>
						<div class="flex-1 min-w-0 space-y-2">
							<div class="h-4 w-40 rounded bg-slate-200 dark:bg-slate-800"></div>
							<div class="h-3 w-3/4 rounded bg-slate-200 dark:bg-slate-800"></div>
						</div>
						<div class="h-8 w-16 rounded bg-slate-200 dark:bg-slate-800 shrink-0"></div>
					</div>
				{/each}
			</div>
		{:else}
			<div class="space-y-3">
				{#each catalog as skill (skill.ref)}
					{@const alreadyInstalled = installedRefs.has(skill.ref)}
					<div class="flex items-start gap-3 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
						<Icon name="lucide:graduation-cap" class="w-5 h-5 mt-0.5 shrink-0 text-slate-400" />
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2 flex-wrap">
								<span class="font-semibold text-slate-900 dark:text-slate-100">{skill.name}</span>
								{#if skill.verified}
									<span class="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
										<Icon name="lucide:shield-check" class="w-3 h-3" /> Verified
									</span>
								{/if}
								{#if skill.stars != null}
									<span class="inline-flex items-center gap-0.5 text-[11px] text-slate-400">
										<Icon name="lucide:star" class="w-3 h-3" />{formatStars(skill.stars)}
									</span>
								{/if}
							</div>
							{#if skill.description}
								<p class="text-xs text-slate-500 dark:text-slate-400 mt-1.5 line-clamp-2">{skill.description}</p>
							{/if}
							{#if skill.homepage}
								<a href={skill.homepage} target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-violet-600 mt-1">
									<Icon name="lucide:external-link" class="w-3 h-3" /> source
								</a>
							{/if}
						</div>
						<div class="shrink-0">
							{#if alreadyInstalled}
								<span class="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
									<Icon name="lucide:check" class="w-4 h-4" /> installed
								</span>
							{:else}
								<Button variant="outline" size="sm" onclick={() => openInstall(skill)}>Install</Button>
							{/if}
						</div>
					</div>
				{/each}
			</div>

			{#if skillsStore.catalogCursor}
				<div bind:this={sentinelEl} class="h-4"></div>
			{/if}

			{#if skillsStore.catalogLoading && catalog.length > 0}
				<div class="flex justify-center py-4">
					<div class="w-5 h-5 border-2 border-violet-600 border-t-transparent rounded-full animate-spin"></div>
				</div>
			{/if}

			{#if catalog.length === 0 && !skillsStore.catalogError}
				<p class="text-sm text-slate-500 dark:text-slate-400 text-center py-6">No results. Try a different search.</p>
			{/if}
		{/if}
	{/if}
</div>

<!-- Editor modal (create / edit) -->
<Modal isOpen={editorOpen} onClose={closeEditor} title={editorMode === 'create' ? 'Create skill' : 'Edit skill'} size="lg">
	{#snippet children()}
		<div class="space-y-4 text-sm">
			<ArtifactGenerateBar
				artifactType={edIsSlash && !edIsAuto ? 'command' : 'skill'}
				placeholder={'Describe the skill, e.g. "extract tables from PDF files"'}
				onNavigateArtifacts={() => { closeEditor(); setActiveSection('artifacts'); }}
				onGenerated={(f) => {
					if (typeof f.name === 'string') edName = f.name;
					if (typeof f.description === 'string') edDescription = f.description;
					if (typeof f.argumentHint === 'string') edArgumentHint = f.argumentHint;
					if (typeof f.body === 'string') edBody = f.body;
				}}
			/>
			<Input label="Name" required type="text" placeholder="e.g. PDF processing" bind:value={edName} />

			<!--
				The id used to be invisible: derived from the name on create, then frozen
				while the name stayed editable — so editing the name looked like it
				should rename the skill and didn't. Showing it says which one it is.
			-->
			<div class="space-y-1">
				{#if editorMode === 'create'}
					<label for="skill-id" class="block text-sm font-semibold text-slate-700 dark:text-slate-300">ID</label>
					<!--
						A plain input rather than <Input>: the id has to normalise on BLUR,
						not per keystroke. Normalising as you type eats the space in
						"pdf processing" before it can become the hyphen.
					-->
					<input
						id="skill-id"
						type="text"
						placeholder="pdf-processing"
						bind:value={edSlug}
						oninput={() => (edSlugTouched = true)}
						onblur={() => (edSlug = toSlug(edSlug))}
						class="block w-full px-3 py-2 text-sm font-mono bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-200 dark:focus:ring-violet-900/20 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400"
					/>
					<p class="text-[11px] text-slate-400">Follows the name. Can't be changed later.</p>
				{:else}
					<p class="block text-sm font-semibold text-slate-700 dark:text-slate-300">ID</p>
					<div class="px-3 py-2 text-sm font-mono rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
						{edSlug}
					</div>
					<p class="text-[11px] text-slate-400">Can't be changed.</p>
				{/if}
			</div>

			<div class="space-y-1">
				<Input label="Description" required type="text" placeholder="What it does and when to use it" bind:value={edDescription} />
				<p class="text-[11px] text-slate-400">The agent reads this to decide whether to load the skill.</p>
			</div>

			<!-- Triggers: who invokes this skill. Independent switches, at least one on. -->
			<div class="space-y-1.5">
				<p class="block text-sm font-semibold text-slate-700 dark:text-slate-300">How it runs</p>
				<div class="grid gap-2 sm:grid-cols-2">
					<button
						type="button"
						class="flex items-start gap-2.5 p-3 text-left rounded-lg border transition-colors
							{edIsAuto ? 'border-violet-500/50 bg-violet-500/5' : 'border-slate-200 dark:border-slate-700'}"
						onclick={() => toggleTrigger('auto')}
					>
						<Icon name={edIsAuto ? 'lucide:circle-check' : 'lucide:circle'} class="w-4 h-4 mt-0.5 shrink-0 {edIsAuto ? 'text-violet-600' : 'text-slate-400'}" />
						<span>
							<span class="block text-sm font-medium text-slate-900 dark:text-slate-100">Automatically</span>
							<span class="block text-[11px] text-slate-500 dark:text-slate-400">The agent loads it when the description matches the task.</span>
						</span>
					</button>
					<button
						type="button"
						class="flex items-start gap-2.5 p-3 text-left rounded-lg border transition-colors
							{edIsSlash ? 'border-violet-500/50 bg-violet-500/5' : 'border-slate-200 dark:border-slate-700'}"
						onclick={() => toggleTrigger('slash')}
					>
						<Icon name={edIsSlash ? 'lucide:circle-check' : 'lucide:circle'} class="w-4 h-4 mt-0.5 shrink-0 {edIsSlash ? 'text-violet-600' : 'text-slate-400'}" />
						<span>
							<span class="block text-sm font-medium text-slate-900 dark:text-slate-100">As a command</span>
							<span class="block text-[11px] text-slate-500 dark:text-slate-400">Anyone can run it from chat by typing <code>/{'{'}slug{'}'}</code>.</span>
						</span>
					</button>
				</div>
			</div>

			{#if edIsSlash}
				<Input label="Argument hint (optional)" type="text" placeholder="e.g. [pr-number]" bind:value={edArgumentHint} />
			{/if}

			{#if usableSkills.length > 0}
				<div class="space-y-1.5">
					<p class="block text-sm font-semibold text-slate-700 dark:text-slate-300">Required skills</p>
					<p class="text-[11px] text-slate-400">Always loaded with this one, never left to the agent to decide.</p>
					<div class="max-h-40 overflow-y-auto space-y-1 p-1 border border-slate-200 dark:border-slate-700 rounded-lg">
						{#each usableSkills as option (option.id)}
							<button
								type="button"
								class="flex items-center gap-2 w-full px-2 py-1.5 text-left rounded-md transition-colors
									{edUses.includes(option.slug) ? 'bg-violet-500/10' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}"
								onclick={() => toggleUses(option.slug)}
							>
								<Icon
									name={edUses.includes(option.slug) ? 'lucide:circle-check' : 'lucide:circle'}
									class="w-3.5 h-3.5 shrink-0 {edUses.includes(option.slug) ? 'text-violet-600' : 'text-slate-400'}"
								/>
								<span class="text-sm text-slate-900 dark:text-slate-100 truncate">{option.name}</span>
								<span class="text-[11px] font-mono text-slate-400 truncate">{option.slug}</span>
							</button>
						{/each}
					</div>
				</div>
			{/if}

			<div class="space-y-1">
				<p class="block text-sm font-semibold text-slate-700 dark:text-slate-300">Instructions</p>
				<textarea
					bind:value={edBody}
					rows="12"
					placeholder={edBodyPlaceholder}
					class="w-full px-3 py-2 text-sm font-mono bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400 resize-y"
				></textarea>
				<p class="text-[11px] text-slate-400">Markdown body of SKILL.md.</p>
			</div>
			{#if editorError}
				<p class="text-xs text-red-500">{editorError}</p>
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={closeEditor}>Cancel</Button>
		<Button variant="primary" loading={editorSaving} onclick={saveEditor}>{editorMode === 'create' ? 'Create' : 'Save'}</Button>
	{/snippet}
</Modal>

<!-- Install modal (review a marketplace skill before installing) -->
<Modal isOpen={installOpen} onClose={closeInstall} title="Install skill" size="lg">
	{#snippet children()}
		{#if installLoading}
			<div class="flex items-center justify-center gap-2 py-10 text-sm text-slate-500 dark:text-slate-400">
				<div class="w-4 h-4 border-2 border-violet-600 border-t-transparent rounded-full animate-spin"></div>
				Loading skill…
			</div>
		{:else}
			<div class="space-y-4 text-sm">
				<Input label="Name" required type="text" placeholder="e.g. PDF processing" bind:value={inName} />
				<div class="space-y-1">
					<Input label="Description" required type="text" placeholder="What it does and when to use it" bind:value={inDescription} />
					<p class="text-[11px] text-slate-400">The agent reads this to decide whether to load the skill.</p>
				</div>
				<div class="space-y-1">
					<p class="block text-sm font-semibold text-slate-700 dark:text-slate-300">Instructions</p>
					<textarea
						bind:value={inBody}
						rows="12"
						class="w-full px-3 py-2 text-sm font-mono bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400 resize-y"
					></textarea>
					<p class="text-[11px] text-slate-400">Review before installing — edits are saved with the skill.</p>
				</div>
				{#if installError}
					<p class="text-xs text-red-500">{installError}</p>
				{/if}
			</div>
		{/if}
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={closeInstall}>Cancel</Button>
		<Button variant="primary" loading={installSaving} disabled={installLoading} onclick={confirmInstall}>Install</Button>
	{/snippet}
</Modal>

<!-- Import modal -->
<Modal isOpen={importOpen} onClose={closeImport} title="Import skill" size="lg">
	{#snippet children()}
		<div class="space-y-4 text-sm">
			<div class="flex items-center justify-between gap-2">
				<p class="text-xs text-slate-500 dark:text-slate-400">Paste a SKILL.md or a command file, or upload one from disk.</p>
				<label class="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-600 hover:text-violet-700 cursor-pointer">
					<Icon name="lucide:upload" class="w-3.5 h-3.5" />
					Upload file
					<input type="file" accept=".md,text/markdown,text/plain" class="hidden" onchange={onUploadFile} />
				</label>
			</div>
			<textarea
				bind:value={importText}
				rows="10"
				placeholder={'---\nname: pdf-processing\ndescription: Extract text from PDFs. Use when working with PDF files.\n---\n\n# Instructions\n...'}
				class="w-full px-3 py-2 text-sm font-mono bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400 resize-y"
			></textarea>

			{#if importPreview}
				<div class="p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg space-y-1">
					<div class="flex items-center gap-2 flex-wrap">
						<span class="font-semibold text-slate-900 dark:text-slate-100">{importPreview.name || '(unnamed)'}</span>
						{#each importPreview.triggers as trigger (trigger)}
							<span class="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400">
								{trigger === 'slash' ? 'command' : 'automatic'}
							</span>
						{/each}
						{#if importPreview.license}
							<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">{importPreview.license}</span>
						{/if}
					</div>
					<p class="text-xs text-slate-500 dark:text-slate-400">{importPreview.description || '(no description)'}</p>
					{#if importPreview.body.trim()}
						<pre class="text-[11px] text-slate-500 dark:text-slate-400 whitespace-pre-wrap line-clamp-4 font-mono">{importPreview.body.trim()}</pre>
					{/if}
					{#each importPreview.warnings as w (w)}
						<p class="text-[11px] text-amber-600 dark:text-amber-400">{w}</p>
					{/each}
				</div>
			{/if}

			{#if importError}
				<p class="text-xs text-red-500">{importError}</p>
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={closeImport}>Cancel</Button>
		{#if !importPreview}
			<Button variant="primary" loading={importParsing} disabled={!importText.trim()} onclick={runImportPreview}>Preview</Button>
		{:else}
			<Button variant="primary" loading={importSaving} onclick={commitImport}>Import</Button>
		{/if}
	{/snippet}
</Modal>

<!-- Delete confirmation -->
<Modal isOpen={deleteTarget !== null} onClose={() => (deleteTarget = null)} title="Delete skill" size="sm">
	{#snippet children()}
		{#if deleteTarget}
			<p class="text-sm text-slate-600 dark:text-slate-300">
				Delete <span class="font-semibold text-slate-900 dark:text-slate-100">{deleteTarget.name}</span>?
				Its SKILL.md is removed from disk and from every engine. This can't be undone.
			</p>
		{/if}
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (deleteTarget = null)}>Cancel</Button>
		<Button variant="primary" loading={deleting} class="!bg-red-600 hover:!bg-red-700" onclick={confirmDelete}>Delete</Button>
	{/snippet}
</Modal>
