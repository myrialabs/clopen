<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import WorkspaceLayout from '$frontend/components/workspace/WorkspaceLayout.svelte';
	import ConnectionBanner from '$frontend/components/common/feedback/ConnectionBanner.svelte';
	import UpdateBanner from '$frontend/components/common/feedback/UpdateBanner.svelte';
	import RestartRequiredDialog from '$frontend/components/common/feedback/RestartRequiredDialog.svelte';
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
	import { startUpdateChecker, stopUpdateChecker } from '$frontend/stores/ui/update.svelte';
	import ws from '$frontend/utils/ws';
	import { showNotificationWithActions } from '$frontend/stores/ui/notification.svelte';
	import { openTeamForUser } from '$frontend/stores/ui/settings-modal.svelte';

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

		<div class="flex-1 min-h-0">
			<WorkspaceLayout>
				{#snippet children()}
					<!-- Main content -->
				{/snippet}
			</WorkspaceLayout>
		</div>
	</div>

	<RestartRequiredDialog />
{/if}
