<script lang="ts">
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import { tunnelStore } from '$frontend/stores/features/tunnel.svelte';
	import { remoteAccessStore } from '$frontend/stores/features/remote-access.svelte';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';
	import { sshClientStore } from '$frontend/stores/features/ssh-client.svelte';
	import { portsStore } from '$frontend/stores/features/ports.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		collapsed?: boolean;
		mobile?: boolean;
		onRemoteAccess: () => void;
		onPublicTunnel: () => void;
		onDbClient: () => void;
		onSshClient: () => void;
		onPorts: () => void;
		onMemory: () => void;
	}

	const {
		collapsed = false,
		mobile = false,
		onRemoteAccess,
		onPublicTunnel,
		onDbClient,
		onSshClient,
		onPorts,
		onMemory
	}: Props = $props();

	let isOpen = $state(false);

	const remoteCount = $derived(remoteAccessStore.activeConnections);
	const tunnelCount = $derived(tunnelStore.activeDomainCount);
	const dbCount = $derived(dbClientStore.liveCount);
	const sshCount = $derived(sshClientStore.liveCount);
	const portsCount = $derived(portsStore.liveCount);
	// A single dot on the trigger signals "something under here is active".
	const hasActivity = $derived(
		remoteCount > 0 || tunnelCount > 0 || dbCount > 0 || sshCount > 0 || portsCount > 0
	);

	interface ToolItem {
		label: string;
		description: string;
		icon: IconName;
		onClick: () => void;
		count: number;
		accent: string;
	}

	const items = $derived<ToolItem[]>([
		{
			label: 'Remote Access',
			description: 'Share a link to reach this Clopen',
			icon: 'lucide:radio',
			onClick: onRemoteAccess,
			count: remoteCount,
			accent: 'text-violet-600 dark:text-violet-400'
		},
		{
			label: 'Public Tunnel',
			description: 'Expose a local port via Cloudflare',
			icon: 'lucide:cloud-upload',
			onClick: onPublicTunnel,
			count: tunnelCount,
			accent: 'text-green-600 dark:text-green-400'
		},
		{
			label: 'DB Client',
			description: 'Connect to a database',
			icon: 'lucide:database',
			onClick: onDbClient,
			count: dbCount,
			accent: 'text-emerald-600 dark:text-emerald-400'
		},
		{
			label: 'SSH Client',
			description: 'Shell, files, and port forwarding',
			icon: 'lucide:server',
			onClick: onSshClient,
			count: sshCount,
			accent: 'text-sky-600 dark:text-sky-400'
		},
		{
			label: 'Ports',
			description: 'What is listening on this machine',
			icon: 'lucide:cable',
			onClick: onPorts,
			// Counts ports born in a Clopen terminal, not every port on the box —
			// a machine's own listeners are a constant, not a sign of activity.
			count: portsCount,
			accent: 'text-amber-600 dark:text-amber-400'
		},
		{
			label: 'Memory',
			description: 'What this workspace has learned',
			icon: 'lucide:brain',
			onClick: onMemory,
			// No live count: memory is not a connection you open, it just accrues.
			count: 0,
			accent: 'text-violet-600 dark:text-violet-400'
		}
	]);

	function toggleMenu() {
		isOpen = !isOpen;
	}

	function select(item: ToolItem) {
		isOpen = false;
		item.onClick();
	}

	function handleClickOutside() {
		isOpen = false;
	}
</script>

<div class="relative" use:clickOutside={handleClickOutside}>
	{#if collapsed}
		<!-- Collapsed: Icon Only -->
		<button
			type="button"
			class="flex items-center justify-center bg-transparent border-none text-slate-500 cursor-pointer transition-all duration-150 relative
				{mobile
				? 'w-9 h-8 rounded-md active:bg-violet-500/10'
				: 'w-9 h-9 rounded-lg hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100'}
				{isOpen ? 'bg-violet-500/10 text-slate-900 dark:text-slate-100' : ''}"
			onclick={toggleMenu}
			aria-label="More Tools"
			aria-expanded={isOpen}
			title="More Tools"
		>
			<Icon name="lucide:wrench" class={mobile ? 'w-4.5 h-4.5' : 'w-5 h-5'} />
			{#if hasActivity}
				<span
					class="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-green-500 border-2 border-slate-50 dark:border-slate-900/95"
				></span>
			{/if}
		</button>
	{:else}
		<!-- Expanded: Full Width -->
		<button
			type="button"
			class="flex items-center gap-2.5 w-full py-2.5 px-3 bg-transparent border-none rounded-lg text-slate-500 text-sm cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100
				{isOpen ? 'bg-violet-500/10 text-slate-900 dark:text-slate-100' : ''}"
			onclick={toggleMenu}
			aria-label="More Tools"
			aria-expanded={isOpen}
		>
			<div class="relative">
				<Icon name="lucide:wrench" class="w-4 h-4" />
				{#if hasActivity}
					<span
						class="absolute -top-1 -right-1 w-2 h-2 bg-green-500 rounded-full border-2 border-slate-50 dark:border-slate-900/95"
					></span>
				{/if}
			</div>
			<span class="flex-1 text-left">More Tools</span>
		</button>
	{/if}

	{#if isOpen}
		<div
			class="absolute {mobile ? 'top-full right-0 mt-1' : 'bottom-full left-0 mb-1'} w-64 bg-white dark:bg-slate-800 border border-violet-500/20 rounded-lg shadow-2xl shadow-slate-900/20 dark:shadow-black/40 z-50 overflow-hidden"
			transition:scale={{ duration: 150, easing: cubicOut, start: 0.95, opacity: 0 }}
		>
			<div class="py-1.5">
				<div class="px-3 py-1.5 text-xs font-semibold text-slate-600 dark:text-slate-500 uppercase tracking-wider">
					More Tools
				</div>
				{#each items as item (item.label)}
					<button
						type="button"
						class="flex items-center gap-3 w-full px-3 py-2.5 bg-transparent border-none text-left cursor-pointer transition-all duration-150 hover:bg-violet-500/10"
						onclick={() => select(item)}
					>
						<Icon name={item.icon} class="w-4 h-4 shrink-0 {item.count > 0 ? item.accent : 'text-slate-500 dark:text-slate-400'}" />
						<div class="flex flex-col min-w-0 flex-1">
							<span class="text-sm font-medium text-slate-800 dark:text-slate-200">{item.label}</span>
							<span class="text-xs text-slate-500 dark:text-slate-500 truncate">{item.description}</span>
						</div>
						{#if item.count > 0}
							<span class="text-xs font-semibold {item.accent} shrink-0">{item.count}</span>
						{/if}
					</button>
				{/each}
			</div>
		</div>
	{/if}
</div>
