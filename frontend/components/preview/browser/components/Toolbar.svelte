<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { onDestroy } from 'svelte';

	let {
		// URL state
		url = $bindable(''),
		urlInput = $bindable(''),
		isLoading = $bindable(false),
		isLaunchingBrowser = $bindable(false),
		isNavigating = $bindable(false),
		isReconnecting = $bindable(false), // True during fast reconnect after navigation

		// Session state
		sessionId = $bindable<string | null>(null),
		sessionInfo = $bindable<any>(null),
		isConnected = $bindable(false),
		isStreamReady = $bindable(false),
		errorMessage = $bindable<string | null>(null),

		// Console state
		isConsoleOpen = $bindable(false),

		// Tab state
		tabs = $bindable<any[]>([]),
		activeTabId = $bindable<string | null>(null),
		mcpControlledTabIds = $bindable<Set<string>>(new Set()),

		// Callbacks
		onGoClick = $bindable<() => void>(() => {}),
		onRefresh = $bindable<() => void>(() => {}),
		onOpenInExternalBrowser = $bindable<() => void>(() => {}),
		onClosePreview = $bindable<() => void>(() => {}),
		onToggleConsole = $bindable<() => void>(() => {}),
		onUrlInput = $bindable<() => void>(() => {}),
		onUrlKeydown = $bindable<(event: KeyboardEvent) => void>(() => {}),
		onSwitchTab = $bindable<(tabId: string) => void | Promise<void>>(() => {}),
		onCloseTab = $bindable<(tabId: string) => void>(() => {}),
		onNewTab = $bindable<() => void>(() => {})
	} = $props();

	// User typing detection
	let isUserTyping = $state(false);
	let typingTimeout: NodeJS.Timeout;

	// Progress bar state
	let progressPercent = $state(0);
	let showProgress = $state(false);
	let progressAnimationId: number | null = null;
	let progressCompleteTimeout: ReturnType<typeof setTimeout> | null = null;

	function handleUrlInput() {
		isUserTyping = true;
		onUrlInput();
		
		// Reset typing flag after user stops typing for 1 second
		clearTimeout(typingTimeout);
		typingTimeout = setTimeout(() => {
			isUserTyping = false;
		}, 1000);
	}

	function handleUrlKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			isUserTyping = false;
			onGoClick();
		}
		onUrlKeydown(event);
	}

	function handleGoClick() {
		if (!urlInput.trim()) return;
		isUserTyping = false;
		clearTimeout(typingTimeout);
		onGoClick();
	}

	function handleRefresh() {
		onRefresh();
	}

	function handleOpenInExternalBrowser() {
		if (url) {
			window.open(url, '_blank');
			// User already knows from new browser tab opening
		}
		onOpenInExternalBrowser();
	}

	function handleClosePreview() {
		onClosePreview();
		// User already knows from UI panel disappearing
	}

	function handleToggleConsole() {
		onToggleConsole();
	}

	// Progress bar animation functions
	function startProgressAnimation() {
		if (progressAnimationId) {
			cancelAnimationFrame(progressAnimationId);
		}
		
		showProgress = true;
		progressPercent = 0;
		
		const startTime = Date.now();
		
		// Simulate realistic browser loading progress
		const animate = () => {
			const elapsed = Date.now() - startTime;
			
			// Fast initial loading (0-30% in first 300ms)
			if (elapsed < 300) {
				progressPercent = (elapsed / 300) * 30;
			}
			// Medium loading (30-70% in next 700ms)
			else if (elapsed < 1000) {
				progressPercent = 30 + ((elapsed - 300) / 700) * 40;
			}
			// Slow loading (70-90% in next 1000ms)
			else if (elapsed < 2000) {
				progressPercent = 70 + ((elapsed - 1000) / 1000) * 20;
			}
			// Very slow final loading (90-95% in remaining time)
			else {
				progressPercent = Math.min(90 + ((elapsed - 2000) / 2000) * 5, 95);
			}
			
			if (progressPercent < 95) {
				progressAnimationId = requestAnimationFrame(animate);
			}
		};
		
		progressAnimationId = requestAnimationFrame(animate);
	}

	function completeProgress() {
		if (progressAnimationId) {
			cancelAnimationFrame(progressAnimationId);
			progressAnimationId = null;
		}
		
		// Complete the progress bar
		progressPercent = 100;
		
		// Hide after a short delay
		setTimeout(() => {
			showProgress = false;
			progressPercent = 0;
		}, 300);
	}

	function stopProgress() {
		if (progressAnimationId) {
			cancelAnimationFrame(progressAnimationId);
			progressAnimationId = null;
		}
		
		showProgress = false;
		progressPercent = 0;
	}

	// Reset progress bar immediately when active tab changes.
	// A brief suppression window prevents the loading $effect from
	// restarting progress before global state has synced to the new tab.
	let previousActiveTabId = $state<string | null>(null);
	let tabSwitchSuppressUntil = 0;
	$effect(() => {
		if (activeTabId !== previousActiveTabId) {
			previousActiveTabId = activeTabId;
			stopProgress();
			if (progressCompleteTimeout) {
				clearTimeout(progressCompleteTimeout);
				progressCompleteTimeout = null;
			}
			// Suppress loading $effect for a short window to allow state sync
			tabSwitchSuppressUntil = Date.now() + 150;
		}
	});

	// Watch loading states to control progress bar
	$effect(() => {
		const waitingForInitialFrame = sessionInfo && !isStreamReady && !isNavigating && !isReconnecting;
		const shouldShowProgress = isLoading || isLaunchingBrowser || isNavigating || isReconnecting || waitingForInitialFrame;

		// Skip during tab switch suppression window — state may be stale from old tab
		if (Date.now() < tabSwitchSuppressUntil) {
			return;
		}

		// Cancel any pending completion when a loading state becomes active
		if (shouldShowProgress && progressCompleteTimeout) {
			clearTimeout(progressCompleteTimeout);
			progressCompleteTimeout = null;
		}

		if (shouldShowProgress && !showProgress) {
			startProgressAnimation();
		}
		else if (!shouldShowProgress && showProgress && !progressCompleteTimeout) {
			progressCompleteTimeout = setTimeout(() => {
				progressCompleteTimeout = null;
				const stillShouldComplete = !isLoading && !isLaunchingBrowser && !isNavigating && !isReconnecting;
				const stillWaitingForFrame = sessionInfo && !isStreamReady && !isNavigating && !isReconnecting;
				if (stillShouldComplete && !stillWaitingForFrame) {
					completeProgress();
				}
			}, 100);
		}
	});

	// Whether the currently active tab is under MCP control
	const isMcpControlled = $derived(activeTabId != null && mcpControlledTabIds.has(activeTabId));

	// Cleanup animation frame on component destroy
	onDestroy(() => {
		if (progressAnimationId) {
			cancelAnimationFrame(progressAnimationId);
		}
		if (typingTimeout) {
			clearTimeout(typingTimeout);
		}
		if (progressCompleteTimeout) {
			clearTimeout(progressCompleteTimeout);
		}
	});
</script>

<!-- Preview Toolbar -->
<div class="relative bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
	<!-- Tabs bar (Git-style underline tabs) — separated with its own border-bottom -->
	{#if tabs.length > 0}
		<div class="relative flex items-center overflow-x-auto border-b border-slate-200 dark:border-slate-700">
			{#each tabs as tab}
				{@const isActive = tab.id === activeTabId}
				<button
					type="button"
					class="group relative flex items-center justify-center gap-1 pr-2 pl-3 py-2 text-xs font-medium transition-colors min-w-0 max-w-xs cursor-pointer
						{isActive
							? 'text-violet-600 dark:text-violet-400'
							: 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}"
					onclick={() => onSwitchTab(tab.id)}
					role="tab"
					tabindex="0"
				>
					<span class="truncate max-w-28" title={tab.url}>
						{tab.title || 'New Tab'}
					</span>
					{#if mcpControlledTabIds.has(tab.id)}
						<span title="MCP Controlled" class="flex"><Icon name="lucide:lock" class="w-3 h-3 flex-shrink-0 text-amber-500" /></span>
					{/if}
					<!-- Close button -->
					{#if !mcpControlledTabIds.has(tab.id)}
						<span
							role="button"
							tabindex="0"
							onclick={(e) => {
								e.stopPropagation();
								onCloseTab(tab.id);
							}}
							onkeydown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.stopPropagation();
									onCloseTab(tab.id);
								}
							}}
							class="flex items-center justify-center w-4 h-4 rounded hover:bg-slate-200 dark:hover:bg-slate-700 transition-all duration-200 flex-shrink-0"
							title="Close tab"
						>
							<Icon name="lucide:x" class="w-2.5 h-2.5" />
						</span>
					{/if}
					{#if isActive}
						<span class="absolute bottom-0 inset-x-0 h-px bg-violet-600 dark:bg-violet-400"></span>
					{/if}
				</button>
			{/each}

			<!-- New tab button -->
			<button
				type="button"
				onclick={() => onNewTab()}
				class="flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 transition-all duration-200 flex-shrink-0 ml-1"
				title="Open new tab"
			>
				<Icon name="lucide:plus" class="w-3 h-3" />
			</button>
		</div>
	{/if}

	<!-- Main toolbar header (URL bar) -->
	<div class="px-2.5 py-1.5">
		<div class="px-1 py-0.5 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
			<div class="flex items-center justify-between gap-3">
				<!-- Left section: URL navigation -->
				<div class="flex items-center gap-2 flex-1 min-w-0">
					<!-- URL input with integrated controls -->
					<input
						type="text"
						bind:value={urlInput}
						onkeydown={handleUrlKeydown}
						oninput={handleUrlInput}
						onfocus={() => isUserTyping = true}
						onblur={() => isUserTyping = false}
						placeholder={isMcpControlled ? 'MCP controlled — navigation disabled' : 'Enter URL to preview...'}
						disabled={isMcpControlled}
						class="flex-1 pl-3 py-2 text-sm bg-transparent border-0 focus:outline-none min-w-0 text-ellipsis disabled:opacity-50 disabled:cursor-not-allowed"
					/>
					<div class="flex items-center gap-1 px-1.5">
						{#if url}
							<button
								onclick={handleOpenInExternalBrowser}
								class="flex p-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-700 transition-all duration-200"
								title="Open in external browser"
							>
								<Icon name="lucide:external-link" class="w-4 h-4" />
							</button>
							<button
								onclick={handleRefresh}
								disabled={isLoading || isMcpControlled}
								class="flex p-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-700 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
								title="Refresh current page"
							>
								<Icon name={isLoading ? 'lucide:loader-circle' : 'lucide:refresh-cw'} class="w-4 h-4 transition-transform duration-200 {isLoading ? 'animate-spin' : 'hover:rotate-180'}" />
							</button>
						{/if}
						<button
							onclick={handleGoClick}
							disabled={!urlInput.trim() || isLoading || isMcpControlled}
							class="ml-0.5 px-3.5 py-1 text-xs font-medium rounded-md bg-violet-500 hover:bg-violet-600 disabled:bg-slate-300 disabled:dark:bg-slate-600 text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
							title={isMcpControlled ? 'Navigation disabled — MCP controlled' : 'Navigate to URL'}
						>
							Go
						</button>
					</div>
				</div>
			</div>
		</div>
	</div>

	<!-- Progress Bar - positioned at bottom of toolbar, overlapping the border -->
	{#if showProgress}
		<div class="absolute -bottom-px left-0 right-0 h-0.5 z-10 overflow-hidden rounded-b-xl">
			<div
				class="h-full bg-gradient-to-r from-violet-500 via-blue-600 to-purple-600 transition-all duration-100 ease-out relative"
				style="width: {progressPercent}%"
			>
				<!-- Glow effect -->
				<div class="absolute inset-0 bg-gradient-to-r from-violet-400 to-purple-500 blur-sm opacity-60"></div>
				<!-- Shimmer effect -->
				<div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-pulse"></div>
			</div>
		</div>
	{/if}
</div>