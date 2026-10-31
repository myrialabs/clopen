<script lang="ts">
	import { browser } from '$frontend/app-environment';
	import { onMount, onDestroy } from 'svelte';
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { sessionState } from '$frontend/stores/core/sessions.svelte';
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
	import type { IconName } from '$shared/types/ui/icons';

	import {
		DEVICE_PRESETS,
		PREVIEW_ZOOM_LEVELS,
		canRotate,
		getDevicePreset,
		type DevicePreset,
		type PreviewZoom
	} from '$frontend/utils/preview-constants';
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

	// Track current branch name reactively
	const currentBranch = $derived(gitPanelRef?.panelActions?.getBranchInfo()?.current || '...');

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

	/** A model keeps the tab's orientation within its class, and stands up or lies down by nature across classes. */
	function selectPreset(preset: DevicePreset) {
		previewPanelRef?.panelActions?.selectDeviceModel(preset.deviceSize, preset.id);
		closeDeviceDropdown();
	}

	const DEVICE_GROUPS: Array<{ size: Exclude<DeviceSize, 'responsive'>; label: string; icon: IconName }> = [
		{ size: 'desktop', label: 'Desktop', icon: 'lucide:monitor' },
		{ size: 'laptop', label: 'Laptop', icon: 'lucide:laptop' },
		{ size: 'tablet', label: 'Tablet', icon: 'lucide:tablet' },
		{ size: 'mobile', label: 'Mobile', icon: 'lucide:smartphone' }
	];

	function zoomLabel(zoom: PreviewZoom): string {
		return zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`;
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
	class="@container flex items-center justify-between shrink-0 {isMobile
		? 'h-11 pb-2 px-4 bg-white/90 dark:bg-slate-900/98 border-b border-slate-200 dark:border-slate-800'
		: 'py-1 px-3.5 bg-slate-100 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-800'}"
>
	<div class="flex items-center text-sm font-medium text-slate-900 dark:text-slate-100">
		<div
			class="flex {isMobile ? 'gap-0.5' : 'gap-1'}"
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
					class="flex items-center justify-center {isMobile ? 'w-9 h-8' : 'w-7 h-7'} bg-transparent border-none rounded-md cursor-pointer transition-all duration-150
						{option.id === panelId
						? 'bg-violet-500/10 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400'
						: 'text-slate-500 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100'}"
					role="tab"
					aria-selected={option.id === panelId}
					aria-label={option.title}
					title={option.title}
					onclick={() => handleSwitch(option.id)}
				>
					<Icon name={option.icon} class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
				</button>
			{/each}
		</div>


		{#if showActionsMenu}
			<div class="fixed inset-0 z-40" onclick={closeActionsMenu}></div>
			<div
				class="fixed z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg overflow-hidden min-w-44 py-1"
				style="top: {menuPosition.top}px; left: {menuPosition.left}px;"
				transition:scale={{ duration: 150, easing: cubicOut, start: 0.95, opacity: 0 }}
			>
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
		<div class="flex items-center {isMobile ? 'gap-0.5' : 'gap-1.5'}">
			{#if panelId === 'chat'}
				{#if sessionState.messages.length > 0 || sessionState.hasMessageHistory}
					<ContextIndicator {isMobile} />
				{/if}
				<button
					type="button"
					class="flex items-center justify-center {isMobile ? 'w-9 h-8' : 'w-6 h-6'} bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={onHistoryOpen}
					title="Switch Session"
				>
					<Icon name="lucide:history" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
				</button>
					{#if sessionState.messages.length > 0 || sessionState.hasMessageHistory}
					<button
						type="button"
						class="flex items-center justify-center {isMobile ? 'w-9 h-8' : 'w-6 h-6'} bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
						onclick={() => chatPanelRef?.panelActions?.checkpoints()}
						title="Restore Checkpoint"
					>
						<Icon name="lucide:undo-2" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
					</button>
				{/if}
				<button
					type="button"
					class="flex items-center justify-center {isMobile ? 'w-9 h-8' : 'w-6 h-6'} bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={() => chatPanelRef?.panelActions?.newIsolatedChat()}
					title="New Isolated Chat"
				>
					<Icon name="lucide:git-fork" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
				</button>
				<button
					type="button"
					class="flex items-center justify-center {isMobile ? 'w-9 h-8' : 'w-6 h-6'} bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
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
							class="flex items-center justify-center {isMobile ? 'w-9 h-8' : 'w-6 h-6'} bg-transparent border-none rounded text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-40 disabled:cursor-not-allowed
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
							class="flex items-center justify-center {isMobile ? 'w-9 h-8' : 'w-6 h-6'} bg-transparent border-none rounded text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-40 disabled:cursor-not-allowed
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
					class="flex items-center justify-center {isMobile ? 'w-9 h-8' : 'w-6 h-6'} bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={() => terminalPanelRef?.panelActions?.handleClear()}
					title="Clear Terminal"
				>
					<Icon name="lucide:trash-2" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
				</button>
				<button
					type="button"
					class="flex items-center justify-center {isMobile ? 'w-9 h-8' : 'w-6 h-6'} bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-all duration-150 hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50 disabled:cursor-not-allowed"
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
				{@const currentDevice = previewPanelRef?.panelActions?.getDeviceSize()}
				{@const currentViewport = previewPanelRef?.panelActions?.getViewport()}
				{@const currentPreset = getDevicePreset(previewPanelRef?.panelActions?.getDeviceModel())}
				{@const deviceLabel = currentDevice === 'responsive' ? 'Responsive' : (currentPreset?.label ?? DEVICE_GROUPS.find((g) => g.size === currentDevice)?.label ?? 'Laptop')}
				{@const deviceIcon = currentDevice === 'responsive' ? 'lucide:scaling' : (DEVICE_GROUPS.find((g) => g.size === currentDevice)?.icon ?? 'lucide:laptop')}
				{@const mcpLocked = previewPanelRef?.panelActions?.getIsMcpControlled()}
				{@const showFrame = previewPanelRef?.panelActions?.getShowFrame() ?? true}
				{@const zoom = previewPanelRef?.panelActions?.getZoom() ?? 'fit'}
				<div class="relative">
					<button
						type="button"
						class="flex items-center justify-center {isMobile ? 'w-9 h-8' : 'w-6 h-6'} bg-transparent border-none rounded-md transition-all duration-150 text-slate-500 cursor-pointer hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
						onclick={toggleDeviceDropdown}
						title={`Device: ${deviceLabel}${currentViewport ? ` · ${currentViewport.width}×${currentViewport.height}` : ''}`}
					>
						<Icon name={deviceIcon as IconName} class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
					</button>

					<!-- Dropdown menu -->
					{#if showDeviceDropdown}
						<div
							class="fixed inset-0 z-40"
							onclick={closeDeviceDropdown}
						></div>
						<div class="absolute top-full right-0 mt-1 z-50 max-h-[70vh] overflow-y-auto bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg {isMobile ? 'min-w-60' : 'min-w-56'}">
							{#if mcpLocked}
								<div class="px-3 py-2 text-xs text-amber-600 dark:text-amber-400 border-b border-slate-200 dark:border-slate-700">
									Size is controlled by the agent right now.
								</div>
							{/if}

							{#each DEVICE_GROUPS as group (group.size)}
								<div class="px-3 pt-2 pb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
									<Icon name={group.icon} class="w-3.5 h-3.5" />
									{group.label}
								</div>
								{#each DEVICE_PRESETS.filter((preset) => preset.deviceSize === group.size) as preset (preset.id)}
									{@const active = currentPreset?.id === preset.id}
									<button
										type="button"
										disabled={mcpLocked}
										class="flex items-center gap-2 w-full px-3 {isMobile ? 'py-2' : 'py-1.5'} pl-8 text-left text-sm bg-transparent border-none transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50 enabled:cursor-pointer enabled:hover:bg-violet-500/10 {active ? 'bg-violet-500/5 text-violet-600' : 'text-slate-700 dark:text-slate-300'}"
										onclick={() => selectPreset(preset)}
									>
										<span class="flex-1">{preset.label}</span>
										<span class="text-xs tabular-nums text-slate-500 dark:text-slate-400">{preset.width}×{preset.height}</span>
										{#if active}
											<Icon name="lucide:check" class="w-3.5 h-3.5 text-violet-600" />
										{/if}
									</button>
								{/each}
							{/each}

							<div class="my-1 border-t border-slate-200 dark:border-slate-700"></div>
							<button
								type="button"
								disabled={mcpLocked}
								class="flex items-center gap-2.5 w-full px-3 {isMobile ? 'py-2.5' : 'py-2'} text-left text-sm bg-transparent border-none transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50 enabled:cursor-pointer enabled:hover:bg-violet-500/10 {currentDevice === 'responsive' ? 'bg-violet-500/5 text-violet-600' : 'text-slate-700 dark:text-slate-300'}"
								onclick={() => selectDevice('responsive')}
							>
								<Icon name="lucide:scaling" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
								<div class="flex-1">
									<div class="font-medium">Responsive</div>
									<div class="text-xs text-slate-500 dark:text-slate-400">Any size — drag or type it</div>
								</div>
								{#if currentDevice === 'responsive'}
									<Icon name="lucide:check" class="{isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} text-violet-600" />
								{/if}
							</button>

							<div class="my-1 border-t border-slate-200 dark:border-slate-700"></div>
							<button
								type="button"
								disabled={currentDevice === 'responsive'}
								class="flex items-center gap-2.5 w-full px-3 {isMobile ? 'py-2.5' : 'py-2'} text-left text-sm bg-transparent border-none text-slate-700 dark:text-slate-300 transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50 enabled:cursor-pointer enabled:hover:bg-violet-500/10"
								onclick={() => previewPanelRef?.panelActions?.setShowFrame(!showFrame)}
							>
								<Icon name="lucide:frame" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
								<span class="flex-1">Show device frame</span>
								<span
									class="relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors {showFrame && currentDevice !== 'responsive' ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-600'}"
								>
									<span
										class="absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all {showFrame && currentDevice !== 'responsive' ? 'left-3.5' : 'left-0.5'}"
									></span>
								</span>
							</button>
							<div class="flex items-center gap-2.5 px-3 {isMobile ? 'py-2.5' : 'py-2'} text-sm text-slate-700 dark:text-slate-300">
								<Icon name="lucide:zoom-in" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
								<span class="flex-1">Zoom</span>
								<div class="flex gap-0.5 rounded-md bg-slate-100 dark:bg-slate-900/60 p-0.5">
									{#each ['fit', ...PREVIEW_ZOOM_LEVELS] as level (level)}
										<button
											type="button"
											class="rounded px-1.5 py-0.5 text-xs tabular-nums transition-colors cursor-pointer {zoom === level ? 'bg-white dark:bg-slate-700 text-violet-600 dark:text-violet-400 shadow-sm' : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-100'}"
											onclick={() => previewPanelRef?.panelActions?.setZoom(level as PreviewZoom)}
										>
											{zoomLabel(level as PreviewZoom)}
										</button>
									{/each}
								</div>
							</div>
						</div>
					{/if}
				</div>

				<!-- Touch mode toggle (scroll ↔ trackpad cursor) — only shown on touchscreen devices -->
				{#if isTouchDevice}
					{@const touchMode = previewPanelRef?.panelActions?.getTouchMode()}
					<button
						type="button"
						class="flex items-center justify-center {isMobile ? 'w-9 h-8' : 'w-6 h-6'} bg-transparent border-none rounded-md cursor-pointer transition-all duration-150 hover:bg-violet-500/10
							{touchMode === 'cursor' ? 'text-violet-600 dark:text-violet-400' : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-100'}"
						onclick={() => {
							const current = touchMode || 'scroll';
							previewPanelRef?.panelActions?.setTouchMode(current === 'scroll' ? 'cursor' : 'scroll');
						}}
						title={touchMode === 'cursor' ? 'Cursor mode — tap switches to touch' : 'Touch mode — tap switches to cursor'}
					>
						<Icon name={touchMode === 'cursor' ? 'lucide:mouse-pointer-2' : 'lucide:pointer'} class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
					</button>
				{/if}

				<!-- Rotation toggle -->
				{@const rotation = previewPanelRef?.panelActions?.getRotation()}
				{@const rotationLocked = previewPanelRef?.panelActions?.getIsMcpControlled() || !canRotate(previewPanelRef?.panelActions?.getDeviceSize() ?? 'laptop')}
				<button
					type="button"
					class="flex items-center justify-center {isMobile ? 'w-9 h-8' : 'w-6 h-6'} bg-transparent border-none rounded-md transition-all duration-150 {rotationLocked ? 'text-slate-400 dark:text-slate-600 cursor-not-allowed opacity-50' : 'text-slate-500 cursor-pointer hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100'}"
					onclick={rotationLocked ? undefined : () => previewPanelRef?.panelActions?.toggleRotation()}
					disabled={rotationLocked}
					title={previewPanelRef?.panelActions?.getIsMcpControlled()
						? 'Controlled by MCP agent'
						: rotationLocked
							? 'A laptop screen does not rotate'
							: `Orientation: ${rotation === 'portrait' ? 'Portrait' : 'Landscape'} — click to toggle`}
				>
					<Icon name="lucide:rotate-cw" class={isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} />
				</button>

			{:else if panelId === 'git'}
				<!-- View mode toggles (only in single-column mode, like Files panel) -->
				{#if !gitPanelRef?.panelActions?.isTwoColumnMode()}
					<div class="flex gap-1 bg-slate-100/80 dark:bg-slate-800/50 rounded-md">
						<button
							type="button"
							class="flex items-center justify-center {isMobile ? 'w-9 h-8' : 'w-6 h-6'} bg-transparent border-none rounded text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100
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
							class="flex items-center justify-center {isMobile ? 'w-9 h-8' : 'w-6 h-6'} bg-transparent border-none rounded text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-40 disabled:cursor-not-allowed
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

				<!-- Branch shortcut → Branches tab (Local) -->
				{#if gitPanelRef?.panelActions?.getIsRepo()}
					<button
						type="button"
						class="flex items-center gap-1 {isMobile ? 'h-8 px-2' : 'h-6 px-1.5'} bg-slate-100 dark:bg-slate-800/60 border-none rounded-md text-slate-700 dark:text-slate-300 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400"
						onclick={() => gitPanelRef?.panelActions?.openBranches('local')}
						title="Manage branches"
					>
						<Icon name="lucide:git-branch" class={isMobile ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
						<span class="text-xs font-medium truncate max-w-24">{currentBranch}</span>
					</button>
				{/if}

			{/if}
		</div>

	</div>
</header>
