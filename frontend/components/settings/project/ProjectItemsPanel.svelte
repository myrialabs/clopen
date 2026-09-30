<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Input from '$frontend/components/common/form/Input.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import ArtifactGenerateBar from '$frontend/components/settings/common/ArtifactGenerateBar.svelte';
	import { setActiveSection } from '$frontend/stores/ui/settings-modal.svelte';
	import {
		projectArtifactsStore,
		splitFrontmatter,
		type ProjectItem
	} from '$frontend/stores/features/project-artifacts.svelte';

	interface Props {
		projectId: string;
		kind: 'skill' | 'subagent';
	}

	const { projectId, kind }: Props = $props();

	const noun = $derived(kind === 'skill' ? 'skill' : 'subagent');
	const writeDir = $derived(kind === 'skill' ? '.agents/skills' : '.agents/agents');
	const icon = $derived(kind === 'skill' ? 'lucide:graduation-cap' : 'lucide:bot');

	// Rescan every time the panel opens (and on project switch): the repo can
	// change under Clopen at any moment, and a manual refresh button was one
	// more control for something that should simply be current.
	$effect(() => {
		const id = projectId;
		untrack(() => void projectArtifactsStore.refresh(id));
	});

	const scan = $derived(projectArtifactsStore.scanProjectId === projectId ? projectArtifactsStore.scan : null);
	const items = $derived<ProjectItem[]>(scan ? (kind === 'skill' ? scan.skills : scan.subagents) : []);
	let filter = $state('');
	const groups = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		const bySource: { sourcePath: string; editable: boolean; items: ProjectItem[] }[] = [];
		for (const item of items) {
			if (q && !`${item.name} ${item.slug} ${item.description}`.toLowerCase().includes(q)) continue;
			let group = bySource.find(g => g.sourcePath === item.sourcePath);
			if (!group) {
				group = { sourcePath: item.sourcePath, editable: item.editable, items: [] };
				bySource.push(group);
			}
			group.items.push(item);
		}
		return bySource;
	});
	const agentsSlugs = $derived(new Set(items.filter(i => i.editable).map(i => i.slug)));

	let actionError = $state<string | null>(null);
	let busyPath = $state<string | null>(null);

	// --- Editor (create / edit an item under .agents/) ---
	let editorOpen = $state(false);
	let editorOriginal = $state<string | null>(null);
	let edName = $state('');
	let edDescription = $state('');
	let edTools = $state('');
	let edModel = $state('');
	let edBody = $state('');
	let editorError = $state<string | null>(null);
	let editorSaving = $state(false);
	let editorLoading = $state(false);

	function openCreate() {
		editorOriginal = null;
		edName = '';
		edDescription = '';
		edTools = '';
		edModel = '';
		edBody = kind === 'skill'
			? '# Instructions\n\nStep-by-step guidance the agent follows when this skill applies.\n'
			: '# Role\n\nDescribe the subagent\'s role and how it should behave.\n';
		editorError = null;
		editorOpen = true;
	}

	async function openEdit(item: ProjectItem) {
		editorOriginal = item.slug;
		edName = item.slug;
		edDescription = item.description;
		edTools = '';
		edModel = '';
		edBody = '';
		editorError = null;
		editorOpen = true;
		editorLoading = true;
		try {
			const { frontmatter, body } = splitFrontmatter(await projectArtifactsStore.read(projectId, item.path));
			edTools = frontmatter.tools ?? '';
			edModel = frontmatter.model ?? '';
			edBody = body;
		} catch (e) {
			editorError = e instanceof Error ? e.message : `Failed to load the ${noun}`;
		} finally {
			editorLoading = false;
		}
	}

	async function saveEditor() {
		if (!edName.trim()) { editorError = 'A name is required'; return; }
		if (!edDescription.trim()) { editorError = 'A description is required'; return; }
		editorSaving = true;
		editorError = null;
		try {
			const base = { ...(editorOriginal ? { originalSlug: editorOriginal } : {}), name: edName.trim(), description: edDescription.trim(), body: edBody };
			if (kind === 'skill') await projectArtifactsStore.saveSkill(projectId, base);
			else await projectArtifactsStore.saveSubagent(projectId, { ...base, tools: edTools, model: edModel });
			editorOpen = false;
		} catch (e) {
			editorError = e instanceof Error ? e.message : 'Save failed';
		} finally {
			editorSaving = false;
		}
	}

	// --- Read-only viewer (items outside .agents/) ---
	let viewer = $state<{ title: string; path: string; content: string | null; error: string | null } | null>(null);

	async function openView(item: ProjectItem) {
		viewer = { title: item.name, path: item.path, content: null, error: null };
		try {
			const content = await projectArtifactsStore.read(projectId, item.path);
			if (viewer?.path === item.path) viewer = { ...viewer, content };
		} catch (e) {
			if (viewer?.path === item.path) viewer = { ...viewer, error: e instanceof Error ? e.message : 'Failed to read the file' };
		}
	}

	async function copyToAgents(item: ProjectItem) {
		busyPath = item.path;
		actionError = null;
		try {
			await projectArtifactsStore.copyToAgents(projectId, kind, item.path);
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Copy failed';
		} finally {
			busyPath = null;
		}
	}

	// --- Delete ---
	let deleteTarget = $state<ProjectItem | null>(null);
	let deleting = $state(false);

	async function confirmDelete() {
		if (!deleteTarget) return;
		deleting = true;
		actionError = null;
		try {
			if (kind === 'skill') await projectArtifactsStore.deleteSkill(projectId, deleteTarget.slug);
			else await projectArtifactsStore.deleteSubagent(projectId, deleteTarget.slug);
			deleteTarget = null;
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Delete failed';
			deleteTarget = null;
		} finally {
			deleting = false;
		}
	}
</script>

<div class="space-y-4">
	<!-- Same toolbar shape as the Global list: filter on the left, actions on the right. -->
	<div class="flex items-center gap-2">
		<div class="relative flex-1">
			<Icon name="lucide:search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
			<input
				type="text"
				bind:value={filter}
				placeholder="Filter {noun}s…"
				class="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400"
			/>
		</div>
		<Button variant="primary" size="sm" class="gap-1.5 shrink-0" onclick={openCreate}>
			<Icon name="lucide:plus" class="w-4 h-4" />
			New
		</Button>
	</div>

	{#if projectArtifactsStore.error && !scan}
		<p class="text-xs text-red-500">{projectArtifactsStore.error}</p>
	{:else if !scan}
		<div class="space-y-3">
			{#each [0, 1] as i (i)}
				<div class="h-20 rounded-xl bg-slate-100 dark:bg-slate-800/60 animate-pulse"></div>
			{/each}
		</div>
	{:else if items.length === 0}
		<div class="flex flex-col items-center gap-2 py-10 text-center">
			<Icon name={icon} class="w-8 h-8 text-slate-400" />
			<p class="text-sm text-slate-500 dark:text-slate-400">No {noun}s in this repository.</p>
			<p class="text-xs text-slate-400">New ones are saved to <code class="text-[11px]">{writeDir}/</code>.</p>
		</div>
	{:else if groups.length === 0}
		<p class="text-sm text-slate-500 dark:text-slate-400 text-center py-6">No {noun} matches "{filter}".</p>
	{:else}
		{#each groups as group (group.sourcePath)}
			<div class="space-y-2">
				<div class="flex items-center gap-2">
					<code class="text-xs font-semibold text-slate-700 dark:text-slate-300">{group.sourcePath}/</code>
					{#if group.editable}
						<span class="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400 font-semibold">editable</span>
					{:else}
						<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">read-only</span>
					{/if}
				</div>
				{#each group.items as item (item.path)}
					<div class="flex items-start gap-3 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl {item.shadowedBy ? 'opacity-60' : ''}">
						<Icon name={icon} class="w-5 h-5 mt-0.5 shrink-0 text-violet-600" />
						<div class="flex-1 min-w-0 space-y-1.5">
							<div class="flex items-center gap-2 flex-wrap">
								<span class="font-semibold text-slate-900 dark:text-slate-100">{item.name}</span>
								{#if item.name !== item.slug}
									<code class="text-[11px] text-slate-400">{item.slug}</code>
								{/if}
								{#if item.shadowedBy}
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400" title="Another copy with the same name takes precedence">duplicate</span>
								{/if}
							</div>
							{#if item.description}
								<p class="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">{item.description}</p>
							{/if}
						</div>
						<div class="flex items-center gap-1 shrink-0">
							{#if item.editable}
								<button type="button" onclick={() => openEdit(item)} class="flex p-2 rounded-lg text-slate-400 hover:text-violet-600 hover:bg-violet-500/10 transition-colors" aria-label="Edit {noun}" title="Edit">
									<Icon name="lucide:pencil" class="w-4 h-4" />
								</button>
								<button type="button" onclick={() => (deleteTarget = item)} class="flex p-2 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-colors" aria-label="Delete {noun}" title="Delete">
									<Icon name="lucide:trash-2" class="w-4 h-4" />
								</button>
							{:else}
								<button type="button" onclick={() => openView(item)} class="flex p-2 rounded-lg text-slate-400 hover:text-violet-600 hover:bg-violet-500/10 transition-colors" aria-label="View {noun}" title="View">
									<Icon name="lucide:eye" class="w-4 h-4" />
								</button>
								{#if !agentsSlugs.has(item.slug)}
									<button
										type="button"
										disabled={busyPath === item.path}
										onclick={() => copyToAgents(item)}
										class="flex p-2 rounded-lg text-slate-400 hover:text-violet-600 hover:bg-violet-500/10 transition-colors disabled:opacity-50"
										aria-label="Copy to {writeDir}"
										title="Copy to {writeDir}"
									>
										<Icon name="lucide:copy-plus" class="w-4 h-4" />
									</button>
								{/if}
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/each}
	{/if}

	{#if actionError}
		<p class="text-xs text-red-500">{actionError}</p>
	{/if}
</div>

<!-- Editor -->
<Modal isOpen={editorOpen} onClose={() => (editorOpen = false)} title={editorOriginal ? `Edit ${noun}` : `New ${noun}`} size="lg">
	{#snippet children()}
		<div class="space-y-4 text-sm">
			<ArtifactGenerateBar
				artifactType={kind}
				placeholder={kind === 'skill' ? 'Describe the skill, e.g. "cut a release"' : 'Describe the subagent, e.g. "reviews diffs for bugs"'}
				onNavigateArtifacts={() => { editorOpen = false; setActiveSection('artifacts'); }}
				onGenerated={(f) => {
					if (typeof f.name === 'string') edName = f.name;
					if (typeof f.description === 'string') edDescription = f.description;
					if (typeof f.tools === 'string') edTools = f.tools;
					if (typeof f.body === 'string') edBody = f.body;
				}}
			/>
			<div class="space-y-1">
				<Input label="Name" required type="text" placeholder={kind === 'skill' ? 'e.g. release-notes' : 'e.g. code-reviewer'} bind:value={edName} />
				<code class="block text-[11px] text-slate-400">{writeDir}/{edName.trim() ? edName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '<name>'}{kind === 'skill' ? '/SKILL.md' : '.md'}</code>
			</div>
			<Input label="Description" required type="text" placeholder={kind === 'skill' ? 'What it does and when to use it' : 'What it does and when to delegate to it'} bind:value={edDescription} />
			{#if kind === 'subagent'}
				<div class="grid grid-cols-1 md:grid-cols-2 gap-3">
					<Input label="Tools" type="text" placeholder="e.g. Read, Grep (empty = all)" bind:value={edTools} />
					<Input label="Model" type="text" placeholder="e.g. sonnet (empty = inherit)" bind:value={edModel} />
				</div>
			{/if}
			<div class="space-y-1">
				<p class="block text-sm font-semibold text-slate-700 dark:text-slate-300">{kind === 'skill' ? 'Instructions' : 'System prompt'}</p>
				<textarea
					bind:value={edBody}
					rows="14"
					disabled={editorLoading}
					class="w-full px-3 py-2 text-sm font-mono bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400 resize-y disabled:opacity-50"
				></textarea>
			</div>
			{#if editorError}
				<p class="text-xs text-red-500">{editorError}</p>
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (editorOpen = false)}>Cancel</Button>
		<Button variant="primary" loading={editorSaving} disabled={editorLoading} onclick={saveEditor}>{editorOriginal ? 'Save' : 'Create'}</Button>
	{/snippet}
</Modal>

<!-- Viewer -->
<Modal isOpen={viewer !== null} onClose={() => (viewer = null)} title={viewer?.title ?? ''} size="lg">
	{#snippet children()}
		{#if viewer}
			<div class="space-y-2">
				<code class="text-[11px] text-slate-500">{viewer.path}</code>
				{#if viewer.error}
					<p class="text-xs text-red-500">{viewer.error}</p>
				{:else if viewer.content === null}
					<div class="h-40 rounded-lg bg-slate-100 dark:bg-slate-800/60 animate-pulse"></div>
				{:else}
					<pre class="max-h-[60vh] overflow-auto p-3 text-xs font-mono whitespace-pre-wrap bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-700 dark:text-slate-300">{viewer.content}</pre>
				{/if}
			</div>
		{/if}
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (viewer = null)}>Close</Button>
	{/snippet}
</Modal>

<!-- Delete confirmation -->
<Modal isOpen={deleteTarget !== null} onClose={() => (deleteTarget = null)} title="Delete {noun}" size="sm">
	{#snippet children()}
		{#if deleteTarget}
			<p class="text-sm text-slate-600 dark:text-slate-300">
				Delete <code class="text-xs font-semibold text-slate-900 dark:text-slate-100">{deleteTarget.path}</code>?
			</p>
		{/if}
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (deleteTarget = null)}>Cancel</Button>
		<Button variant="danger" loading={deleting} onclick={confirmDelete}>Delete</Button>
	{/snippet}
</Modal>
