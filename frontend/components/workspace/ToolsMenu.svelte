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
	import { containersStore } from '$frontend/stores/features/containers.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		collapsed?: boolean;
		mobile?: boolean;
		onRemoteAccess: () => void;
		onPublicTunnel: () => void;
		onDbClient: () => void;
		onSshClient: () => void;
		onPorts: () => void;
		onContainers: () => void;
		onMemory: () => void;
		onNotes: () => void;
		onWork: () => void;
		onDeployments: () => void;
	}

	const {
		collapsed = false,
		mobile = false,
		onRemoteAccess,
		onPublicTunnel,
		onDbClient,
		onSshClient,
		onPorts,
		onContainers,
		onMemory,
		onNotes,
		onWork,
		onDeployments
	}: Props = $props();

	let isOpen = $state(false);

	const remoteCount = $derived(remoteAccessStore.activeConnections);
	const tunnelCount = $derived(tunnelStore.activeDomainCount);
	const dbCount = $derived(dbClientStore.liveCount);
	const sshCount = $derived(sshClientStore.liveCount);
	const portsCount = $derived(portsStore.liveCount);
	const containersCount = $derived(containersStore.liveCount);
	// A single dot on the trigger signals "something under here is active".
	const hasActivity = $derived(
		remoteCount > 0 ||
			tunnelCount > 0 ||
			dbCount > 0 ||
			sshCount > 0 ||
			portsCount > 0 ||
			containersCount > 0
	);

	interface ToolItem {
		label: string;
		description: string;
		icon: IconName;
		onClick: () => void;
		count: number;
		accent: string;
	}

	interface ToolGroup {
		name: string;
		items: ToolItem[];
	}

	// Tiles carry an icon and a label only, so the description moves to the
	// tooltip: it is worth reading once and costs height on every open.
	const groups = $derived<ToolGroup[]>([
		{
			name: 'Connections',
			items: [
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
					label: 'Containers',
					description: 'Docker and Podman on this machine',
					icon: 'lucide:container',
					onClick: onContainers,
					// Containers running here. Unlike ports, every one of these is
					// something someone chose to start, so all of them count.
					count: containersCount,
					accent: 'text-blue-600 dark:text-blue-400'
				}
			]
		},
		{
			name: 'Workspace',
			items: [
				{
					label: 'Memory',
					description: 'What this workspace has learned',
					icon: 'lucide:brain',
					onClick: onMemory,
					// No live count: memory is not a connection you open, it just accrues.
					count: 0,
					accent: 'text-violet-600 dark:text-violet-400'
				},
				{
					label: 'Notes',
					description: 'Project notes with images',
					icon: 'lucide:sticky-note',
					onClick: onNotes,
					count: 0,
					accent: 'text-amber-600 dark:text-amber-400'
				},
				{
					label: 'Deployments',
					description: 'Builds, logs and what is live',
					icon: 'lucide:rocket',
					onClick: onDeployments,
					// No live count: a build is someone else's machine working, not a
					// connection this one holds, and a badge would blink for something
					// nobody here can act on.
					count: 0,
					accent: 'text-sky-600 dark:text-sky-400'
				},
				{
					// "Issues" alone was a lie by omission: pull requests are half of what
					// is behind it, and the only half with CI, commits and a diff.
					label: 'Issues & PRs',
					description: 'Issues, pull requests and CI',
					icon: 'lucide:circle-dot',
					onClick: onWork,
					// No live count: an open issue is not a connection this machine holds,
					// and a badge counting someone's backlog would nag rather than inform.
					count: 0,
					accent: 'text-rose-600 dark:text-rose-400'
				}
			]
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
		<!--
			The menu grows with every tool that lands, so it is capped at the
			viewport and scrolls rather than being sized by its contents. It opens
			upward from a button that sits at the bottom of the sidebar, so an
			uncapped list ran off the top of the screen — and did so first on the
			small screens that can least afford it.
		-->
		<div
			class="absolute {mobile ? 'top-full right-0 mt-1' : 'bottom-full left-0 mb-1'} flex flex-col w-80 max-w-[calc(100vw-1.5rem)] max-h-[min(28rem,70dvh)] bg-white dark:bg-slate-800 border border-violet-500/20 rounded-lg shadow-2xl shadow-slate-900/20 dark:shadow-black/40 z-50 overflow-hidden"
			transition:scale={{ duration: 150, easing: cubicOut, start: 0.95, opacity: 0 }}
		>
			<div class="flex flex-col min-h-0 overflow-y-auto py-2">
				{#each groups as group, groupIndex (group.name)}
					{#if groupIndex > 0}
						<div class="my-2 mx-3 border-t border-slate-200 dark:border-slate-800"></div>
					{/if}
					<div class="px-3 pb-1.5 text-xs font-medium text-violet-600 dark:text-violet-400 uppercase tracking-wide">
						{group.name}
					</div>
					<div class="grid grid-cols-3 gap-1.5 px-3">
						{#each group.items as item (item.label)}
							<button
								type="button"
								class="flex flex-col items-center gap-1.5 {mobile ? 'py-2.5' : 'py-2'} px-1 bg-transparent border border-slate-200 dark:border-slate-800 rounded-lg cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:border-violet-500/20"
								onclick={() => select(item)}
								title={item.description}
							>
								<div class="relative">
									<Icon name={item.icon} class="w-5 h-5 {item.count > 0 ? item.accent : 'text-slate-500 dark:text-slate-400'}" />
									{#if item.count > 0}
										<span
											class="absolute -top-1.5 -right-2.5 px-1 min-w-3.5 h-3.5 rounded-full bg-slate-100 dark:bg-slate-700 text-[10px] leading-[14px] font-semibold text-center {item.accent}"
										>
											{item.count}
										</span>
									{/if}
								</div>
								<!-- One line only: a wrapping label would make its tile taller than the rest of the row. -->
								<span class="w-full text-[11px] leading-[13px] font-medium text-center text-slate-800 dark:text-slate-200 truncate">
									{item.label}
								</span>
							</button>
						{/each}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
