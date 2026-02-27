<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import { addNotification } from '$frontend/lib/stores/ui/notification.svelte';
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
		mcpControlledTabId = $bindable<string | null>(null),

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

	// Watch loading states to control progress bar
	// Progress bar should be active during:
	// 1. isLaunchingBrowser: API call to launch browser
	// 2. sessionInfo exists but isStreamReady false: waiting for first frame (initial load)
	// 3. isNavigating: navigating within same session (link click)
	// 4. isReconnecting: fast reconnect after navigation (keeps progress bar visible)
	// 5. isLoading: generic loading state
	$effect(() => {
		const waitingForInitialFrame = sessionInfo && !isStreamReady && !isNavigating && !isReconnecting;
		const shouldShowProgress = isLoading || isLaunchingBrowser || isNavigating || isReconnecting || waitingForInitialFrame;

		// Cancel any pending completion when a loading state becomes active
		if (shouldShowProgress && progressCompleteTimeout) {
			clearTimeout(progressCompleteTimeout);
			progressCompleteTimeout = null;
		}

		// Only start if not already showing progress (prevent restart)
		if (shouldShowProgress && !showProgress) {
			startProgressAnimation();
		}
		// Only complete if currently showing progress - with debounce to handle state transitions
		// This prevents the progress bar from briefly completing during isNavigating → isReconnecting transition
		else if (!shouldShowProgress && showProgress && !progressCompleteTimeout) {
			progressCompleteTimeout = setTimeout(() => {
				progressCompleteTimeout = null;
				// Re-check if we should still complete (state might have changed)
				const stillShouldComplete = !isLoading && !isLaunchingBrowser && !isNavigating && !isReconnecting;
				const stillWaitingForFrame = sessionInfo && !isStreamReady && !isNavigating && !isReconnecting;
				if (stillShouldComplete && !stillWaitingForFrame) {
					completeProgress();
				}
			}, 100); // 100ms debounce to handle state transitions
		}
	});

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
<div class="relative px-3 py-2.5 bg-slate-100 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
	<!-- Tabs bar -->
	{#if tabs.length > 0}
		<div class="flex items-center gap-1.5 overflow-x-auto mb-1.5">
			<!-- Tabs -->
			{#each tabs as tab}
				<div
					class="group relative flex items-center gap-2 pl-3 pr-2 py-1.5 border border-slate-200 dark:border-slate-700 rounded-lg transition-all duration-200 min-w-0 max-w-xs cursor-pointer
						{tab.id === activeTabId 
							? 'bg-slate-100 dark:bg-slate-700'
							: 'bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700'}"
					onclick={() => onSwitchTab(tab.id)}
					role="tab"
					tabindex="0"
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							onSwitchTab(tab.id);
						}
					}}
				>
					{#if tab.id === mcpControlledTabId}
						<Icon name="lucide:bot" class="w-3 h-3 flex-shrink-0 text-amber-500" />
					{:else if tab.isLoading}
						<Icon name="lucide:loader-circle" class="w-3 h-3 animate-spin flex-shrink-0" />
					{:else}
						<Icon name="lucide:globe" class="w-3 h-3 flex-shrink-0" />
					{/if}
					<span class="text-xs font-medium truncate max-w-37.5" title={tab.url}>
						{tab.title || 'New Tab'}
					</span>
					{#if tab.id === mcpControlledTabId}
						<span title="MCP Controlled" class="flex">
							<Icon name="lucide:lock" class="w-3 h-3 flex-shrink-0 text-amber-500" />
						</span>
					{/if}
					<button
						onclick={(e) => {
							e.stopPropagation();
							onCloseTab(tab.id);
						}}
						class="flex hover:bg-slate-300 dark:hover:bg-slate-600 rounded p-0.5 transition-all duration-200 {tab.id === mcpControlledTabId ? 'hidden' : ''}"
						title="Close tab"
						disabled={tab.id === mcpControlledTabId}
					>
						<Icon name="lucide:x" class="w-3 h-3" />
					</button>
				</div>
			{/each}
		
			<!-- New tab button -->
			<button
				onclick={() => onNewTab()}
				class="flex items-center justify-center w-5 h-5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 transition-all duration-200"
				title="Open new tab"
			>
				<Icon name="lucide:plus" class="w-3 h-3" />
			</button>
		</div>
	{/if}
	
	<!-- Main toolbar header -->
	<div class="px-1 py-0.5 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
		<div class="flex items-center justify-between gap-4">
			<!-- Left section: URL navigation -->
			<div class="flex items-center gap-3 flex-1 min-w-0">
				<!-- URL input with integrated controls -->
				<input
					type="text"
					bind:value={urlInput}
					onkeydown={handleUrlKeydown}
					oninput={handleUrlInput}
					onfocus={() => isUserTyping = true}
					onblur={() => isUserTyping = false}
					placeholder="Enter URL to preview..."
					class="flex-1 pl-3 py-2.5 text-sm bg-transparent border-0 focus:outline-none min-w-0 text-ellipsis"
				/>
				<div class="flex items-center gap-1 px-2">
					{#if url}
						<button
							onclick={handleOpenInExternalBrowser}
							class="flex p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-all duration-200"
							title="Open in external browser"
						>
							<Icon name="lucide:external-link" class="w-4 h-4" />
						</button>
						<button
							onclick={handleRefresh}
							disabled={isLoading}
							class="flex p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-all duration-200 disabled:opacity-50"
							title="Refresh current page"
						>
							<Icon name={isLoading ? 'lucide:loader-circle' : 'lucide:refresh-cw'} class="w-4 h-4 transition-transform duration-200 {isLoading ? 'animate-spin' : 'hover:rotate-180'}" />
						</button>
					{/if}
					<button
						onclick={handleGoClick}
						disabled={!urlInput.trim() || isLoading}
						class="ml-1 px-4 py-1.5 text-sm font-medium rounded-lg bg-violet-500 hover:bg-violet-600 disabled:bg-slate-300 disabled:dark:bg-slate-600 text-white transition-all duration-200 disabled:opacity-50"
						title="Navigate to URL"
					>
						Go
					</button>
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