<script lang="ts">
	import Terminal from '$frontend/lib/components/terminal/Terminal.svelte';
	import TerminalTabs from '$frontend/lib/components/terminal/TerminalTabs.svelte';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import LoadingSpinner from '$frontend/lib/components/common/LoadingSpinner.svelte';
	import { terminalStore } from '$frontend/lib/stores/features/terminal.svelte';
	import { projectState } from '$frontend/lib/stores/core/projects.svelte';

	// Props
	interface Props {
		showMobileHeader?: boolean;
	}

	const { showMobileHeader = false }: Props = $props();

	const hasActiveProject = $derived(projectState.currentProject !== null);
	const projectPath = $derived(projectState.currentProject?.path || '');
	const projectId = $derived(projectState.currentProject?.id || '');

	// Terminal reference
	let terminalRef: any = $state();

	// Derived state from terminal
	const activeSession = $derived(terminalRef?.terminalActions?.getActiveSession());
	const isExecuting = $derived(terminalRef?.terminalActions?.isExecuting() ?? false);
	const isCancelling = $derived(terminalRef?.terminalActions?.isCancelling() ?? false);

	async function createNewSession() {
		if (terminalRef?.terminalActions) {
			await terminalRef.terminalActions.handleNewSession();
		}
	}

	function handleClear() {
		if (terminalRef?.terminalActions) {
			terminalRef.terminalActions.handleClear();
		}
	}

	async function handleCancel() {
		if (terminalRef?.terminalActions) {
			await terminalRef.terminalActions.handleCancel();
		}
	}

	// Export actions for DesktopPanel header
	export const panelActions = {
		createNewSession,
		handleClear,
		handleCancel,
		getTerminalRef: () => terminalRef,
		getSessions: () => terminalStore.sessions,
		getActiveSession: () => activeSession,
		isExecuting: () => isExecuting,
		isCancelling: () => isCancelling
	};
</script>

<div class="h-full flex flex-col bg-transparent">
	{#if !hasActiveProject}
		<div
			class="flex-1 flex flex-col items-center justify-center gap-3 text-slate-600 dark:text-slate-500 text-sm"
		>
			<Icon name="lucide:terminal" class="w-10 h-10 opacity-30" />
			<span>No project selected</span>
		</div>
	{:else}
		<!-- Terminal Content -->
		<div class="flex-1 overflow-hidden">
			<Terminal bind:this={terminalRef} />
		</div>
	{/if}
</div>
