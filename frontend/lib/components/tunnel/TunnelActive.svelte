<script lang="ts">
	import { tunnelStore } from '$frontend/lib/stores/features/tunnel.svelte';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import TunnelQRCode from './TunnelQRCode.svelte';
	import { addNotification } from '$frontend/lib/stores/ui/notification.svelte';

	import { onMount } from 'svelte';

	interface Props {
		port: number;
		publicUrl: string;
		startedAt: string;
		autoStopMinutes: number;
	}

	const { port, publicUrl, startedAt, autoStopMinutes }: Props = $props();

	let showQR = $state(false);
	let copied = $state(false);
	let now = $state(Date.now());

	// Update every second for countdown
	onMount(() => {
		const interval = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => clearInterval(interval);
	});

	async function copyUrl() {
		try {
			await navigator.clipboard.writeText(publicUrl);
			copied = true;
			addNotification({
				type: 'success',
				title: 'Success',
				message: 'URL copied to clipboard'
			});

			// Reset icon after 2 seconds
			setTimeout(() => {
				copied = false;
			}, 2000);
		} catch (error) {
			console.error('Failed to copy:', error);
			addNotification({
				type: 'error',
				title: 'Error',
				message: 'Failed to copy URL'
			});
		}
	}

	async function handleStopTunnel() {
		try {
			await tunnelStore.stopTunnel(port);
			addNotification({
				type: 'success',
				title: 'Success',
				message: `Tunnel on port ${port} stopped`
			});
		} catch (error) {
			console.error('Failed to stop tunnel:', error);
			addNotification({
				type: 'error',
				title: 'Error',
				message: 'Failed to stop tunnel'
			});
		}
	}

	function getCountdown(startedAt: string, autoStopMins: number, currentTime: number): string {
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

<div class="bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg p-4">
	<!-- Header -->
	<div class="flex items-start justify-between gap-3 mb-3">
		<div class="flex items-center gap-2">
			<div class="flex items-center gap-1.5">
				<div class="w-2 h-2 rounded-full bg-green-500"></div>
				<span class="text-sm font-semibold text-slate-900 dark:text-slate-100">Port {port}</span>
			</div>
			<span class="text-xs text-slate-500 dark:text-slate-400">{getCountdown(startedAt, autoStopMinutes, now)}</span>
		</div>
		<button
			onclick={handleStopTunnel}
			class="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
		>
			<Icon name="lucide:circle-x" class="w-3.5 h-3.5" />
			Stop
		</button>
	</div>

	<!-- Public URL -->
	<div class="space-y-3">
		<div class="flex items-center gap-2">
			<Icon name="lucide:link" class="w-4 h-4 text-violet-600 dark:text-violet-400 flex-shrink-0" />
			<a
				href={publicUrl}
				target="_blank"
				rel="noopener noreferrer"
				class="text-sm text-violet-600 dark:text-violet-400 hover:underline truncate flex-1 font-medium"
			>
				{publicUrl}
			</a>
		</div>

		<!-- Action Buttons -->
		<div class="flex gap-2">
			<button
				onclick={copyUrl}
				class={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors rounded ${
					copied
						? 'text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-900/20'
						: 'text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-700/50 hover:bg-slate-200 dark:hover:bg-slate-700'
				}`}
			>
				{#if copied}
					<Icon name="lucide:check" class="w-3.5 h-3.5" />
					Copied!
				{:else}
					<Icon name="lucide:copy" class="w-3.5 h-3.5" />
					Copy
				{/if}
			</button>
			<button
				onclick={() => (showQR = !showQR)}
				class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-700/50 hover:bg-slate-200 dark:hover:bg-slate-700 rounded transition-colors"
			>
				<Icon name="lucide:qr-code" class="w-3.5 h-3.5" />
				{showQR ? 'Hide' : 'Show'} QR
			</button>
		</div>

		<!-- QR Code -->
		{#if showQR}
			<div class="pt-2 border-t border-slate-200 dark:border-slate-700">
				<TunnelQRCode value={publicUrl} />
			</div>
		{/if}
	</div>
</div>
