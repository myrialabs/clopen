<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import TunnelInactive from './TunnelInactive.svelte';
	import TunnelActive from './TunnelActive.svelte';
	import { tunnelStore } from '$frontend/stores/features/tunnel.svelte';
	import { openSettingsModal } from '$frontend/stores/ui/settings-modal.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import ws from '$frontend/utils/ws';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(), onClose }: Props = $props();

	const activeTunnels = $derived(tunnelStore.tunnels);
	const isAdmin = $derived(authStore.isAdmin);

	// Deduplicate tunnels by unique key to prevent each_key_duplicate
	const uniqueTunnels = $derived(() => {
		const seen = new Set<string>();
		return activeTunnels.filter((tunnel) => {
			const key = tunnel.id ?? `${tunnel.type}-${tunnel.port}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	});

	const cleanups: Array<() => void> = [];

	onMount(() => {
		// Auto-sync tunnel list when status changes (from Settings start/stop)
		cleanups.push(
			ws.on('tunnel:status-changed', () => {
				tunnelStore.checkStatus();
			})
		);
	});

	onDestroy(() => {
		for (const cleanup of cleanups) cleanup();
		cleanups.length = 0;
	});

	// Load tunnels when modal opens
	$effect(() => {
		if (isOpen) {
			tunnelStore.checkStatus();
		}
	});

	function goToSettings() {
		onClose();
		openSettingsModal('tunnel');
	}
</script>

<Modal {isOpen} {onClose} title="Public Tunnel" size="md">
	<div class="space-y-6">
		<!-- Add new tunnel form -->
		<TunnelInactive />

		<!-- Active tunnels list -->
		{#if uniqueTunnels().length > 0}
			<div>
				<div class="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">
					Active Tunnels
				</div>
				<div class="space-y-3">
					{#each uniqueTunnels() as tunnel (tunnel.id ?? `${tunnel.type}-${tunnel.port}`)}
						<TunnelActive
							port={tunnel.port}
							publicUrl={tunnel.publicUrl}
							startedAt={tunnel.startedAt}
							autoStopMinutes={tunnel.autoStopMinutes}
							type={tunnel.type}
							name={tunnel.name}
							id={tunnel.id}
							ingress={tunnel.ingress}
							connections={tunnel.connections}
						/>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Settings hint (admin only — non-admin users cannot access Settings → Tunnel) -->
		{#if isAdmin}
			<div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/30">
				<Icon name="lucide:info" class="w-3.5 h-3.5 text-slate-400 shrink-0" />
				<p class="text-xs text-slate-400 dark:text-slate-500">
					For persistent custom domains, configure tunnels in
					<button type="button" class="text-violet-600 dark:text-violet-400 hover:underline cursor-pointer font-medium" onclick={goToSettings}>
						Settings &rarr; Tunnel
					</button>
				</p>
			</div>
		{/if}
	</div>
</Modal>
