<script lang="ts">
	import ws from '$frontend/utils/ws';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import { showSuccess, showError } from '$frontend/stores/ui/notification.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { debug } from '$shared/utils/logger';

	interface Props {
		variant?: 'primary' | 'secondary' | 'outline' | 'ghost';
		size?: 'sm' | 'md' | 'lg';
		class?: string;
		restartServerStyle?: boolean;
		onRestarted?: () => void;
	}

	const { variant = 'outline', size = 'sm', class: className = '', restartServerStyle = false, onRestarted }: Props = $props();

	let restarting = $state(false);
	let confirmOpen = $state(false);
	let activeChats = $state(0);

	async function restart(force: boolean) {
		restarting = true;
		try {
			const res = await ws.http('engine:restart-all', { force });
			if (res.needsConfirmation) {
				activeChats = res.activeChats ?? 0;
				confirmOpen = true;
				return;
			}
			confirmOpen = false;
			// Eagerly re-initialise OpenCode so it spawns a fresh subprocess with
			// updated MCP config now, rather than blocking the user's next message.
			await modelStore.refreshModels('opencode').catch(() => {/* opencode may not be installed */});
			showSuccess('Engines Restarted', 'All engines restarted and ready with your latest MCP configuration.');
			onRestarted?.();
		} catch (error) {
			debug.error('settings', 'restart-all failed', error);
			showError('Restart Failed', error instanceof Error ? error.message : 'Could not restart engines.');
		} finally {
			restarting = false;
		}
	}
</script>

{#if restartServerStyle}
	<button
		type="button"
		class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors
			text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50
			hover:bg-amber-100 dark:hover:bg-amber-900/30 disabled:opacity-50 disabled:cursor-not-allowed {className}"
		onclick={() => restart(false)}
		disabled={restarting}
	>
		<Icon name={restarting ? 'lucide:loader' : 'lucide:rotate-cw'} class="w-3.5 h-3.5 {restarting ? 'animate-spin' : ''}" />
		{restarting ? 'Restarting...' : 'Restart all engines'}
	</button>
{:else}
	<Button {variant} {size} class={className} loading={restarting} onclick={() => restart(false)}>
		<Icon name="lucide:rotate-cw" class="w-4 h-4 mr-1.5" />
		Restart all engines
	</Button>
{/if}

<Modal isOpen={confirmOpen} onClose={() => (confirmOpen = false)} title="Restart all engines" size="sm">
	{#snippet children()}
		<p class="text-sm text-slate-600 dark:text-slate-300">
			{activeChats} active chat{activeChats === 1 ? '' : 's'} will be interrupted. Restart anyway?
		</p>
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (confirmOpen = false)}>Cancel</Button>
		<Button variant="primary" loading={restarting} onclick={() => restart(true)}>Restart anyway</Button>
	{/snippet}
</Modal>
