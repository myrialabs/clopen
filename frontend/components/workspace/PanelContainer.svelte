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

			<!-- During a project switch only the CONTENT is waiting on data. Blank it
			     to a plain "Loading…" (the header stays live and updates instantly).
			     No stale data from the previous project shows through. -->
			{#if appState.isSwitching}
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
