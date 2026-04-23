<script lang="ts">
	import { browser } from '$frontend/app-environment';
	import { onMount, onDestroy } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import AvatarBubble from '$frontend/components/common/display/AvatarBubble.svelte';
	import { sessionState } from '$frontend/stores/core/sessions.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { presenceState } from '$frontend/stores/core/presence.svelte';
	import { userStore } from '$frontend/stores/features/user.svelte';
	import {
		workspaceState,
		type PanelId,
		swapPanel,
		splitPanel,
		closePanel,
		canClosePanel,
		setActiveMobilePanel,
		PANEL_OPTIONS
	} from '$frontend/stores/ui/workspace.svelte';
	import type { DeviceSize } from '$frontend/utils/preview-constants';

	import { DEVICE_VIEWPORTS } from '$frontend/utils/preview-constants';
	import ContextIndicator from '$frontend/components/chat/widgets/ContextIndicator.svelte';

	interface Props {
		panelId: PanelId;
		chatPanelRef?: any;
		filesPanelRef?: any;
		terminalPanelRef?: any;
		previewPanelRef?: any;
		gitPanelRef?: any;
		onHistoryOpen?: () => void;
	}

	const {
		panelId,
		chatPanelRef,
		filesPanelRef,
		terminalPanelRef,
		previewPanelRef,
		gitPanelRef,
		onHistoryOpen
	}: Props = $props();

	// Mobile detection
	let isMobile = $state(false);

	// Touchscreen detection
	let isTouchDevice = $state(false);

	// Chat session users (other users in the same chat session, excluding self)
	const chatSessionUsers = $derived.by(() => {
		if (panelId !== 'chat') return [];
		const projectId = projectState.currentProject?.id;
		const chatSessionId = sessionState.currentSession?.id;
		const currentUserId = userStore.currentUser?.id;
		if (!projectId || !chatSessionId) return [];
		const status = presenceState.statuses.get(projectId);
		if (!status?.chatSessionUsers) return [];
		const users = status.chatSessionUsers[chatSessionId] || [];
		return currentUserId ? users.filter(u => u.userId !== currentUserId) : users;
	});

	// Chat session users popover
	let showChatUsersPopover = $state(false);
	let chatUsersContainer = $state<HTMLDivElement | null>(null);

	function toggleChatUsersPopover(e: MouseEvent) {
		e.stopPropagation();
		showChatUsersPopover = !showChatUsersPopover;
	}

	$effect(() => {
		if (showChatUsersPopover) {
			const handleClickOutside = (e: MouseEvent) => {
				if (chatUsersContainer && !chatUsersContainer.contains(e.target as Node)) {
					showChatUsersPopover = false;
				}
			};
			document.addEventListener('click', handleClickOutside, true);
			return () => document.removeEventListener('click', handleClickOutside, true);
		}
	});

	// Panel actions menu state
	let showActionsMenu = $state(false);
	let actionsButtonRef = $state<HTMLButtonElement | null>(null);
	let menuPosition = $state({ top: 0, left: 0 });

	function toggleActionsMenu(e: MouseEvent) {
		e.stopPropagation();
		if (!showActionsMenu && actionsButtonRef) {
			const rect = actionsButtonRef.getBoundingClientRect();
			menuPosition = { top: rect.bottom + 4, left: rect.left };
		}
		showActionsMenu = !showActionsMenu;
	}

	function closeActionsMenu() {
		showActionsMenu = false;
	}

	function handleSwitch(targetId: PanelId) {
		if (targetId === panelId) return;
		if (isMobile) {
			setActiveMobilePanel(targetId);
		} else {
			swapPanel(panelId, targetId);
		}
	}

	function handleSplit(direction: 'vertical' | 'horizontal') {
		splitPanel(panelId, direction);
		closeActionsMenu();
	}

	function handleClose() {
		closePanel(panelId);
		closeActionsMenu();
	}

	// Preview panel device dropdown state
	let showDeviceDropdown = $state(false);

	// Git remote dropdown state
	let showRemoteDropdown = $state(false);

	function toggleDeviceDropdown() {
		showDeviceDropdown = !showDeviceDropdown;
	}

	function closeDeviceDropdown() {
		showDeviceDropdown = false;
	}

	function selectDevice(size: DeviceSize) {
		previewPanelRef?.panelActions?.setDeviceSize(size);
		closeDeviceDropdown();
	}

	function handleResize() {
		if (browser) {
			isMobile = window.innerWidth < 1024;
		}
	}

	onMount(() => {
		handleResize();
		if (browser) {
			isTouchDevice = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
			window.addEventListener('resize', handleResize);
		}
	});

	onDestroy(() => {
		if (browser) {
			window.removeEventListener('resize', handleResize);
		}
	});
</script>

<header
	class="flex items-center justify-between shrink-0 {isMobile
		? 'h-11 pb-2 px-4 bg-white/90 dark:bg-slate-900/98 border-b border-slate-200 dark:border-slate-800'
		: 'py-1 px-3.5 bg-slate-100 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-800'}"
>
	<div class="flex items-center text-sm font-medium text-slate-900 dark:text-slate-100">
		<div
			class="flex gap-1"
			role="tablist"
			aria-label="Switch panel"
		>
			{#if !isMobile}
				<button
					bind:this={actionsButtonRef}
					type="button"
					class="flex items-center justify-center w-7 h-7 bg-transparent border-none rounded-md text-slate-400 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-700 dark:hover:text-slate-200"
					onclick={toggleActionsMenu}
					title="Panel actions"
				>
					<Icon name="lucide:ellipsis-vertical" class="w-4 h-4" />
				</button>
			{/if}
			{#each PANEL_OPTIONS as option}
				<button
					type="button"
					class="flex items-center justify-center {isMobile ? 'w-10 h-9' : 'w-7 h-7'} bg-transparent border-none rounded-md cursor-pointer transition-all duration-150
						{option.id === panelId
						? 'bg-violet-500/10 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400'
						: 'text-slate-500 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100'}"
					role="tab"
					aria-selected={option.id === panelId}
					aria-label={option.title}
					title={option.title}
					onclick={() => handleSwitch(option.id)}
				>
					<Icon name={option.icon} class={isMobile ? 'w-5.5 h-5.5' : 'w-4 h-4'} />
				</button>
			{/each}
		</div>

		{#if showActionsMenu}
			<div class="fixed inset-0 z-40" onclick={closeActionsMenu}></div>
			<div class="fixed z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg overflow-hidden min-w-44 py-1" style="top: {menuPosition.top}px; left: {menuPosition.left}px;">
				<!-- Split actions -->
				<button
					type="button"
					class="flex items-center gap-2.5 w-full px-3 py-1.5 text-left text-xs bg-transparent border-none cursor-pointer transition-all duration-150 hover:bg-violet-500/10 text-slate-700 dark:text-slate-300"
					onclick={() => handleSplit('vertical')}
				>
					<Icon name="lucide:columns-2" class="w-3.5 h-3.5" />
					<span>Split Right</span>
				</button>
				<button
					type="button"
					class="flex items-center gap-2.5 w-full px-3 py-1.5 text-left text-xs bg-transparent border-none cursor-pointer transition-all duration-150 hover:bg-violet-500/10 text-slate-700 dark:text-slate-300"
					onclick={() => handleSplit('horizontal')}
				>
					<Icon name="lucide:rows-2" class="w-3.5 h-3.5" />
					<span>Split Down</span>
				</button>

				<!-- Divider -->
				<div class="my-1 border-t border-slate-200 dark:border-slate-700"></div>

				<!-- Close -->
				<button
					type="button"
					class="flex items-center gap-2.5 w-full px-3 py-1.5 text-left text-xs bg-transparent border-none cursor-pointer transition-all duration-150 hover:bg-red-500/10 text-red-600 dark:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed"
					onclick={handleClose}
					disabled={!canClosePanel()}
					title={!canClosePanel() ? 'Cannot close last panel' : 'Close this panel'}
				>
					<Icon name="lucide:x" class="w-3.5 h-3.5" />
					<span>Close Panel</span>
				</button>
			</div>
		{/if}
	</div>

	<div class="flex items-center">
		<!-- Panel-specific actions -->
		<div class="flex items-center gap-1.5">
			{#if panelId === 'chat'}
				{#if sessionState.messages.length > 0 || sessionState.hasMessageHistory}
					<ContextIndicator {isMobile} />
				{/if}
				{#if chatSessionUsers.length > 0}
					<div class="relative" bind:this={chatUsersContainer}>
					<div class="flex items-center -space-x-1.5 mr-1 cursor-pointer" title="Users in this session" onclick={toggleChatUsersPopover}>
						{#each chatSessionUsers.slice(0, 3) as user}
							<AvatarBubble {user} size="sm" />
						{/each}
						{#if chatSessionUsers.length > 3}
							<span class="w-5 h-5 rounded-full bg-gradient-to-br from-slate-500 to-slate-600 dark:from-slate-600 dark:to-slate-700 text-white text-4xs font-bold flex items-center justify-center border-2 border-white dark:border-slate-800 z-10">
								+{chatSessionUsers.length - 3}
							</span>
						{/if}
					</div>
					{#if showChatUsersPopover}
						<div class="absolute top-full right-0 mt-2 py-2 px-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-50 min-w-[160px]">
							<div class="px-2 pb-1.5 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">
								In this session ({chatSessionUsers.length})
							</div>
							{#each chatSessionUsers as user}
								<div class="flex items-center gap-2 px-2 py-1.5 rounded-md">
									<AvatarBubble {user} size="sm" showName={true} />
								</div>
							{/each}
						</div>
					{/if}
				</div>
				{/if}
				<button
					type="button"
					class="flex items-center justify-center {isMobile ? 'w-9 h-9' : 'w-6 h-6'} bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={onHistoryOpen}
					title="Switch Session"
				>
					<Icon name="lucide:history" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
				</button>
					{#if sessionState.messages.length > 0 || sessionState.hasMessageHistory}
					<button
						type="button"
						class="flex items-center justify-center {isMobile ? 'w-9 h-9' : 'w-6 h-6'} bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
						onclick={() => chatPanelRef?.panelActions?.checkpoints()}
						title="Restore Checkpoint"
					>
						<Icon name="lucide:undo-2" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
					</button>
				{/if}
				<button
					type="button"
					class="flex items-center justify-center {isMobile ? 'w-9 h-9' : 'w-6 h-6'} bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={() => chatPanelRef?.panelActions?.newChat()}
					title="New Chat"
				>
					<Icon name="lucide:plus" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
				</button>
			{:else if panelId === 'files'}
				<!-- Hide view mode toggles when in two-column mode -->
				{#if !filesPanelRef?.panelActions?.isTwoColumnMode()}
					<div class="flex gap-1 bg-slate-100/80 dark:bg-slate-800/50 rounded-md">
						<button
							type="button"
							class="flex items-center justify-center {isMobile ? 'w-9 h-9' : 'w-6 h-6'} bg-transparent border-none rounded text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-40 disabled:cursor-not-allowed
								{filesPanelRef?.panelActions?.getViewMode() === 'tree'
								? 'bg-violet-500/15 dark:bg-violet-500/25 text-violet-600'
								: ''}"
							onclick={() => filesPanelRef?.panelActions?.setViewMode('tree')}
							title="Tree View"
						>
							<Icon name="lucide:folder-tree" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
						</button>
						<button
							type="button"
							class="flex items-center justify-center {isMobile ? 'w-9 h-9' : 'w-6 h-6'} bg-transparent border-none rounded text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-40 disabled:cursor-not-allowed
								{filesPanelRef?.panelActions?.getViewMode() === 'viewer'
								? 'bg-violet-500/15 dark:bg-violet-500/25 text-violet-600'
								: ''}"
							onclick={() => filesPanelRef?.panelActions?.setViewMode('viewer')}
							disabled={!filesPanelRef?.panelActions?.canShowViewer()}
							title="File Viewer"
						>
							<Icon name="lucide:file-code" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
						</button>
					</div>
				{/if}
			{:else if panelId === 'terminal'}
				<button
					type="button"
					class="flex items-center justify-center {isMobile ? 'w-9 h-9' : 'w-6 h-6'} bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={() => terminalPanelRef?.panelActions?.handleClear()}
					title="Clear Terminal"
				>
					<Icon name="lucide:trash-2" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
				</button>
				<button
					type="button"
					class="flex items-center justify-center {isMobile ? 'w-9 h-9' : 'w-6 h-6'} bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-all duration-150 hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50 disabled:cursor-not-allowed"
					onclick={() => terminalPanelRef?.panelActions?.handleCancel()}
					disabled={terminalPanelRef?.panelActions?.isCancelling()}
					title="{isMobile ? 'Cancel Command (Ctrl+C)' : 'Send Ctrl+C Signal'}"
				>
					{#if terminalPanelRef?.panelActions?.isCancelling()}
						<div
							class="{isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} border-2 border-red-500/20 border-t-red-600 rounded-full animate-spin"
						></div>
					{:else}
						<Icon name="lucide:square" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
					{/if}
				</button>
			{:else if panelId === 'preview'}
				<!-- Connection status indicator -->
				<!-- {@const sessionInfo = previewPanelRef?.panelActions?.getSessionInfo()}
				{@const isStreamReady = previewPanelRef?.panelActions?.getIsStreamReady()}
				{@const errorMessage = previewPanelRef?.panelActions?.getErrorMessage()}
				{@const url = previewPanelRef?.panelActions?.getUrl()}

				{#if url}
					<div class="flex items-center gap-1.5 {isMobile ? 'px-2 h-9' : 'px-2 h-6'} rounded-md">
						<div class="relative">
							{#if !sessionInfo}
								<span class="w-2 h-2 rounded-full block bg-amber-400"></span>
							{:else if errorMessage}
								<span class="w-2 h-2 rounded-full block bg-red-500"></span>
							{:else if isStreamReady}
								<span class="w-2 h-2 rounded-full block bg-emerald-500"></span>
								<span class="absolute inset-0 w-2 h-2 bg-emerald-500 rounded-full animate-ping opacity-75"></span>
							{:else}
								<span class="w-2 h-2 rounded-full block bg-blue-400 animate-pulse"></span>
							{/if}
						</div>
						<span class="text-xs font-medium {
							!sessionInfo ? 'text-amber-600 dark:text-amber-400' :
							errorMessage ? 'text-red-600 dark:text-red-400' :
							isStreamReady ? 'text-emerald-600 dark:text-emerald-400' :
							'text-blue-600 dark:text-blue-400'
						}">
							{!sessionInfo ? 'Ready' : errorMessage ? 'Offline' : isStreamReady ? 'Online' : 'Connecting'}
						</span>
					</div>
				{/if} -->

				<!-- Device size dropdown -->
				<div class="relative">
					<button
						type="button"
						class="flex items-center justify-center gap-1.5 {isMobile ? 'px-2 h-9' : 'px-1 h-6'} bg-transparent border-none rounded-md transition-all duration-150 {previewPanelRef?.panelActions?.getIsMcpControlled() ? 'text-slate-400 dark:text-slate-600 cursor-not-allowed opacity-50' : 'text-slate-500 cursor-pointer hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100'}"
						onclick={previewPanelRef?.panelActions?.getIsMcpControlled() ? undefined : toggleDeviceDropdown}
						disabled={previewPanelRef?.panelActions?.getIsMcpControlled()}
						title={previewPanelRef?.panelActions?.getIsMcpControlled() ? 'Controlled by MCP agent' : 'Select device size'}
					>
						{#if previewPanelRef?.panelActions?.getDeviceSize() === 'desktop'}
							<Icon name="lucide:monitor" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
							<span class="text-xs font-medium">Desktop</span>
						{:else if previewPanelRef?.panelActions?.getDeviceSize() === 'laptop'}
							<Icon name="lucide:laptop" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
							<span class="text-xs font-medium">Laptop</span>
						{:else if previewPanelRef?.panelActions?.getDeviceSize() === 'tablet'}
							<Icon name="lucide:tablet" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
							<span class="text-xs font-medium">Tablet</span>
						{:else}
							<Icon name="lucide:smartphone" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
							<span class="text-xs font-medium">Mobile</span>
						{/if}
						<Icon name="lucide:chevron-down" class={isMobile ? 'w-3.5 h-3.5' : 'w-3 h-3'} />
					</button>

					<!-- Dropdown menu -->
					{#if showDeviceDropdown}
						<div
							class="fixed inset-0 z-40"
							onclick={closeDeviceDropdown}
						></div>
						<div class="absolute top-full right-0 mt-1 z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg overflow-hidden {isMobile ? 'min-w-44' : 'min-w-40'}">
							<button
								type="button"
								class="flex items-center gap-2.5 w-full px-3 {isMobile ? 'py-2.5' : 'py-2'} text-left text-sm bg-transparent border-none cursor-pointer transition-all duration-150 hover:bg-violet-500/10 {previewPanelRef?.panelActions?.getDeviceSize() === 'desktop' ? 'bg-violet-500/5 text-violet-600' : 'text-slate-700 dark:text-slate-300'}"
								onclick={() => selectDevice('desktop')}
							>
								<Icon name="lucide:monitor" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
								<div class="flex-1">
									<div class="font-medium">Desktop</div>
									<div class="text-xs text-slate-500 dark:text-slate-400">
										{DEVICE_VIEWPORTS.desktop.width}×{DEVICE_VIEWPORTS.desktop.height}
									</div>
								</div>
								{#if previewPanelRef?.panelActions?.getDeviceSize() === 'desktop'}
									<Icon name="lucide:check" class="{isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} text-violet-600" />
								{/if}
							</button>
							<button
								type="button"
								class="flex items-center gap-2.5 w-full px-3 {isMobile ? 'py-2.5' : 'py-2'} text-left text-sm bg-transparent border-none cursor-pointer transition-all duration-150 hover:bg-violet-500/10 {previewPanelRef?.panelActions?.getDeviceSize() === 'laptop' ? 'bg-violet-500/5 text-violet-600' : 'text-slate-700 dark:text-slate-300'}"
								onclick={() => selectDevice('laptop')}
							>
								<Icon name="lucide:laptop" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
								<div class="flex-1">
									<div class="font-medium">Laptop</div>
									<div class="text-xs text-slate-500 dark:text-slate-400">
										{DEVICE_VIEWPORTS.laptop.width}×{DEVICE_VIEWPORTS.laptop.height}
									</div>
								</div>
								{#if previewPanelRef?.panelActions?.getDeviceSize() === 'laptop'}
									<Icon name="lucide:check" class="{isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} text-violet-600" />
								{/if}
							</button>
							<button
								type="button"
								class="flex items-center gap-2.5 w-full px-3 {isMobile ? 'py-2.5' : 'py-2'} text-left text-sm bg-transparent border-none cursor-pointer transition-all duration-150 hover:bg-violet-500/10 {previewPanelRef?.panelActions?.getDeviceSize() === 'tablet' ? 'bg-violet-500/5 text-violet-600' : 'text-slate-700 dark:text-slate-300'}"
								onclick={() => selectDevice('tablet')}
							>
								<Icon name="lucide:tablet" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
								<div class="flex-1">
									<div class="font-medium">Tablet</div>
									<div class="text-xs text-slate-500 dark:text-slate-400">
										{DEVICE_VIEWPORTS.tablet.width}×{DEVICE_VIEWPORTS.tablet.height}
									</div>
								</div>
								{#if previewPanelRef?.panelActions?.getDeviceSize() === 'tablet'}
									<Icon name="lucide:check" class="{isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} text-violet-600" />
								{/if}
							</button>
							<button
								type="button"
								class="flex items-center gap-2.5 w-full px-3 {isMobile ? 'py-2.5' : 'py-2'} text-left text-sm bg-transparent border-none cursor-pointer transition-all duration-150 hover:bg-violet-500/10 {previewPanelRef?.panelActions?.getDeviceSize() === 'mobile' ? 'bg-violet-500/5 text-violet-600' : 'text-slate-700 dark:text-slate-300'}"
								onclick={() => selectDevice('mobile')}
							>
								<Icon name="lucide:smartphone" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
								<div class="flex-1">
									<div class="font-medium">Mobile</div>
									<div class="text-xs text-slate-500 dark:text-slate-400">
										{DEVICE_VIEWPORTS.mobile.width}×{DEVICE_VIEWPORTS.mobile.height}
									</div>
								</div>
								{#if previewPanelRef?.panelActions?.getDeviceSize() === 'mobile'}
									<Icon name="lucide:check" class="{isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} text-violet-600" />
								{/if}
							</button>
						</div>
					{/if}
				</div>

				<!-- Touch mode toggle (scroll ↔ trackpad cursor) — only shown on touchscreen devices -->
				{#if isTouchDevice}
					<button
						type="button"
						class="flex items-center justify-center gap-1.5 {isMobile ? 'px-2 h-9' : 'px-1 h-6'} bg-transparent border-none rounded-md cursor-pointer transition-all duration-150 hover:bg-violet-500/10
							{previewPanelRef?.panelActions?.getTouchMode() === 'cursor' ? 'text-violet-600 dark:text-violet-400' : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-100'}"
						onclick={() => {
							const current = previewPanelRef?.panelActions?.getTouchMode() || 'scroll';
							previewPanelRef?.panelActions?.setTouchMode(current === 'scroll' ? 'cursor' : 'scroll');
						}}
						title={previewPanelRef?.panelActions?.getTouchMode() === 'cursor' ? 'Trackpad mode: 1-finger moves cursor, tap=click, 2-finger scroll/right-click' : 'Scroll mode: touch scrolls the page (tap to click)'}
					>
						<Icon name={previewPanelRef?.panelActions?.getTouchMode() === 'cursor' ? 'lucide:mouse-pointer-2' : 'lucide:pointer'} class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
						<span class="text-xs font-medium">{previewPanelRef?.panelActions?.getTouchMode() === 'cursor' ? 'Cursor' : 'Touch'}</span>
					</button>
				{/if}

				<!-- Rotation toggle -->
				<button
					type="button"
					class="flex items-center justify-center gap-1.5 {isMobile ? 'px-2 h-9' : 'px-1 h-6'} bg-transparent border-none rounded-md transition-all duration-150 {previewPanelRef?.panelActions?.getIsMcpControlled() ? 'text-slate-400 dark:text-slate-600 cursor-not-allowed opacity-50' : 'text-slate-500 cursor-pointer hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100'}"
					onclick={previewPanelRef?.panelActions?.getIsMcpControlled() ? undefined : () => previewPanelRef?.panelActions?.toggleRotation()}
					disabled={previewPanelRef?.panelActions?.getIsMcpControlled()}
					title={previewPanelRef?.panelActions?.getIsMcpControlled() ? 'Controlled by MCP agent' : 'Toggle orientation'}
				>
					<Icon name="lucide:rotate-cw" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
					<span class="text-xs font-medium">
						{previewPanelRef?.panelActions?.getRotation() === 'portrait' ? 'Portrait' : 'Landscape'}
					</span>
				</button>

				<!-- Scale info badge -->
				<div class="flex items-center gap-1.5 {isMobile ? 'px-1 h-9 bg-transparent' : 'px-1 h-6 bg-slate-100/60 dark:bg-slate-800/40'} rounded-md text-xs font-medium text-slate-500">
					<Icon name="lucide:move-diagonal" class={isMobile ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
					<span>{Math.round((previewPanelRef?.panelActions?.getScale() || 1) * 100)}%</span>
				</div>
			{:else if panelId === 'git'}
				<!-- View mode toggles (only in single-column mode, like Files panel) -->
				{#if !gitPanelRef?.panelActions?.isTwoColumnMode()}
					<div class="flex gap-1 bg-slate-100/80 dark:bg-slate-800/50 rounded-md">
						<button
							type="button"
							class="flex items-center justify-center {isMobile ? 'w-9 h-9' : 'w-6 h-6'} bg-transparent border-none rounded text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100
								{gitPanelRef?.panelActions?.getViewMode() === 'list'
								? 'bg-violet-500/15 dark:bg-violet-500/25 text-violet-600'
								: ''}"
							onclick={() => gitPanelRef?.panelActions?.setViewMode('list')}
							title="Changes List"
						>
							<Icon name="lucide:list" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
						</button>
						<button
							type="button"
							class="flex items-center justify-center {isMobile ? 'w-9 h-9' : 'w-6 h-6'} bg-transparent border-none rounded text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-40 disabled:cursor-not-allowed
								{gitPanelRef?.panelActions?.getViewMode() === 'diff'
								? 'bg-violet-500/15 dark:bg-violet-500/25 text-violet-600'
								: ''}"
							onclick={() => gitPanelRef?.panelActions?.setViewMode('diff')}
							disabled={!gitPanelRef?.panelActions?.canShowDiff()}
							title="Diff Viewer"
						>
							<Icon name="lucide:file-diff" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
						</button>
					</div>
				{/if}

				<!-- Branch switch button -->
				{#if gitPanelRef?.panelActions?.getIsRepo()}
					{@const branchInfo = gitPanelRef?.panelActions?.getBranchInfo()}
					<button
						type="button"
						class="flex items-center gap-1 {isMobile ? 'h-9 px-2' : 'h-6 px-1.5'} bg-slate-100 dark:bg-slate-800/60 border-none rounded-md text-slate-700 dark:text-slate-300 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400"
						onclick={() => gitPanelRef?.panelActions?.openBranchManager()}
						title="Switch Branch"
					>
						<Icon name="lucide:git-branch" class={isMobile ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
						<span class="text-xs font-medium truncate max-w-24">{branchInfo?.current || '...'}</span>
					</button>
				{/if}
				
				{@const hasRemotes = gitPanelRef?.panelActions?.getHasRemotes()}
				{@const remoteName = gitPanelRef?.panelActions?.getSelectedRemote() || 'origin'}
				{@const gitRemotes = gitPanelRef?.panelActions?.getRemotes() || []}

				<!-- Remote selector -->
				{#if hasRemotes && gitRemotes.length > 1}
					<div class="relative">
						<button
							type="button"
							class="flex items-center gap-1 {isMobile ? 'h-9 px-2' : 'h-6 px-1.5'} bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
							onclick={() => showRemoteDropdown = !showRemoteDropdown}
							title="Select remote"
						>
							<Icon name="lucide:globe" class={isMobile ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
							<span class="text-xs font-medium">{remoteName}</span>
							{#if gitRemotes.length > 1}
								<Icon name="lucide:chevron-down" class="w-3 h-3" />
							{/if}
						</button>

						{#if showRemoteDropdown && gitRemotes.length > 1}
							<div class="fixed inset-0 z-40" onclick={() => showRemoteDropdown = false}></div>
							<div class="absolute top-full right-0 mt-1 z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg overflow-hidden min-w-36">
								{#each gitRemotes as remote (remote.name)}
									<button
										type="button"
										class="flex items-center gap-2 w-full px-3 py-2 text-left text-xs bg-transparent border-none cursor-pointer transition-all duration-150 hover:bg-violet-500/10
											{remote.name === remoteName ? 'text-violet-600 font-medium' : 'text-slate-700 dark:text-slate-300'}"
										onclick={() => { gitPanelRef?.panelActions?.setSelectedRemote(remote.name); showRemoteDropdown = false; }}
									>
										<Icon name="lucide:globe" class="w-3.5 h-3.5 shrink-0" />
										<div class="flex-1 min-w-0">
											<div>{remote.name}</div>
											<div class="text-3xs text-slate-400 truncate font-mono">{remote.fetchUrl}</div>
										</div>
										{#if remote.name === remoteName}
											<Icon name="lucide:check" class="w-3.5 h-3.5 text-violet-600 shrink-0" />
										{/if}
									</button>
								{/each}
							</div>
						{/if}
					</div>
				{/if}

			{/if}
		</div>

	</div>
</header>
