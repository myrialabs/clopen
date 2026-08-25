<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import WorkspaceLayout from '$frontend/components/workspace/WorkspaceLayout.svelte';
	import ConnectionBanner from '$frontend/components/common/feedback/ConnectionBanner.svelte';
	import UpdateBanner from '$frontend/components/common/feedback/UpdateBanner.svelte';
	import MemorySetupBanner from '$frontend/components/common/feedback/MemorySetupBanner.svelte';
	import RestartRequiredDialog from '$frontend/components/common/feedback/RestartRequiredDialog.svelte';
	import WhatsNewDialog from '$frontend/components/common/feedback/WhatsNewDialog.svelte';
	import LoadingScreen from '$frontend/components/common/feedback/LoadingScreen.svelte';
	import SetupPage from '$frontend/components/auth/SetupPage.svelte';
	import LoginPage from '$frontend/components/auth/LoginPage.svelte';
	import InvitePage from '$frontend/components/auth/InvitePage.svelte';
	import DeviceClaimPage from '$frontend/components/auth/DeviceClaimPage.svelte';
	import { backgroundTerminalService } from '$frontend/services/terminal/background';
	import { initializeMCPPreview } from '$frontend/services/preview';
	import { initPreviewTabSync } from '$frontend/stores/features/preview-tabs-workspace.svelte';
	import { globalStreamMonitor } from '$frontend/services/notification/global-stream-monitor';
	import { tunnelStore } from '$frontend/stores/features/tunnel.svelte';
	import { remoteAccessStore } from '$frontend/stores/features/remote-access.svelte';
	import { portsStore } from '$frontend/stores/features/ports.svelte';
	import { startUpdateChecker, stopUpdateChecker } from '$frontend/stores/ui/update.svelte';
	import ws from '$frontend/utils/ws';
	import { showNotificationWithActions } from '$frontend/stores/ui/notification.svelte';
	import { openTeamForUser } from '$frontend/stores/ui/settings-modal.svelte';
	import { debug } from '$shared/utils/logger';

	let servicesInitialized = false;

	// Initialize auth on mount
	onMount(async () => {
		await authStore.initialize();
	});

	// Initialize background services when auth is ready
	$effect(() => {
		if (authStore.authState === 'ready' && !servicesInitialized) {
			servicesInitialized = true;

			// Initialize global stream monitor (registers WS listener, non-blocking)
			globalStreamMonitor.initialize();

			// Initialize background terminal service
			backgroundTerminalService.initialize();

			// Initialize MCP Preview Integration
			initializeMCPPreview();

			// Register always-on preview tab-lifecycle sync so MCP-opened tabs appear
			// in real time even when the Preview panel is hidden/unmounted.
			initPreviewTabSync();

			// Restore tunnel status and listen for realtime updates
			tunnelStore.checkStatus();
			tunnelStore.initRealtimeListener();

			// Keep the Remote Access share count in sync for the sidebar indicator
			remoteAccessStore.initRealtimeListener();

			// Keep the Ports count in sync. The server only scans when a terminal
			// session is actually running, so an idle workspace costs nothing.
			portsStore.initRealtimeListener();

			// Nudge admins to set project access when a new member joins via an invite,
			// so the "invite → join → grant access" flow doesn't dead-end.
			ws.on('auth:users-changed', (payload: { type: string; userId: string }) => {
				if (payload?.type !== 'added' || !authStore.isAdmin) return;
				showNotificationWithActions(
					'info',
					'New member joined',
					'Review which projects they can access.',
					[{ label: 'Set project access', action: () => openTeamForUser(payload.userId) }]
				);
			});

			// Start periodic update checker
			startUpdateChecker();
		}
	});

	onDestroy(() => {
		stopUpdateChecker();
	});
</script>

<!--
	Last-resort boundary. Nested boundaries (e.g. per tool renderer) handle the
	failures they can describe; this one only exists so that an unforeseen render
	error degrades to a recoverable screen instead of an empty page the user
	cannot navigate away from.
-->
<svelte:boundary onerror={(error) => debug.error('workspace', 'Unhandled render error:', error)}>
{#if authStore.authState === 'loading'}
	<LoadingScreen isVisible={true} progress={30} loadingText="Connecting..." />
{:else if authStore.authState === 'setup'}
	<SetupPage />
{:else if authStore.authState === 'login'}
	<LoginPage />
{:else if authStore.authState === 'invite'}
	<InvitePage />
{:else if authStore.authState === 'device'}
	<DeviceClaimPage />
{:else}
	<!-- authState === 'ready' -->
	<div class="flex flex-col h-dvh w-screen overflow-hidden">
		<ConnectionBanner />
		<UpdateBanner />
		<MemorySetupBanner />

		<div class="flex-1 min-h-0">
			<WorkspaceLayout>
				{#snippet children()}
					<!-- Main content -->
				{/snippet}
			</WorkspaceLayout>
		</div>
	</div>

	<RestartRequiredDialog />
	<WhatsNewDialog />
{/if}

{#snippet failed(error)}
	<div class="flex flex-col items-center justify-center gap-3 h-dvh w-screen p-6 text-center bg-slate-50 dark:bg-slate-900">
		<h1 class="text-lg font-semibold text-slate-700 dark:text-slate-200">Something went wrong</h1>
		<p class="max-w-md text-sm text-slate-500 dark:text-slate-400">
			Clopen hit an unexpected error while rendering. Reloading usually recovers your session.
		</p>
		<p class="max-w-md font-mono text-xs break-words text-slate-400 dark:text-slate-500">
			{error instanceof Error ? error.message : String(error)}
		</p>
		<button
			class="px-4 py-1.5 text-sm font-medium rounded-md bg-blue-600 hover:bg-blue-700 text-white transition-colors"
			onclick={() => location.reload()}
		>
			Reload
		</button>
	</div>
{/snippet}
</svelte:boundary>
