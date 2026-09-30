<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import EngineCoverage from './EngineCoverage.svelte';
	import ArtifactGenerateBar from '$frontend/components/settings/common/ArtifactGenerateBar.svelte';
	import { setActiveSection } from '$frontend/stores/ui/settings-modal.svelte';
	import { projectArtifactsStore } from '$frontend/stores/features/project-artifacts.svelte';
	import { instructionsStore } from '$frontend/stores/features/instructions.svelte';

	interface Props {
		projectId: string;
	}

	const { projectId }: Props = $props();

	const scan = $derived(projectArtifactsStore.scanProjectId === projectId ? projectArtifactsStore.scan : null);
	const otherFiles = $derived(scan?.instructions.filter(f => f.sourceId !== 'agents-md') ?? []);

	// AGENTS.md, exactly as on disk (committed)
	let block = $state('');
	let agentsMdExists = $state(false);
	let blockLoaded = $state(false);
	let blockSaving = $state(false);
	let blockError = $state<string | null>(null);
	let blockSaved = $state(false);

	// Clopen-only layer (database, never committed). No enable switch: an empty
	// box is "off", which is the one state a user can read at a glance.
	let privateContent = $state('');
	let privateLoaded = $state(false);
	let privateSaving = $state(false);
	let privateError = $state<string | null>(null);
	let privateSaved = $state(false);

	async function load(id: string) {
		blockLoaded = false;
		privateLoaded = false;
		void projectArtifactsStore.refresh(id);
		try {
			const state = await projectArtifactsStore.getAgentsMd(id);
			block = state.content;
			agentsMdExists = state.exists;
		} catch (e) {
			blockError = e instanceof Error ? e.message : 'Failed to read AGENTS.md';
		} finally {
			blockLoaded = true;
		}
		const data = await instructionsStore.fetchProject(id);
		// A disabled row isn't applied, so it shows as empty — exactly what the agent sees.
		privateContent = data?.enabled ? data.content : '';
		privateLoaded = true;
	}

	$effect(() => {
		const id = projectId;
		untrack(() => void load(id));
	});

	async function saveBlock() {
		blockSaving = true;
		blockError = null;
		blockSaved = false;
		try {
			const state = await projectArtifactsStore.saveAgentsMd(projectId, block);
			block = state.content;
			agentsMdExists = state.exists;
			blockSaved = true;
		} catch (e) {
			blockError = e instanceof Error ? e.message : 'Save failed';
		} finally {
			blockSaving = false;
		}
	}

	async function savePrivate() {
		privateSaving = true;
		privateError = null;
		privateSaved = false;
		try {
			await instructionsStore.saveProject(projectId, privateContent, privateContent.trim().length > 0);
			privateSaved = true;
		} catch (e) {
			privateError = e instanceof Error ? e.message : 'Save failed';
		} finally {
			privateSaving = false;
		}
	}

	// Read-only viewer for the other instruction files
	let viewer = $state<{ path: string; content: string | null; error: string | null } | null>(null);

	async function openView(path: string) {
		viewer = { path, content: null, error: null };
		try {
			const content = await projectArtifactsStore.read(projectId, path);
			if (viewer?.path === path) viewer = { ...viewer, content };
		} catch (e) {
			if (viewer?.path === path) viewer = { ...viewer, error: e instanceof Error ? e.message : 'Failed to read the file' };
		}
	}

	const textareaClass = 'w-full px-3 py-2 text-sm font-mono bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400 resize-y disabled:opacity-50';
</script>

<div class="space-y-6">
	<!-- AGENTS.md -->
	<div class="space-y-2 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
		<div class="flex items-center justify-between gap-2">
			<div class="min-w-0">
				<p class="text-sm font-semibold text-slate-800 dark:text-slate-200">AGENTS.md</p>
				<p class="text-xs text-slate-500 dark:text-slate-400">Committed with the repository, so every tool and teammate gets it.</p>
			</div>
			{#if blockLoaded && !agentsMdExists}
				<span class="text-[11px] text-slate-400 shrink-0">Created on save</span>
			{/if}
		</div>
		<ArtifactGenerateBar
			artifactType="instruction"
			placeholder={'Describe the instructions, e.g. "run bun test before committing"'}
			onNavigateArtifacts={() => setActiveSection('artifacts')}
			onGenerated={(f) => { if (typeof f.content === 'string') block = block.trim() ? `${block.trimEnd()}\n\n${f.content}` : f.content; }}
		/>
		<textarea
			bind:value={block}
			rows="10"
			disabled={!blockLoaded}
			placeholder={'e.g. Run `bun test` before committing. Never edit generated files in dist/.'}
			class={textareaClass}
		></textarea>
		{#if blockError}
			<p class="text-xs text-red-500">{blockError}</p>
		{/if}
		<div class="flex items-center justify-end gap-3">
			{#if blockSaved}<span class="text-[11px] text-emerald-600 dark:text-emerald-400">Saved</span>{/if}
			<Button variant="primary" size="sm" loading={blockSaving} disabled={!blockLoaded} onclick={saveBlock}>Save AGENTS.md</Button>
		</div>
	</div>

	<!-- Clopen-only layer (database, never committed) -->
	<div class="space-y-2 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
		<div>
			<p class="text-sm font-semibold text-slate-800 dark:text-slate-200">Clopen only</p>
			<p class="text-xs text-slate-500 dark:text-slate-400">Not written to the repository; applies only to this project's chats in Clopen.</p>
		</div>
		<ArtifactGenerateBar
			artifactType="instruction"
			placeholder={'Describe the instructions, e.g. "the staging database is read-only"'}
			onNavigateArtifacts={() => setActiveSection('artifacts')}
			onGenerated={(f) => { if (typeof f.content === 'string') privateContent = f.content; }}
		/>
		<textarea
			bind:value={privateContent}
			rows="8"
			disabled={!privateLoaded}
			placeholder={'e.g. The staging database is read-only — never run migrations against it.'}
			class={textareaClass}
		></textarea>
		{#if privateError}
			<p class="text-xs text-red-500">{privateError}</p>
		{/if}
		<div class="flex items-center justify-end gap-3">
			{#if privateSaved}<span class="text-[11px] text-emerald-600 dark:text-emerald-400">Saved</span>{/if}
			<Button variant="primary" size="sm" loading={privateSaving} disabled={!privateLoaded} onclick={savePrivate}>Save</Button>
		</div>
	</div>

	<!-- Other instruction files -->
	{#if otherFiles.length > 0}
		<div class="space-y-2">
			<div class="flex items-center gap-2">
				<span class="text-xs font-semibold text-slate-700 dark:text-slate-300">Other instruction files</span>
				<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">read-only</span>
			</div>
			{#each otherFiles as file (file.path)}
				<div class="flex items-center gap-3 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
					<Icon name="lucide:file-text" class="w-5 h-5 shrink-0 text-violet-600" />
					<div class="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
						<span class="font-semibold text-slate-900 dark:text-slate-100">{file.path}</span>
						{#if file.fileCount != null}
							<span class="text-[10px] text-slate-400">{file.fileCount} file{file.fileCount === 1 ? '' : 's'}</span>
						{/if}
						<EngineCoverage coverage={file.coverage} />
					</div>
					{#if file.fileCount == null}
						<button type="button" onclick={() => openView(file.path)} class="flex p-2 rounded-lg text-slate-400 hover:text-violet-600 hover:bg-violet-500/10 transition-colors" aria-label="View {file.path}" title="View">
							<Icon name="lucide:eye" class="w-4 h-4" />
						</button>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<Modal isOpen={viewer !== null} onClose={() => (viewer = null)} title={viewer?.path ?? ''} size="lg">
	{#snippet children()}
		{#if viewer}
			{#if viewer.error}
				<p class="text-xs text-red-500">{viewer.error}</p>
			{:else if viewer.content === null}
				<div class="h-40 rounded-lg bg-slate-100 dark:bg-slate-800/60 animate-pulse"></div>
			{:else}
				<pre class="max-h-[60vh] overflow-auto p-3 text-xs font-mono whitespace-pre-wrap bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-700 dark:text-slate-300">{viewer.content}</pre>
			{/if}
		{/if}
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (viewer = null)}>Close</Button>
	{/snippet}
</Modal>
