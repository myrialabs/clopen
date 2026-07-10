<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Input from '$frontend/components/common/form/Input.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import ArtifactGenerateBar from '$frontend/components/settings/common/ArtifactGenerateBar.svelte';
	import ArtifactModelField from '$frontend/components/settings/common/ArtifactModelField.svelte';
	import {
		commandsStore,
		type InstalledCommand
	} from '$frontend/stores/features/commands.svelte';
	import type { EngineValueMap } from '$frontend/stores/features/artifacts';
	import { setActiveSection } from '$frontend/stores/ui/settings-modal.svelte';
	import { debug } from '$shared/utils/logger';

	interface Props {
		showHeader?: boolean;
	}

	const { showHeader = true }: Props = $props();

	let installedFilter = $state('');
	let busyId = $state<number | null>(null);

	const installed = $derived(commandsStore.installed);
	// Only surface UNMANAGED on-disk items (found, not yet adopted). Managed copies
	// already appear in the list above.
	const detected = $derived(
		commandsStore.detected
			.map(g => ({ engine: g.engine, detected: g.detected.filter(d => d.adoptable && !d.managed) }))
			.filter(g => g.detected.length > 0)
	);

	const filteredInstalled = $derived.by(() => {
		const q = installedFilter.trim().toLowerCase();
		if (!q) return installed;
		return installed.filter(c => `${c.name} ${c.slug} ${c.description}`.toLowerCase().includes(q));
	});

	onMount(() => {
		void commandsStore.refreshInstalled();
		void commandsStore.refreshDetected();
	});

	// --- Editor modal (create / edit) ---
	let editorOpen = $state(false);
	let editorMode = $state<'create' | 'edit'>('create');
	let editorId = $state<number | null>(null);
	let edName = $state('');
	let edDescription = $state('');
	let edArgumentHint = $state('');
	let edModelByEngine = $state<EngineValueMap>({});
	let edBody = $state('');
	let editorError = $state<string | null>(null);
	let editorSaving = $state(false);

	function openCreate() {
		editorMode = 'create';
		editorId = null;
		edName = '';
		edDescription = '';
		edArgumentHint = '';
		edModelByEngine = {};
		edBody = 'Describe the prompt this command runs. Use $ARGUMENTS for user input.\n';
		editorError = null;
		editorOpen = true;
	}

	async function openEdit(command: InstalledCommand) {
		editorMode = 'edit';
		editorId = command.id;
		edName = command.name;
		edDescription = command.description;
		edArgumentHint = command.argumentHint ?? '';
		edModelByEngine = { ...command.modelByEngine };
		edBody = '';
		editorError = null;
		editorOpen = true;
		try {
			const detail = await commandsStore.getDetail(command.id);
			edBody = detail.body;
		} catch (error) {
			editorError = error instanceof Error ? error.message : 'Failed to load command';
		}
	}

	function closeEditor() {
		editorOpen = false;
		editorError = null;
	}

	async function saveEditor() {
		if (!edName.trim()) { editorError = 'A name is required'; return; }
		editorSaving = true;
		editorError = null;
		try {
			const payload = {
				name: edName.trim(),
				description: edDescription.trim(),
				argumentHint: edArgumentHint.trim() || null,
				modelByEngine: edModelByEngine,
				body: edBody
			};
			if (editorMode === 'create') await commandsStore.create(payload);
			else if (editorId != null) await commandsStore.update(editorId, payload);
			commandsStore.hasPendingChanges = true;
			closeEditor();
		} catch (error) {
			editorError = error instanceof Error ? error.message : 'Save failed';
		} finally {
			editorSaving = false;
		}
	}

	// --- Import modal (paste command .md) ---
	let importOpen = $state(false);
	let importText = $state('');
	let importSaving = $state(false);
	let importError = $state<string | null>(null);

	function openImport() {
		importOpen = true;
		importText = '';
		importError = null;
	}

	function closeImport() {
		importOpen = false;
		importError = null;
	}

	async function commitImport() {
		importSaving = true;
		importError = null;
		try {
			await commandsStore.import(importText);
			commandsStore.hasPendingChanges = true;
			closeImport();
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
		reader.onload = () => { importText = String(reader.result ?? ''); };
		reader.readAsText(file);
		input.value = '';
	}

	// --- Delete confirmation ---
	let deleteTarget = $state<InstalledCommand | null>(null);
	let deleting = $state(false);

	async function confirmDelete() {
		if (!deleteTarget) return;
		deleting = true;
		try {
			await commandsStore.remove(deleteTarget.id);
			commandsStore.hasPendingChanges = true;
			deleteTarget = null;
		} catch (error) {
			debug.error('settings', 'delete command failed', error);
		} finally {
			deleting = false;
		}
	}

	async function onToggle(command: InstalledCommand) {
		busyId = command.id;
		try {
			await commandsStore.toggle(command.id, !command.enabled);
			commandsStore.hasPendingChanges = true;
		} catch (error) {
			debug.error('settings', 'toggle command failed', error);
		} finally {
			busyId = null;
		}
	}
</script>

<div class="space-y-6">
	<div class="flex items-start justify-between gap-3">
		{#if showHeader}
			<div>
				<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Commands</h3>
				<p class="text-sm text-slate-600 dark:text-slate-500">
					Reusable slash-command prompts, materialized into each engine.
				</p>
			</div>
		{:else}
			<div></div>
		{/if}
	</div>

	{#if installed.length === 0}
		<div class="flex flex-col items-center gap-2 py-10 text-center">
			<Icon name="lucide:terminal" class="w-8 h-8 text-slate-400" />
			<p class="text-sm text-slate-500 dark:text-slate-400">No commands yet.</p>
			<div class="flex items-center gap-2">
				<Button variant="primary" size="sm" class="gap-1.5" onclick={openCreate}>
					<Icon name="lucide:plus" class="w-4 h-4" />
					Create command
				</Button>
				<Button variant="outline" size="sm" class="gap-1.5" onclick={openImport}>
					<Icon name="lucide:upload" class="w-4 h-4" />
					Import
				</Button>
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
					placeholder="Filter commands…"
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
		{#if filteredInstalled.length === 0}
			<p class="text-sm text-slate-500 dark:text-slate-400 text-center py-6">No command matches "{installedFilter}".</p>
		{:else}
			<div class="space-y-3">
				{#each filteredInstalled as command (command.id)}
					<div class="flex items-start gap-3 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
						<Icon name="lucide:terminal" class="w-5 h-5 mt-0.5 shrink-0 {command.enabled ? 'text-violet-600' : 'text-slate-400'}" />
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2 flex-wrap">
								<span class="font-semibold text-slate-900 dark:text-slate-100">/{command.slug}</span>
								{#if Object.values(command.modelByEngine).some(Boolean)}
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">custom model</span>
								{/if}
							</div>
							{#if command.description}
								<p class="text-xs text-slate-500 dark:text-slate-400 mt-1.5 line-clamp-2">{command.description}</p>
							{/if}
							{#if !command.present}
								<p class="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-600 dark:text-amber-400 mt-1.5">
									<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5" />
									file missing on disk
								</p>
							{/if}
						</div>
						<div class="flex items-center gap-2 shrink-0">
							<button
								type="button"
								role="switch"
								aria-checked={command.enabled}
								disabled={busyId === command.id}
								onclick={() => onToggle(command)}
								class="relative w-10 h-6 rounded-full transition-colors disabled:opacity-50 {command.enabled ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-700'}"
								aria-label={command.enabled ? 'Disable command' : 'Enable command'}
							>
								<span class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform {command.enabled ? 'translate-x-4' : ''}"></span>
							</button>
							<button type="button" onclick={() => openEdit(command)} class="flex p-2 rounded-lg text-slate-400 hover:text-violet-600 hover:bg-violet-500/10 transition-colors" aria-label="Edit command" title="Edit command">
								<Icon name="lucide:pencil" class="w-4 h-4" />
							</button>
							<button type="button" onclick={() => (deleteTarget = command)} class="flex p-2 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-colors" aria-label="Delete command">
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
			{#each detected as group (group.engine)}
				<div class="text-xs text-slate-500 dark:text-slate-400">
					<span class="font-semibold capitalize">{group.engine}</span>:
					{group.detected.map(d => `/${d.slug}`).join(', ')}
				</div>
			{/each}
			<p class="text-[11px] text-slate-400">Commands found on disk that Clopen doesn't manage yet — shown for reference.</p>
		</div>
	{/if}
</div>

<!-- Editor modal (create / edit) -->
<Modal isOpen={editorOpen} onClose={closeEditor} title={editorMode === 'create' ? 'Create command' : 'Edit command'} size="lg">
	{#snippet children()}
		<div class="space-y-4 text-sm">
			<ArtifactGenerateBar
				artifactType="command"
				placeholder={'Describe the command, e.g. "review a PR for security issues"'}
				onNavigateArtifacts={() => { closeEditor(); setActiveSection('artifacts'); }}
				onGenerated={(f) => {
					if (typeof f.name === 'string') edName = f.name;
					if (typeof f.description === 'string') edDescription = f.description;
					if (typeof f.argumentHint === 'string') edArgumentHint = f.argumentHint;
					if (typeof f.body === 'string') edBody = f.body;
				}}
			/>
			<Input label="Name" required type="text" placeholder="e.g. Review PR" bind:value={edName} />
			<Input label="Description" type="text" placeholder="What this command does" bind:value={edDescription} />
			<Input label="Argument hint (optional)" type="text" placeholder="e.g. [pr-number]" bind:value={edArgumentHint} />
			<ArtifactModelField value={edModelByEngine} onChange={(v) => (edModelByEngine = v)} />
			<div class="space-y-1">
				<p class="block text-sm font-semibold text-slate-700 dark:text-slate-300">Prompt</p>
				<textarea
					bind:value={edBody}
					rows="12"
					placeholder={'The prompt this command runs. Use $ARGUMENTS for user input.'}
					class="w-full px-3 py-2 text-sm font-mono bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400 resize-y"
				></textarea>
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

<!-- Import modal -->
<Modal isOpen={importOpen} onClose={closeImport} title="Import command" size="lg">
	{#snippet children()}
		<div class="space-y-4 text-sm">
			<div class="flex items-center justify-between gap-2">
				<p class="text-xs text-slate-500 dark:text-slate-400">Paste a command Markdown file, or upload one from disk.</p>
				<label class="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-600 hover:text-violet-700 cursor-pointer">
					<Icon name="lucide:upload" class="w-3.5 h-3.5" />
					Upload file
					<input type="file" accept=".md,text/markdown,text/plain" class="hidden" onchange={onUploadFile} />
				</label>
			</div>
			<textarea
				bind:value={importText}
				rows="10"
				placeholder={'---\ndescription: Review a pull request\nargument-hint: [pr-number]\n---\n\nReview PR $ARGUMENTS …'}
				class="w-full px-3 py-2 text-sm font-mono bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400 resize-y"
			></textarea>
			{#if importError}
				<p class="text-xs text-red-500">{importError}</p>
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={closeImport}>Cancel</Button>
		<Button variant="primary" loading={importSaving} disabled={!importText.trim()} onclick={commitImport}>Import</Button>
	{/snippet}
</Modal>

<!-- Delete confirmation -->
<Modal isOpen={deleteTarget !== null} onClose={() => (deleteTarget = null)} title="Delete command" size="sm">
	{#snippet children()}
		{#if deleteTarget}
			<p class="text-sm text-slate-600 dark:text-slate-300">
				Delete <span class="font-semibold text-slate-900 dark:text-slate-100">/{deleteTarget.slug}</span>?
				Its file is removed from disk and from every engine. This can't be undone.
			</p>
		{/if}
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (deleteTarget = null)}>Cancel</Button>
		<Button variant="primary" loading={deleting} class="!bg-red-600 hover:!bg-red-700" onclick={confirmDelete}>Delete</Button>
	{/snippet}
</Modal>
