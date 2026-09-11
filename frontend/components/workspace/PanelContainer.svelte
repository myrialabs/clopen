<script lang="ts">
	import { browser } from '$frontend/app-environment';
	import { onMount, onDestroy } from 'svelte';
	import PanelHeader from './PanelHeader.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ChatPanel from './panels/ChatPanel.svelte';
	import PreviewPanel from './panels/PreviewPanel.svelte';
	import FilesPanel from './panels/FilesPanel.svelte';
	import TerminalPanel from './panels/TerminalPanel.svelte';
	import GitPanel from './panels/GitPanel.svelte';
	import HistoryModal from '$frontend/components/history/HistoryModal.svelte';
	import { workspaceState, type PanelId } from '$frontend/stores/ui/workspace.svelte';
	import { appState } from '$frontend/stores/core/app.svelte';
	import { isPanelLoading } from '$frontend/stores/ui/project-workspace.svelte';

	interface Props {
		panelId: PanelId;
		noPadding?: boolean;
	}

	const { panelId, noPadding = false }: Props = $props();

	const panel = $derived(workspaceState.panels[panelId]);
	const isMinimized = $derived(panel?.minimized ?? false);

	// Panel refs for actions
	let chatPanelRef: any = $state();
	let filesPanelRef: any = $state();
	let terminalPanelRef: any = $state();
	let previewPanelRef: any = $state();
	let gitPanelRef: any = $state();
	// History modal state
	let showHistoryModal = $state(false);

	// Mobile detection
	let isMobile = $state(false);

	function handleResize() {
		if (browser) {
			isMobile = window.innerWidth < 1024;
		}
	}

	function openHistoryModal() {
		showHistoryModal = true;
	}

	function closeHistoryModal() {
		showHistoryModal = false;
	}

	onMount(() => {
		handleResize();
		if (browser) {
			window.addEventListener('resize', handleResize);
		}
	});

	onDestroy(() => {
		if (browser) {
			window.removeEventListener('resize', handleResize);
		}
	});
</script>

<div
	class="relative flex flex-col h-full {isMobile
		? 'bg-transparent'
		: 'bg-white/90 dark:bg-slate-900/60 backdrop-blur-3 border border-slate-200 dark:border-slate-800 rounded-xl'} overflow-hidden"
>
	<!-- Panel Header -->
	<PanelHeader
		{panelId}
		{chatPanelRef}
		{filesPanelRef}
		{terminalPanelRef}
		{previewPanelRef}
		{gitPanelRef}
		onHistoryOpen={openHistoryModal}
	/>

	<!-- Panel Content -->
	{#if !isMinimized}
		<div class="relative flex-1 overflow-hidden {noPadding ? '' : panelId === 'chat' ? 'p-3' : ''}">
			{#if panelId === 'chat'}
				<ChatPanel bind:this={chatPanelRef} />
			{:else if panelId === 'preview'}
				<PreviewPanel bind:this={previewPanelRef} />
			{:else if panelId === 'files'}
				<FilesPanel bind:this={filesPanelRef} />
			{:else if panelId === 'terminal'}
				<TerminalPanel bind:this={terminalPanelRef} />
			{:else if panelId === 'git'}
				<GitPanel bind:this={gitPanelRef} />
			{/if}

			<!-- Two overlays, one look. `isSwitching` covers the structural swap, when
			     every panel would otherwise show the previous project. `isPanelLoading`
			     takes over per panel for the data that loads after the reveal — without
			     it a panel renders its empty state ("No files in project", "Not a git
			     repository") while its data is still in flight. They are visually
			     identical and hand over without a gap, so the user sees one continuous
			     loading state that clears panel by panel as data arrives. -->
			{#if appState.isSwitching || isPanelLoading(panelId)}
				<div
					class="absolute inset-0 flex items-center justify-center gap-2 bg-white dark:bg-slate-900 text-sm text-slate-500 dark:text-slate-400"
				>
					<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
					<span>Loading…</span>
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- History Modal (only for chat panel) -->
{#if panelId === 'chat'}
	<HistoryModal bind:isOpen={showHistoryModal} onClose={closeHistoryModal} />
{/if}
