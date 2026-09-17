<script lang="ts">
	import { tunnelStore } from '$frontend/stores/features/tunnel.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ShareLinkCard from '$frontend/components/common/share/ShareLinkCard.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { debug } from '$shared/utils/logger';

	import { onMount } from 'svelte';

	interface IngressInfo {
		hostname?: string;
		service: string;
	}

	interface Props {
		port: number;
		publicUrl: string;
		startedAt: string;
		autoStopMinutes: number;
		type?: 'quick' | 'remote' | 'local';
		name?: string;
		id?: string;
		ingress?: IngressInfo[];
		connections?: number;
	}

	const { port, publicUrl, startedAt, autoStopMinutes, type = 'quick', name, id, ingress, connections = 0 }: Props = $props();

	const isQuick = $derived(type === 'quick');
	// A quick tunnel pointing at Clopen's own port was created by Remote Access —
	// label it as such so both surfaces agree on what it is.
	const isRemoteAccess = $derived(tunnelStore.isSelfTunnel(port, type));
	const displayLabel = $derived(
		name ? name : isRemoteAccess ? 'Remote Access' : isQuick ? `Port ${port}` : type === 'remote' ? 'Remote Tunnel' : 'Local Tunnel'
	);
	const typeIcon = $derived(
		isRemoteAccess ? 'lucide:radio' : type === 'remote' ? 'lucide:cloud' : type === 'local' ? 'lucide:server' : 'lucide:zap'
	);
	const typeBadge = $derived(
		isRemoteAccess ? 'Remote Access' : type === 'remote' ? 'Remote' : type === 'local' ? 'Local' : 'Quick'
	);
	const ingressHostnames = $derived(ingress?.filter((r) => r.hostname) ?? []);
	const isManagedTunnel = $derived(type === 'remote' || type === 'local');
	const isAdmin = $derived(authStore.isAdmin);

	// Edge-connection status: cloudflared opens several HA connections to Cloudflare
	// once a tunnel goes live, so `connections > 0` means it is actually reachable.
	const isPublic = $derived(connections > 0);
	const connectionLabel = $derived(isPublic ? 'Public' : 'Connecting…');

	// Build a unified list of URL entries for consistent rendering
	const urlEntries = $derived(() => {
		if (ingressHostnames.length > 0) {
			return ingressHostnames.map((r) => ({
				url: `https://${r.hostname}`,
				hostname: r.hostname!,
				service: r.service
			}));
		}
		if (publicUrl) {
			return [{ url: publicUrl, hostname: publicUrl.replace(/^https?:\/\//, ''), service: `http://localhost:${port}` }];
		}
		return [];
	});

	let now = $state(Date.now());

	// Update every second for countdown (only needed for quick tunnels with auto-stop)
	onMount(() => {
		if (!isQuick || autoStopMinutes === 0) return;
		const interval = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => clearInterval(interval);
	});

	// ShareLinkCard performs the copy (including the non-secure-context
	// fallback); this only reports the outcome the way this panel always has.
	function notifyCopied(ok: boolean) {
		if (ok) {
			addNotification({ type: 'success', title: 'Success', message: 'URL copied to clipboard' });
		} else {
			debug.error('tunnel', 'Failed to copy tunnel URL');
			addNotification({ type: 'error', title: 'Error', message: 'Failed to copy URL' });
		}
	}

	async function handleStopTunnel() {
		try {
			await tunnelStore.stopQuickTunnel(port);
			addNotification({
				type: 'success',
				title: 'Success',
				message: `Tunnel on port ${port} stopped`
			});
		} catch (error) {
			debug.error('tunnel', 'Failed to stop tunnel:', error);
			addNotification({
				type: 'error',
				title: 'Error',
				message: 'Failed to stop tunnel'
			});
		}
	}

	function getCountdown(startedAt: string, autoStopMins: number, currentTime: number): string {
		if (autoStopMins === 0) return 'No limit';

		const start = new Date(startedAt).getTime();
		const endTime = start + autoStopMins * 60 * 1000;
		const remainingMs = endTime - currentTime;

		if (remainingMs <= 0) return 'Stopping...';

		const totalSeconds = Math.floor(remainingMs / 1000);
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;

		if (hours > 0) return `${hours}h ${minutes}m left`;
		if (minutes > 0) return `${minutes}m ${seconds}s left`;
		return `${seconds}s left`;
	}
</script>

<div class="bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
	<!-- Header -->
	<div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100 dark:border-slate-700/50">
		<div class="flex items-center gap-2.5">
			<Icon name={typeIcon} class="w-4 h-4 text-slate-500 dark:text-slate-400" />
			<span class="text-sm font-semibold text-slate-900 dark:text-slate-100">{displayLabel}</span>
			<span class="text-2xs px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 font-medium">
				{typeBadge}
			</span>
			<span
				class="flex items-center gap-1 text-2xs font-medium {isPublic
					? 'text-green-600 dark:text-green-400'
					: 'text-amber-600 dark:text-amber-400'}"
				title={isPublic ? `${connections} live edge connection${connections > 1 ? 's' : ''} to Cloudflare` : 'Establishing edge connections…'}
			>
				<span class="relative flex w-1.5 h-1.5">
					{#if !isPublic}
						<span class="absolute inline-flex w-full h-full rounded-full bg-amber-400 opacity-75 animate-ping"></span>
					{/if}
					<span class="relative inline-flex w-1.5 h-1.5 rounded-full {isPublic ? 'bg-green-500' : 'bg-amber-500'}"></span>
				</span>
				{connectionLabel}
			</span>
		</div>
		<div class="flex items-center gap-2">
			{#if isQuick && autoStopMinutes > 0}
				<span class="text-xs text-slate-500 dark:text-slate-400">{getCountdown(startedAt, autoStopMinutes, now)}</span>
			{/if}
			{#if isQuick}
				<button
					onclick={handleStopTunnel}
					class="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors cursor-pointer"
				>
					<Icon name="lucide:circle-x" class="w-3.5 h-3.5" />
					Stop
				</button>
			{:else if isAdmin}
				<span class="text-2xs text-slate-400 dark:text-slate-500 italic">Managed in Settings</span>
			{/if}
		</div>
	</div>

	<!-- URL entries - unified layout for all types -->
	<div class="px-4 py-3">
		{#if urlEntries().length > 0}
			<div class="space-y-2.5">
				{#each urlEntries() as entry}
					<ShareLinkCard
						url={entry.url}
						display={entry.hostname}
						linkify
						qr="toggle"
						onCopied={notifyCopied}
					>
						{#snippet meta()}
							<Icon name="lucide:arrow-right" class="w-3 h-3 shrink-0" />
							<span class="font-mono">{entry.service}</span>
						{/snippet}
					</ShareLinkCard>
				{/each}
			</div>
		{:else if isManagedTunnel}
			<!-- Empty state for managed tunnels without domains -->
			<div class="flex items-center gap-2 py-1 text-slate-400 dark:text-slate-500">
				<Icon name="lucide:globe" class="w-4 h-4 shrink-0" />
				<span class="text-sm italic">No domains connected to this tunnel service yet</span>
			</div>
		{/if}
	</div>
</div>
