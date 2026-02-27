<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { fade } from 'svelte/transition';
	import { browser } from '$frontend/lib/app-environment';

	// Stores
	import {
		workspaceState,
		initializeWorkspace,
	} from '$frontend/lib/stores/ui/workspace.svelte';
	import { appState, setAppLoading, setAppInitialized, restoreLastView } from '$frontend/lib/stores/core/app.svelte';
	import { projectState } from '$frontend/lib/stores/core/projects.svelte';
	import { sessionState } from '$frontend/lib/stores/core/sessions.svelte';

	// Components
	import DesktopLayout from './layout/DesktopLayout.svelte';
	import MobileLayout from './layout/MobileLayout.svelte';
	import LoadingScreen from '$frontend/lib/components/common/LoadingScreen.svelte';
	import ModalProvider from '$frontend/lib/components/common/ModalProvider.svelte';
	import SettingsModal from '$frontend/lib/components/settings/SettingsModal.svelte';
	import HistoryModal from '$frontend/lib/components/history/HistoryModal.svelte';

	// Services
	import { initializeTheme } from '$frontend/lib/utils/theme';
	import { initializeStore } from '$frontend/lib/stores/core/app.svelte';
	import { initializeProjects } from '$frontend/lib/stores/core/projects.svelte';
	import { initializeSessions } from '$frontend/lib/stores/core/sessions.svelte';
	import { initializeNotifications } from '$frontend/lib/stores/ui/notification.svelte';
	import { applyServerSettings } from '$frontend/lib/stores/features/settings.svelte';
	import { userStore } from '$frontend/lib/stores/features/user.svelte';
	import { initPresence } from '$frontend/lib/stores/core/presence.svelte';
	import ws from '$frontend/lib/utils/ws';
	import { debug } from '$shared/utils/logger';

	const { children } = $props();

	// Responsive state
	let isMobile = $state(false);
	let windowWidth = $state(0);

	// Chat History modal state
	let showHistoryModal = $state(false);

	function closeHistoryModal() {
		showHistoryModal = false;
	}

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

			// Step 2: Initialize user + wait for WebSocket in parallel
			// userStore.initialize() reads localStorage (fast) and sets WS context locally.
			// waitUntilConnected() waits for WS to connect and sync any pending context.
			setProgress(20, 'Connecting...');
			await Promise.all([
				userStore.initialize(),
				ws.waitUntilConnected(10000)
			]);

			// Step 3: Restore user state from server
			setProgress(30, 'Restoring state...');
			let serverState: { currentProjectId: string | null; lastView: string | null; settings: any } | null = null;
			try {
				serverState = await ws.http('user:restore-state', {});
				debug.log('workspace', 'Server state restored:', serverState);
			} catch (err) {
				debug.warn('workspace', 'Failed to restore server state, using defaults:', err);
			}

			// Step 4: Apply restored state + setup presence (sync operations)
			setProgress(40);
			if (serverState?.settings) {
				applyServerSettings(serverState.settings);
			}
			restoreLastView(serverState?.lastView);
			initPresence();

			// Step 5: Load projects (with server-restored currentProjectId)
			setProgress(50, 'Loading projects...');
			await initializeProjects(serverState?.currentProjectId);

			// Step 6: Load sessions
			setProgress(70, 'Restoring sessions...');
			await initializeSessions();

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
</script>

<!-- Loading Screen -->
<LoadingScreen bind:isVisible={appState.isAppLoading} progress={loadingProgress} {loadingText} />

<!-- Main Workspace Layout -->
<div
	class="h-screen w-screen overflow-hidden {isMobile ? 'bg-white/90 dark:bg-slate-900/98' : 'bg-slate-50 dark:bg-slate-900/70'} text-slate-900 dark:text-slate-100 font-sans"
>
	<!-- Skip link for accessibility -->
	<a
		href="#main-content"
		class="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-violet-600 focus:text-white"
	>
		Skip to main content
	</a>

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

<!-- History Modal -->
<HistoryModal bind:isOpen={showHistoryModal} onClose={closeHistoryModal} />
