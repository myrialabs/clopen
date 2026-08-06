<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';
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
		isConsoleOpen = false,
		consoleIssueCount = 0,

		// Navigation state
		canGoBack = false,
		canGoForward = false,

		// Layout
		isMobile = false,
		/** Touch devices get an explicit keyboard button, as the tap heuristic
		 *  cannot cover every case (a page that focuses a field on its own). */
		showKeyboardToggle = false,

		// Tab state
		tabs = [] as any[],
		activeTabId = null as string | null,
		mcpControlledTabIds = new Set<string>(),
		/**
		 * Controlled tabs an agent is acting on right now.
		 *
		 * Distinct from being locked: an agent working across several tabs locks
		 * all of them, and the user — free to look wherever they like — otherwise
		 * has no way to tell which one is live. A set rather than one id, since a
		 * project can have two runs going, each on a tab of its own.
		 */
		mcpFocusedTabIds = new Set<string>(),

		// Callbacks
		onGoClick = () => {},
		onRefresh = () => {},
		onStop = () => {},
		onBack = () => {},
		onForward = () => {},
		onOpenInExternalBrowser = () => {},
		onToggleConsole = () => {},
		onToggleKeyboard = () => {},
		onUrlInput = () => {},
		onAddressFocusChange = (_focused: boolean) => {},
		onUrlKeydown = (_event: KeyboardEvent) => {},
		onSwitchTab = (_tabId: string) => {},
		onCloseTab = (_tabId: string) => {},
		onReorderTab = (_tabId: string, _targetTabId: string) => {},
		onNewTab = () => {},
		onCloseAllTabs = () => {}
	} = $props();

	/**
	 * Tabs an agent is driving are left alone by "close all" — closing one out
	 * from under a running automation would fail it mid-step.
	 */
	const closableTabs = $derived(tabs.filter((tab: any) => !mcpControlledTabIds.has(tab.id)));
	const lockedTabCount = $derived(tabs.length - closableTabs.length);

	const closeAllTitle = $derived(
		closableTabs.length === 0
			? 'Every tab is being controlled by an agent'
			: lockedTabCount > 0
				? `Close ${closableTabs.length} tabs (${lockedTabCount} controlled by an agent stay open)`
				: 'Close all tabs'
	);

	let urlInputElement = $state<HTMLInputElement | undefined>();
	let tabStripElement = $state<HTMLDivElement | undefined>();

	// Drag-to-reorder state
	let draggingTabId = $state<string | null>(null);
	let dragOverTabId = $state<string | null>(null);

	/**
	 * Favicon URLs that failed to load, so the strip falls back to the
	 * placeholder instead of leaving a hole. Keyed by URL rather than tab so a
	 * reload of the same page does not retry a known-bad icon on every render.
	 */
	let brokenFavicons = $state(new Set<string>());

	function markFaviconBroken(src: string | undefined) {
		if (!src || brokenFavicons.has(src)) return;
		brokenFavicons = new Set(brokenFavicons).add(src);
	}

	/**
	 * Turn a vertical wheel into horizontal scrolling over the strip, which is
	 * how every editor tab bar behaves — a trackpad or mouse wheel is the only
	 * way to reach overflowed tabs without a visible scrollbar.
	 */
	function handleTabStripWheel(event: WheelEvent) {
		if (!tabStripElement) return;
		if (event.deltaY === 0 || event.shiftKey) return;
		if (tabStripElement.scrollWidth <= tabStripElement.clientWidth) return;

		event.preventDefault();
		tabStripElement.scrollLeft += event.deltaY;
	}

	// Keep the active tab in view when it changes from outside the strip —
	// a new tab, an MCP-opened one, or a Ctrl+Tab style switch.
	$effect(() => {
		const id = activeTabId;
		if (!id || !tabStripElement) return;

		queueMicrotask(() => {
			tabStripElement
				?.querySelector(`[data-tab-id="${CSS.escape(id)}"]`)
				?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		});
	});

	// Progress bar state
	let progressPercent = $state(0);
	let showProgress = $state(false);
	let progressAnimationId: number | null = null;
	let progressCompleteTimeout: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Anything that means "the page is still coming". Drives both the progress
	 * bar and the reload/stop swap, so the two can never disagree.
	 */
	const isBusy = $derived(
		isLoading ||
			isLaunchingBrowser ||
			isNavigating ||
			isReconnecting ||
			(!!sessionInfo && !isStreamReady && !isNavigating && !isReconnecting)
	);

	/** Whether the currently active tab is under MCP control */
	const isMcpControlled = $derived(activeTabId != null && mcpControlledTabIds.has(activeTabId));

	/**
	 * Scheme badge, the way a browser's omnibox shows it. `file:` counts as
	 * trusted; plain http over a non-loopback host does not.
	 */
	const security = $derived.by(() => {
		if (!url) return null;
		try {
			const parsed = new URL(url);
			if (parsed.protocol === 'https:' || parsed.protocol === 'file:') {
				return { icon: 'lucide:lock' as IconName, class: 'text-emerald-500', label: 'Connection is secure' };
			}
			if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]') {
				return { icon: 'lucide:monitor-dot' as IconName, class: 'text-slate-400', label: 'Local development server' };
			}
			return { icon: 'lucide:lock-open' as IconName, class: 'text-amber-500', label: 'Connection is not secure' };
		} catch {
			return null;
		}
	});

	function handleUrlInput() {
		onUrlInput();
	}

	function handleUrlKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			onGoClick();
			urlInputElement?.blur();
		} else if (event.key === 'Escape') {
			// Escape reverts the edit, matching the omnibox.
			urlInput = url;
			urlInputElement?.blur();
		}
		onUrlKeydown(event);
	}

	function handleOpenInExternalBrowser() {
		if (url) window.open(url, '_blank');
		onOpenInExternalBrowser();
	}

	/** Focus and select the address bar — used by the Cmd/Ctrl+L shortcut. */
	export function focusAddressBar() {
		urlInputElement?.focus();
		urlInputElement?.select();
	}

	// ── Progress bar ────────────────────────────────────────────────────────

	function startProgressAnimation() {
		if (progressAnimationId) cancelAnimationFrame(progressAnimationId);

		showProgress = true;
		progressPercent = 0;

		const startTime = Date.now();

		// Ease toward 95% and wait there: real load time is unknowable, and a bar
		// that stalls at the end reads better than one that jumps backwards.
		const animate = () => {
			const elapsed = Date.now() - startTime;

			if (elapsed < 300) progressPercent = (elapsed / 300) * 30;
			else if (elapsed < 1000) progressPercent = 30 + ((elapsed - 300) / 700) * 40;
			else if (elapsed < 2000) progressPercent = 70 + ((elapsed - 1000) / 1000) * 20;
			else progressPercent = Math.min(90 + ((elapsed - 2000) / 2000) * 5, 95);

			if (progressPercent < 95) progressAnimationId = requestAnimationFrame(animate);
		};

		progressAnimationId = requestAnimationFrame(animate);
	}

	function completeProgress() {
		if (progressAnimationId) {
			cancelAnimationFrame(progressAnimationId);
			progressAnimationId = null;
		}

		progressPercent = 100;
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

	// Reset progress immediately on tab change. The brief suppression window
	// stops the loading effect below from restarting it before global state has
	// synced to the new tab.
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
			tabSwitchSuppressUntil = Date.now() + 150;
		}
	});

	$effect(() => {
		const shouldShowProgress = isBusy;

		// Skip during tab switch suppression window — state may be stale from old tab
		if (Date.now() < tabSwitchSuppressUntil) return;

		if (shouldShowProgress && progressCompleteTimeout) {
			clearTimeout(progressCompleteTimeout);
			progressCompleteTimeout = null;
		}

		if (shouldShowProgress && !showProgress) {
			startProgressAnimation();
		} else if (!shouldShowProgress && showProgress && !progressCompleteTimeout) {
			progressCompleteTimeout = setTimeout(() => {
				progressCompleteTimeout = null;
				if (!isBusy) completeProgress();
			}, 100);
		}
	});

	onDestroy(() => {
		if (progressAnimationId) cancelAnimationFrame(progressAnimationId);
		if (progressCompleteTimeout) clearTimeout(progressCompleteTimeout);
	});
</script>

<!-- Preview Toolbar -->
<div class="relative bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
	<!-- Tab strip -->
	{#if tabs.length > 0}
		<!--
			The tab actions live *inside* the scroller as a sticky block, so they
			sit immediately after the last tab while there is room and pin
			themselves to the right edge once the tabs overflow — reachable either
			way, and never marooned at the far side of a half-empty strip.
		-->
		<div
			bind:this={tabStripElement}
			onwheel={handleTabStripWheel}
			class="tab-strip flex items-center overflow-x-auto border-b border-slate-200 dark:border-slate-700"
		>
			{#each tabs as tab (tab.id)}
				{@const isActive = tab.id === activeTabId}
				{@const isControlled = mcpControlledTabIds.has(tab.id)}
				{@const isAgentHere = isControlled && mcpFocusedTabIds.has(tab.id)}
				<button
					type="button"
					data-tab-id={tab.id}
					draggable="true"
					ondragstart={(event) => {
						draggingTabId = tab.id;
						event.dataTransfer?.setData('text/plain', tab.id);
						if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
					}}
					ondragover={(event) => {
						if (!draggingTabId || draggingTabId === tab.id) return;
						// Default is "reject the drop"; allowing it is what turns the
						// pointer into a move cursor and lets `drop` fire at all.
						event.preventDefault();
						if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
						dragOverTabId = tab.id;
					}}
					ondragleave={() => {
						if (dragOverTabId === tab.id) dragOverTabId = null;
					}}
					ondrop={(event) => {
						event.preventDefault();
						const sourceId = draggingTabId ?? event.dataTransfer?.getData('text/plain');
						if (sourceId && sourceId !== tab.id) onReorderTab(sourceId, tab.id);
						draggingTabId = null;
						dragOverTabId = null;
					}}
					ondragend={() => {
						draggingTabId = null;
						dragOverTabId = null;
					}}
					class="group relative flex shrink-0 items-center justify-center gap-1.5 pr-1.5 pl-2.5 py-2 text-xs font-medium transition-colors max-w-52 cursor-pointer
						{isActive
						? 'text-violet-600 dark:text-violet-400'
						: 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}
						{draggingTabId === tab.id ? 'opacity-40' : ''}
						{dragOverTabId === tab.id ? 'bg-violet-500/10' : ''}
						{isAgentHere ? 'bg-amber-500/10' : ''}"
					onclick={() => onSwitchTab(tab.id)}
					onauxclick={(event) => {
						// Middle-click closes, as in every browser.
						if (event.button === 1 && !isControlled) {
							event.preventDefault();
							onCloseTab(tab.id);
						}
					}}
					role="tab"
					aria-selected={isActive}
					tabindex="0"
					title={tab.url || tab.title}
				>
					<span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
						{#if tab.isLoading || tab.isLaunchingBrowser}
							<Icon name="lucide:loader-circle" class="h-3 w-3 animate-spin" />
						{:else if tab.favicon && !brokenFavicons.has(tab.favicon)}
							<!--
								Favicons fail constantly — a 404 on the /favicon.ico guess, CORS,
								a data URL the page revoked. Falling back to the placeholder is
								what a browser does; hiding the image left an empty gap instead.
							-->
							<img
								src={tab.favicon}
								alt=""
								class="h-3.5 w-3.5 rounded-sm object-contain"
								onerror={() => markFaviconBroken(tab.favicon)}
							/>
						{:else}
							<Icon name="lucide:globe" class="h-3 w-3 opacity-60" />
						{/if}
					</span>

					<span class="truncate max-w-28">{tab.title || 'New Tab'}</span>

					{#if isControlled}
						<!--
							Two states, not one. The static lock means "an agent holds
							this tab"; the pulse means "an agent is working in it right
							now". Told apart, the strip answers the question the lock
							alone could not — which tab to actually watch.
						-->
						<span
							title={isAgentHere
								? 'An AI agent is working in this tab'
								: 'Held by an AI agent'}
							class="flex"
						>
							<Icon
								name="lucide:lock"
								class="h-3 w-3 shrink-0 {isAgentHere
									? 'animate-pulse text-amber-500'
									: 'text-amber-500/60'}"
							/>
						</span>
					{:else}
						<span
							role="button"
							tabindex="0"
							onclick={(event) => {
								event.stopPropagation();
								onCloseTab(tab.id);
							}}
							onkeydown={(event) => {
								if (event.key === 'Enter' || event.key === ' ') {
									event.stopPropagation();
									onCloseTab(tab.id);
								}
							}}
							class="flex h-4 w-4 shrink-0 items-center justify-center rounded transition-all duration-200 hover:bg-slate-200 dark:hover:bg-slate-700"
							title="Close tab"
						>
							<Icon name="lucide:x" class="h-2.5 w-2.5" />
						</span>
					{/if}

					{#if isActive}
						<span class="absolute inset-x-0 bottom-0 h-px bg-violet-600 dark:bg-violet-400"></span>
					{:else if isAgentHere}
						<!-- The agent's tab is findable without being the one on screen:
						     the point is that the user can look elsewhere and still know
						     where the work is happening. -->
						<span class="absolute inset-x-0 bottom-0 h-px animate-pulse bg-amber-500"></span>
					{/if}
				</button>
			{/each}

			<!-- Sticky, and opaque so tabs scroll underneath rather than through. -->
			<div class="sticky right-0 z-10 flex shrink-0 items-center gap-0.5 bg-white px-1 dark:bg-slate-900">
				<button
					type="button"
					onclick={() => onNewTab()}
					class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-400 transition-all duration-200 hover:bg-slate-200/60 hover:text-slate-600 dark:hover:bg-slate-700/60 dark:hover:text-slate-300"
					title="New tab"
					aria-label="New tab"
				>
					<Icon name="lucide:plus" class="h-3 w-3" />
				</button>

				{#if tabs.length > 1}
					<button
						type="button"
						onclick={() => onCloseAllTabs()}
						disabled={closableTabs.length === 0}
						class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-400 transition-all duration-200 hover:bg-red-500/10 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-400"
						title={closeAllTitle}
						aria-label={closeAllTitle}
					>
						<Icon name="lucide:list-x" class="h-3.5 w-3.5" />
					</button>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Address bar row -->
	<div class="flex items-center gap-2 px-2 py-1.5">
		<!-- Navigation cluster -->
		<div class="flex shrink-0 items-center gap-0.5">
			<button
				type="button"
				onclick={() => onBack()}
				disabled={!canGoBack || isMcpControlled}
				class="flex items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent dark:hover:bg-slate-800 dark:hover:text-slate-100 h-7 w-7"
				title="Back"
				aria-label="Back"
			>
				<Icon name="lucide:arrow-left" class="h-4 w-4" />
			</button>
			<button
				type="button"
				onclick={() => onForward()}
				disabled={!canGoForward || isMcpControlled}
				class="flex items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent dark:hover:bg-slate-800 dark:hover:text-slate-100 h-7 w-7"
				title="Forward"
				aria-label="Forward"
			>
				<Icon name="lucide:arrow-right" class="h-4 w-4" />
			</button>
			<button
				type="button"
				onclick={() => (isBusy ? onStop() : onRefresh())}
				disabled={isMcpControlled || !url}
				class="flex items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent dark:hover:bg-slate-800 dark:hover:text-slate-100 h-7 w-7"
				title={isBusy ? 'Stop loading' : 'Reload'}
				aria-label={isBusy ? 'Stop loading' : 'Reload'}
			>
				<Icon name={isBusy ? 'lucide:x' : 'lucide:refresh-cw'} class="h-4 w-4" />
			</button>
		</div>

		<!-- Address field -->
		<div
			class="flex min-w-0 flex-1 items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 transition-colors focus-within:border-violet-400 focus-within:bg-white dark:border-slate-700 dark:bg-slate-800 dark:focus-within:bg-slate-800 {isMobile
				? 'py-1.5'
				: 'py-1'}"
		>
			{#if security}
				<span class="flex shrink-0" title={security.label}>
					<Icon name={security.icon} class="h-3.5 w-3.5 {security.class}" />
				</span>
			{:else}
				<Icon name="lucide:search" class="h-3.5 w-3.5 shrink-0 text-slate-400" />
			{/if}

			<input
				bind:this={urlInputElement}
				type="text"
				bind:value={urlInput}
				onkeydown={handleUrlKeydown}
				oninput={handleUrlInput}
				onfocus={() => {
				onAddressFocusChange(true);
				urlInputElement?.select();
			}}
			onblur={() => onAddressFocusChange(false)}
				placeholder={isMcpControlled ? 'Controlled by an AI agent' : 'Enter a URL'}
				disabled={isMcpControlled}
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				aria-label="Address bar"
				class="min-w-0 flex-1 border-0 bg-transparent text-sm text-ellipsis text-slate-700 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-200"
			/>

			{#if urlInput.trim() && urlInput !== url}
				<button
					type="button"
					onclick={() => onGoClick()}
					disabled={isMcpControlled}
					class="shrink-0 rounded-full bg-violet-500 px-2.5 py-0.5 text-2xs font-medium text-white transition-colors hover:bg-violet-600 disabled:opacity-50"
					title="Go"
				>
					Go
				</button>
			{/if}
		</div>

		<!-- Utility cluster -->
		<div class="flex shrink-0 items-center gap-0.5">
			{#if showKeyboardToggle}
				<button
					type="button"
					onclick={() => onToggleKeyboard()}
					disabled={!url}
					class="flex items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:opacity-35 dark:hover:bg-slate-800 dark:hover:text-slate-100 h-7 w-7"
					title="Show keyboard"
					aria-label="Show keyboard"
				>
					<Icon name="lucide:keyboard" class="h-4 w-4" />
				</button>
			{/if}

			<button
				type="button"
				onclick={() => onToggleConsole()}
				class="relative flex items-center justify-center rounded-md transition-colors {isConsoleOpen
					? 'bg-violet-500/10 text-violet-600 dark:text-violet-400'
					: 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-100'} h-7 w-7"
				title="Toggle console"
				aria-label="Toggle console"
				aria-pressed={isConsoleOpen}
			>
				<Icon name="lucide:terminal" class="h-4 w-4" />
				{#if consoleIssueCount > 0 && !isConsoleOpen}
					<span
						class="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-1 text-5xs font-semibold leading-none text-white"
					>
						{consoleIssueCount > 99 ? '99+' : consoleIssueCount}
					</span>
				{/if}
			</button>

			{#if url}
				<button
					type="button"
					onclick={() => handleOpenInExternalBrowser()}
					class="flex items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-100 h-7 w-7"
					title="Open in your browser"
					aria-label="Open in your browser"
				>
					<Icon name="lucide:external-link" class="h-4 w-4" />
				</button>
			{/if}
		</div>
	</div>

	<!-- Progress bar, overlapping the bottom border -->
	{#if showProgress}
		<div class="absolute -bottom-px left-0 right-0 z-10 h-0.5 overflow-hidden">
			<div
				class="relative h-full bg-gradient-to-r from-violet-500 via-blue-600 to-purple-600 transition-all duration-100 ease-out"
				style="width: {progressPercent}%"
			>
				<div class="absolute inset-0 bg-gradient-to-r from-violet-400 to-purple-500 opacity-60 blur-sm"></div>
			</div>
		</div>
	{/if}
</div>

<style>
	/* Thin, unobtrusive scrollbar. The strip has to stay scrollable once tabs
	   overflow, but a default-height bar under a 32px row reads as a defect. */
	.tab-strip {
		scrollbar-width: thin;
	}

	.tab-strip::-webkit-scrollbar {
		height: 3px;
	}

	.tab-strip::-webkit-scrollbar-thumb {
		background: rgb(148 163 184 / 0.5);
		border-radius: 999px;
	}

	.tab-strip::-webkit-scrollbar-track {
		background: transparent;
	}
</style>
