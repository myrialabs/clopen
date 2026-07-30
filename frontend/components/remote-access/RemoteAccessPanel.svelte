<script lang="ts">
	import { onMount } from 'svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import TunnelQRCode from '$frontend/components/tunnel/TunnelQRCode.svelte';
	import DeviceSessionsList from './DeviceSessionsList.svelte';
	import ws from '$frontend/utils/ws';
	import { remoteAccessStore, type ShareLink } from '$frontend/stores/features/remote-access.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { tunnelStore } from '$frontend/stores/features/tunnel.svelte';
	import { openSettingsModal } from '$frontend/stores/ui/settings-modal.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { debug } from '$shared/utils/logger';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(), onClose }: Props = $props();

	const isAdmin = $derived(authStore.isAdmin);
	const isNoAuth = $derived(authStore.isNoAuth);

	function goToSecurity() {
		onClose();
		openSettingsModal('security');
	}

	// Inviting a member is a team action — it also decides project access — so it
	// lives in Settings → Team, not here. This panel is only for reaching Clopen
	// from your own devices.
	function goToTeam() {
		onClose();
		openSettingsModal('team');
	}

	// Refresh tunnel status on open so the active-connection list is accurate.
	$effect(() => {
		if (isOpen) {
			tunnelStore.checkStatus();
		}
	});

	// The active Remote Access self-tunnel (shared with Public Tunnel), if any.
	const selfTunnel = $derived(tunnelStore.selfTunnel);

	let stopping = $state(false);

	async function stopConnection() {
		if (!selfTunnel) return;
		stopping = true;
		try {
			await tunnelStore.stopQuickTunnel(selfTunnel.port);
			// A tunnel-based link is now dead — clear it so we don't show a stale URL.
			if (link?.source === 'tunnel') link = null;
			addNotification({ type: 'success', title: 'Stopped', message: 'Remote access connection stopped' });
		} catch (err) {
			debug.error('remote-access', 'Failed to stop connection:', err);
			addNotification({ type: 'error', title: 'Error', message: 'Failed to stop connection' });
		} finally {
			stopping = false;
		}
	}

	let link = $state<ShareLink | null>(null);
	let generating = $state(false);
	let error = $state<string | null>(null);
	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	// A tunnel-based link whose tunnel was stopped (e.g. from Public Tunnel) is dead.
	const linkStale = $derived(link?.source === 'tunnel' && !selfTunnel);

	// Live clock so the device link shows a countdown and closes itself when the
	// short-lived code expires (nothing paired in time).
	let now = $state(Date.now());
	$effect(() => {
		if (!isOpen) return;
		const id = setInterval(() => { now = Date.now(); }, 1000);
		return () => clearInterval(id);
	});

	const countdown = $derived.by(() => {
		if (!link?.expiresAt) return null;
		const ms = new Date(link.expiresAt).getTime() - now;
		if (ms <= 0) return '0:00';
		const total = Math.ceil(ms / 1000);
		return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
	});

	// Auto-close the QR once the code lapses so a stale link isn't left on screen.
	$effect(() => {
		if (link?.expiresAt && now >= new Date(link.expiresAt).getTime()) {
			link = null;
			addNotification({ type: 'info', title: 'Link expired', message: 'The device link expired — generate a new one.' });
		}
	});

	async function generate() {
		generating = true;
		error = null;
		copied = false;
		const previous = link;
		try {
			const next = await remoteAccessStore.createDeviceLink();
			// Invalidate the previous link so its old QR/token stops working. The
			// shared tunnel is reused (not restarted) — only the credential rotates.
			if (previous) {
				try {
					await previous.revoke();
				} catch {
					// Best-effort — the old token expires on its own anyway.
				}
			}
			link = next;
			// Reflect any tunnel that was just started in the active-connection list.
			await tunnelStore.checkStatus();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create link';
			debug.error('remote-access', 'Generate link failed:', err);
		} finally {
			generating = false;
		}
	}

	// When a device pairs (`device-claimed`) the shared code/URL is spent. Hide the
	// now-dead QR and let the Connected devices list show the new arrival.
	onMount(() => {
		const off = ws.on('remote-access:changed', (payload: { kind: string }) => {
			if (payload?.kind === 'device-claimed' && link?.kind === 'device') {
				link = null;
				addNotification({ type: 'success', title: 'Device connected', message: 'The device signed in — the link is now closed.' });
			}
		});
		return () => off();
	});

	let cancelling = $state(false);

	// Cancel a pending link — revoke the device code so its QR stops working, then
	// clear it. Mirrors "Revoke invite" for the device-pairing flow.
	async function cancelLink() {
		if (!link) return;
		const current = link;
		cancelling = true;
		try {
			await current.revoke();
			link = null;
		} catch (err) {
			debug.error('remote-access', 'Failed to cancel link:', err);
			addNotification({ type: 'error', title: 'Error', message: 'Failed to cancel link' });
		} finally {
			cancelling = false;
		}
	}

	async function copyLink() {
		if (!link) return;
		try {
			await navigator.clipboard.writeText(link.url);
			copied = true;
			addNotification({ type: 'success', title: 'Copied', message: 'Link copied to clipboard' });
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => { copied = false; }, 2000);
		} catch (err) {
			debug.error('remote-access', 'Copy failed:', err);
			addNotification({ type: 'error', title: 'Error', message: 'Failed to copy link' });
		}
	}
</script>

<Modal {isOpen} {onClose} title="Remote Access" size="md">
	<div class="space-y-5">
		<!-- No Login mode warning -->
		{#if isNoAuth}
			<div class="flex gap-3 p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl">
				<Icon name="lucide:shield-alert" class="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
				<div class="flex-1 text-sm">
					<p class="font-semibold text-amber-800 dark:text-amber-200 mb-1">No Login mode is active</p>
					<p class="text-amber-700 dark:text-amber-300">
						Anyone who opens the link gets <span class="font-semibold">full access without a token</span>. For
						remote sharing we strongly recommend switching to With Login so access is protected.
					</p>
					<button
						type="button"
						onclick={goToSecurity}
						class="inline-flex items-center gap-1.5 mt-2.5 py-1.5 px-3 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 rounded-md text-amber-800 dark:text-amber-200 text-xs font-semibold transition-colors"
					>
						<Icon name="lucide:shield-check" class="w-3.5 h-3.5" />
						Switch to With Login in Security
					</button>
				</div>
			</div>
		{/if}

		<!-- Intro -->
		<div class="flex gap-3 p-4 bg-violet-500/5 dark:bg-violet-500/10 border border-violet-500/20 rounded-xl">
			<Icon name="lucide:radio" class="w-5 h-5 text-violet-600 dark:text-violet-400 flex-shrink-0 mt-0.5" />
			<div class="flex-1 text-sm text-slate-700 dark:text-slate-300">
				<p class="font-semibold mb-1">Reach this Clopen from anywhere</p>
				<p class="text-slate-600 dark:text-slate-400">
					Generate one link — scan or open it on another device to get connected.
				</p>
			</div>
		</div>

		<!-- Active connection (shared with Public Tunnel) -->
		{#if selfTunnel}
			<div class="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/50 overflow-hidden">
				<div class="flex items-center justify-between gap-3 px-3.5 py-2.5">
					<div class="flex items-center gap-2 min-w-0">
						<span class="relative flex w-1.5 h-1.5 shrink-0">
							{#if (selfTunnel.connections ?? 0) > 0}
								<span class="relative inline-flex w-1.5 h-1.5 rounded-full bg-green-500"></span>
							{:else}
								<span class="absolute inline-flex w-full h-full rounded-full bg-amber-400 opacity-75 animate-ping"></span>
								<span class="relative inline-flex w-1.5 h-1.5 rounded-full bg-amber-500"></span>
							{/if}
						</span>
						<div class="min-w-0">
							<div class="text-xs font-semibold text-slate-900 dark:text-slate-100">
								{(selfTunnel.connections ?? 0) > 0 ? 'Connection active' : 'Connecting…'}
							</div>
							<a
								href={selfTunnel.publicUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="block text-2xs font-mono text-violet-600 dark:text-violet-400 hover:underline truncate"
							>
								{selfTunnel.publicUrl.replace(/^https?:\/\//, '')}
							</a>
						</div>
					</div>
					<button
						type="button"
						onclick={stopConnection}
						disabled={stopping}
						class="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors disabled:opacity-50 shrink-0"
						title="Stop — also removes it from Public Tunnel"
					>
						<Icon name="lucide:circle-x" class="w-3.5 h-3.5" />
						Stop
					</button>
				</div>
			</div>
		{/if}

		<!-- Add-a-device header -->
		<div class="flex items-center gap-2">
			<Icon name="lucide:smartphone" class="w-4 h-4 text-slate-500 dark:text-slate-400" />
			<span class="text-sm font-semibold text-slate-800 dark:text-slate-200">Add a device</span>
		</div>

		<!-- Description -->
		<p class="text-sm text-slate-600 dark:text-slate-400 -mt-1">
			Sign in one of your own devices as {authStore.currentUser?.name ?? 'you'}. The link is single-use — scan it before it expires.
		</p>

		<!-- Result / generate -->
		{#if link}
			<div class="space-y-3">
				{#if linkStale}
					<div class="flex items-start gap-2 p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs">
						<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
						<span class="text-amber-700 dark:text-amber-300">This link is no longer reachable. Generate a new one.</span>
					</div>
				{/if}
				<!-- Countdown -->
				{#if countdown}
					<div class="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
						<Icon name="lucide:timer" class="w-3.5 h-3.5" />
						<span>Expires in <span class="font-mono tabular-nums text-slate-700 dark:text-slate-300">{countdown}</span></span>
					</div>
				{/if}

				<!-- URL + copy -->
				<div class="flex items-center gap-2 px-3 py-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg">
					<div class="flex-1 min-w-0 font-mono text-xs text-slate-600 dark:text-slate-400 truncate select-all">
						{link.url}
					</div>
					<button
						type="button"
						onclick={copyLink}
						class="flex items-center justify-center w-7 h-7 rounded-md transition-all shrink-0
							{copied
							? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'
							: 'hover:bg-violet-100 dark:hover:bg-violet-900/30 text-slate-400 hover:text-violet-600 dark:hover:text-violet-400'}"
						title="Copy link"
					>
						<Icon name={copied ? 'lucide:check' : 'lucide:copy'} class="w-3.5 h-3.5" />
					</button>
				</div>

				<!-- QR -->
				<div class="p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
					<TunnelQRCode value={link.url} />
					<p class="text-center text-xs text-slate-500 dark:text-slate-400 mt-1">
						Scan with the other device's camera
					</p>
				</div>

				<div class="flex items-center gap-3">
					<button
						type="button"
						onclick={generate}
						disabled={generating || cancelling}
						class="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition-colors disabled:opacity-50"
					>
						<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5 {generating ? 'animate-spin' : ''}" />
						Generate a new link
					</button>
					<button
						type="button"
						onclick={cancelLink}
						disabled={generating || cancelling}
						class="inline-flex items-center gap-1.5 text-xs font-medium text-red-500 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 transition-colors disabled:opacity-50"
					>
						<Icon name="lucide:x" class="w-3.5 h-3.5" />
						Cancel
					</button>
				</div>
			</div>
		{:else}
			<button
				type="button"
				onclick={generate}
				disabled={generating}
				class="inline-flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{#if generating}
					<div class="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent"></div>
					<span>Preparing link…</span>
				{:else}
					<Icon name="lucide:smartphone" class="w-4 h-4" />
					<span>Create device link</span>
				{/if}
			</button>
		{/if}

		<!-- Error -->
		{#if error}
			<div class="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm">
				<Icon name="lucide:circle-alert" class="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
				<span class="text-red-600 dark:text-red-300">{error}</span>
			</div>
		{/if}

		<!-- Invite a member (admin) — a team action, handled in Settings -->
		{#if isAdmin}
			<button
				type="button"
				onclick={goToTeam}
				class="flex items-center justify-between gap-3 w-full px-3.5 py-2.5 bg-slate-100/70 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg text-left hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors"
			>
				<div class="flex items-center gap-2.5 min-w-0">
					<Icon name="lucide:user-plus" class="w-4 h-4 text-violet-600 dark:text-violet-400 shrink-0" />
					<div class="min-w-0">
						<div class="text-sm font-medium text-slate-800 dark:text-slate-200">Invite a member</div>
						<div class="text-xs text-slate-500 dark:text-slate-400 truncate">Add someone new and set their project access in Team</div>
					</div>
				</div>
				<Icon name="lucide:arrow-right" class="w-4 h-4 text-slate-400 shrink-0" />
			</button>
		{/if}

		<!-- Your devices -->
		<div class="pt-1 border-t border-slate-200 dark:border-slate-700/60">
			<div class="flex items-center gap-2 mt-3 mb-2.5">
				<Icon name="lucide:monitor-smartphone" class="w-4 h-4 text-slate-500 dark:text-slate-400" />
				<span class="text-sm font-semibold text-slate-800 dark:text-slate-200">Your devices</span>
			</div>
			<DeviceSessionsList scope="me" />
		</div>
	</div>
</Modal>
