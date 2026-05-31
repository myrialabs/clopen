<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { fade } from 'svelte/transition';
	import { browser } from '$frontend/app-environment';

	// Stores
	import {
		workspaceState,
		initializeWorkspace,
	} from '$frontend/stores/ui/workspace.svelte';
	import { appState, setAppLoading, setAppInitialized, restoreLastView, restoreUnreadSessions } from '$frontend/stores/core/app.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { sessionState } from '$frontend/stores/core/sessions.svelte';

	// Components
	import DesktopLayout from './layout/DesktopLayout.svelte';
	import MobileLayout from './layout/MobileLayout.svelte';
	import LoadingScreen from '$frontend/components/common/feedback/LoadingScreen.svelte';
	import ModalProvider from '$frontend/components/workspace/ModalProvider.svelte';
	import SettingsModal from '$frontend/components/settings/SettingsModal.svelte';
	import NotificationToast from '$frontend/components/common/feedback/NotificationToast.svelte';

	// Services
	import { initializeTheme } from '$frontend/utils/theme';
	import { initializeStore } from '$frontend/stores/core/app.svelte';
	import { initializeProjects } from '$frontend/stores/core/projects.svelte';
	import { initializeSessions } from '$frontend/stores/core/sessions.svelte';
	import { initializeNotifications, notificationStore } from '$frontend/stores/ui/notification.svelte';
	import { applyServerSettings, loadSystemSettings } from '$frontend/stores/features/settings.svelte';
	import { applyTodoPanelState } from '$frontend/stores/ui/todo-panel.svelte';
	import { presenceState, initPresence } from '$frontend/stores/core/presence.svelte';
	import { updateTitleBadge } from '$frontend/services/title.service';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';

	const { children } = $props();

	// Responsive state
	let isMobile = $state(false);
	let windowWidth = $state(0);

	// Loading state
	let loadingProgress = $state(0);
	let loadingText = $state('Initializing Workspace...');

	// Set progress directly — CSS transition in LoadingScreen handles smooth animation
	function setProgress(value: number, text?: string) {
		loadingProgress = value;
		if (text) loadingText = text;
	}

	// Responsive handler
	function handleResize() {
		if (browser) {
			windowWidth = window.innerWidth;
			isMobile = windowWidth < 1024;
		}
	}

	// Initialize
	onMount(async () => {
		handleResize();
		window.addEventListener('resize', handleResize);

		setAppLoading(true);

		try {
			// Step 1: Core initialization (theme, workspace, notifications — all sync/localStorage)
			setProgress(10, 'Initializing core systems...');
			initializeTheme();
			initializeStore();
			initializeNotifications();
			initializeWorkspace();

			// Step 2: WebSocket is already connected (auth completed before this mounts)
			setProgress(20, 'Connecting...');
			await ws.waitUntilConnected(10000);

			// Step 3: Restore user state from server
			setProgress(30, 'Restoring state...');
			let serverState: { currentProjectId: string | null; lastView: string | null; settings: any; unreadSessions: any; todoPanelState: any } | null = null;
			try {
				serverState = await ws.http('user:restore-state', {});
				debug.log('workspace', 'Server state restored:', serverState);
			} catch (err) {
				debug.warn('workspace', 'Failed to restore server state, using defaults:', err);
			}

			// Step 4: Apply restored state + load system settings + setup presence
			setProgress(40);
			if (serverState?.settings) {
				applyServerSettings(serverState.settings);
			}
			applyTodoPanelState(serverState?.todoPanelState);
			restoreLastView(serverState?.lastView);
			restoreUnreadSessions(serverState?.unreadSessions);
			await loadSystemSettings();
			initPresence();

			// Step 5 + 6: Restore the saved project and its session.
			//
			// Mirror the project-switch path (setCurrentProject) by holding
			// isRestoring across the whole project + session restore. On a full
			// refresh of the current project this is the ONLY signal the chat dock
			// has to restore its saved reading position instead of auto-scrolling
			// to the bottom and clobbering it. Without it, ChatMessages' restore
			// protections (suppressAutoScroll + the scroll-recording guard) never
			// engage and the saved anchor is overwritten with `atBottom`.
			const isRestoringProject = !!serverState?.currentProjectId;
			if (isRestoringProject) appState.isRestoring = true;
			try {
				// Step 5: Load projects (with server-restored currentProjectId)
				setProgress(50, 'Loading projects...');
				await initializeProjects(serverState?.currentProjectId);

				// Step 6: Load sessions
				setProgress(70, 'Restoring sessions...');
				await initializeSessions();
			} finally {
				if (isRestoringProject) appState.isRestoring = false;
			}

			// Step 7: Ready
			setProgress(100, 'Ready!');
		} catch (error) {
			debug.error('workspace', 'Initialization error:', error);
			setProgress(100, 'Error during initialization');
		} finally {
			// Small delay for CSS transition to finish, then dismiss loading screen
			setTimeout(() => {
				setAppInitialized();
			}, 100);
		}
	});

	onDestroy(() => {
		if (browser) {
			window.removeEventListener('resize', handleResize);
		}
	});

	// Reactive title badge: count non-idle indicators across all projects
	$effect(() => {
		const statuses = presenceState.statuses;
		const unreadSessions = appState.unreadSessions;
		const currentSessionId = sessionState.currentSession?.id;

		// Count streaming sessions (green + amber)
		const streamingSessionIds = new Set<string>();
		for (const status of statuses.values()) {
			if (!status.streams) continue;
			for (const stream of status.streams) {
				if (stream.status === 'active') {
					streamingSessionIds.add(stream.chatSessionId);
				}
			}
		}

		// Count unread sessions (excluding current session and already-streaming ones)
		let unreadCount = 0;
		for (const [sessionId] of unreadSessions) {
			if (sessionId !== currentSessionId && !streamingSessionIds.has(sessionId)) {
				unreadCount++;
			}
		}

		const totalCount = streamingSessionIds.size + unreadCount;
		updateTitleBadge(totalCount);
	});
</script>

<!-- Loading Screen -->
<LoadingScreen bind:isVisible={appState.isAppLoading} progress={loadingProgress} {loadingText} />

<!-- Main Workspace Layout -->
<div
	class="h-full w-full overflow-hidden {isMobile ? 'bg-white/90 dark:bg-slate-900/98' : 'bg-slate-50 dark:bg-slate-900/70'} text-slate-900 dark:text-slate-100 font-sans"
>
	{#if isMobile}
		<!-- Mobile Layout -->
		<div class="flex flex-col h-full w-full" in:fade={{ duration: 200 }}>
			<MobileLayout />
		</div>
	{:else}
		<!-- Desktop Layout -->
		<DesktopLayout />
	{/if}
</div>

<!-- Modal Provider -->
<ModalProvider />

<!-- Settings Modal -->
<SettingsModal />

<!-- Toast Notifications -->
{#if notificationStore.notifications.length > 0}
	<div class="fixed top-4 right-4 z-[200] flex flex-col gap-2">
		{#each notificationStore.notifications as notification (notification.id)}
			<NotificationToast {notification} />
		{/each}
	</div>
{/if}
