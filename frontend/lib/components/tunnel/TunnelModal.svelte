<script lang="ts">
	import Modal from '$frontend/lib/components/common/Modal.svelte';
	import TunnelInactive from './TunnelInactive.svelte';
	import TunnelActive from './TunnelActive.svelte';
	import { tunnelStore } from '$frontend/lib/stores/features/tunnel.svelte';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(), onClose }: Props = $props();

	const activeTunnels = $derived(tunnelStore.tunnels);

	// Load tunnels when modal opens
	$effect(() => {
		if (isOpen) {
			tunnelStore.checkStatus();
		}
	});
</script>

<Modal {isOpen} {onClose} title="Public Tunnel" size="md">
	<div class="space-y-6">
		<!-- Add new tunnel form -->
		<TunnelInactive />

		<!-- Active tunnels list -->
		{#if activeTunnels.length > 0}
			<div>
				<div class="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">
					Active Tunnels
				</div>
				<div class="space-y-3">
					{#each activeTunnels as tunnel (tunnel.port)}
						<TunnelActive
							port={tunnel.port}
							publicUrl={tunnel.publicUrl}
							startedAt={tunnel.startedAt}
							autoStopMinutes={tunnel.autoStopMinutes}
						/>
					{/each}
				</div>
			</div>
		{/if}
	</div>
</Modal>
