<script lang="ts">
	import { sessionState } from '$frontend/lib/stores/core/sessions.svelte';
	import { appState } from '$frontend/lib/stores/core/app.svelte';
	import ChatMessage from './ChatMessage.svelte';
	import DateSeparator from './DateSeparator.svelte';
	import { onMount, tick } from 'svelte';
	import { fade } from 'svelte/transition';

	// Import utilities
	import { shouldFilterMessage } from '$frontend/lib/utils/chat/message-processor';
	import { groupMessages, embedToolResults } from '$frontend/lib/utils/chat/message-grouper';
	import { addDateSeparators, type DateSeparatorItem } from '$frontend/lib/utils/chat/date-separator';
	import { editModeState } from '$frontend/lib/stores/ui/edit-mode.svelte';
	import { createVirtualScroll, VS_CONFIG } from '$frontend/lib/utils/chat/virtual-scroll.svelte';

	interface Props {
		scrollContainer?: HTMLElement | undefined;
	}

	const { scrollContainer }: Props = $props();

	// Internal scroll element - this is the actual scrollable div
	let messagesScrollEl: HTMLElement | undefined = $state();

	let previousMessageCount = $state(0);
	let isUserAtBottom = $state(true);
	let lastPartialTextHash = $state('');
	let hasInitiallyScrolled = $state(false);
	let isContentReady = $state(false);
	let lastToolResultsHash = $state('');
	// Prevent scroll events from overriding isUserAtBottom during programmatic scroll
	let scrollLockUntil = 0;

	// ========================================
	// VIRTUAL SCROLL
	// ========================================

	const vs = createVirtualScroll();
	let topSentinelEl: HTMLElement | undefined = $state();
	let bottomSentinelEl: HTMLElement | undefined = $state();
	let topObserver: IntersectionObserver | null = null;
	let bottomObserver: IntersectionObserver | null = null;
	let isLoadingOlder = $state(false);

	// ========================================
	// MESSAGE PROCESSING (full pipeline on all messages)
	// ========================================

	// Process messages through grouping and embedding
	const processedMessages = $derived.by(() => {
		const { groups, toolUseMap } = groupMessages(sessionState.messages);
		return embedToolResults(groups, toolUseMap);
	});

	// Filter out messages with empty content arrays
	const filteredMessages = $derived(
		processedMessages.filter(message => !shouldFilterMessage(message))
	);

	// Windowed slice for rendering
	const windowedMessages = $derived.by(() => {
		if (!vs.isActive) return filteredMessages;
		return filteredMessages.slice(vs.windowStart, vs.windowEnd);
	});

	// Add date separators to windowed messages (with global index offset for stable keys)
	const messagesWithDateSeparators = $derived.by((): DateSeparatorItem[] => {
		return addDateSeparators(windowedMessages, vs.isActive ? vs.windowStart : 0);
	});

	// Get last user message ID for undo button logic
	const lastUserMessageId = $derived.by(() => {
		const userMessages = filteredMessages.filter(m => m.type === 'user');
		if (userMessages.length === 0) return undefined;
		const lastUserMsg = userMessages[userMessages.length - 1];
		return lastUserMsg.metadata?.message_id;
	});

	// ========================================
	// SCROLL HELPERS
	// ========================================

	/**
	 * Resolve the best scroll container:
	 * - Use our own internal messagesScrollEl (which has overflow-y-auto)
	 * - Fall back to external scrollContainer from PageTemplate
	 */
	function getScrollEl(): HTMLElement | undefined {
		return messagesScrollEl ?? scrollContainer;
	}

	// Auto-scroll to bottom when new messages arrive
	function scrollMessagesToBottom(smooth = true) {
		const el = getScrollEl();
		if (el) {
			// During streaming, always use instant scroll to avoid jitter
			// caused by smooth animation being outpaced by rapid DOM updates
			const useSmooth = smooth && !appState.isLoading;
			el.scrollTo({
				top: el.scrollHeight,
				behavior: useSmooth ? 'smooth' : 'auto'
			});
			// Immediately mark as at bottom after programmatic scroll
			isUserAtBottom = true;
			// Lock scroll detection briefly so scroll events fired during
			// the programmatic scroll don't override isUserAtBottom
			scrollLockUntil = Date.now() + 150;
		}
	}

	// Scroll detection with bottom position tracking
	function handleMessagesScroll() {
		// Don't override isUserAtBottom during/after a programmatic scroll
		if (Date.now() < scrollLockUntil) return;

		const el = getScrollEl();
		if (el) {
			const { scrollTop, scrollHeight, clientHeight } = el;
			const threshold = 200;
			isUserAtBottom = scrollTop + clientHeight >= scrollHeight - threshold;
		}
	}

	// ========================================
	// VIRTUAL SCROLL: SENTINELS & OBSERVERS
	// ========================================

	function onTopSentinelVisible() {
		if (!vs.hasMoreAbove || isLoadingOlder) return;
		isLoadingOlder = true;

		const el = getScrollEl();
		if (!el) { isLoadingOlder = false; return; }

		// Capture scroll state before expanding window
		const prevScrollHeight = el.scrollHeight;
		const prevScrollTop = el.scrollTop;

		const added = vs.expandUp();
		if (added > 0) {
			// After DOM updates, restore scroll position so content doesn't jump
			tick().then(() => {
				requestAnimationFrame(() => {
					const newScrollHeight = el.scrollHeight;
					const heightAdded = newScrollHeight - prevScrollHeight;
					el.scrollTop = prevScrollTop + heightAdded;

					setTimeout(() => { isLoadingOlder = false; }, 150);

					// Trim bottom if window grew too large and not streaming
					if (vs.windowEnd - vs.windowStart > VS_CONFIG.TRIM_THRESHOLD && !appState.isLoading) {
						vs.trimBottom();
					}
				});
			});
		} else {
			isLoadingOlder = false;
		}
	}

	function onBottomSentinelVisible() {
		if (!vs.hasMoreBelow) return;

		vs.expandDown();

		// Trim top if window grew too large
		if (vs.windowEnd - vs.windowStart > VS_CONFIG.TRIM_THRESHOLD) {
			vs.trimTop();
		}
	}

	function setupObservers() {
		cleanupObservers();

		if (!vs.isActive) return;

		const root = getScrollEl();
		if (!root) return;

		topObserver = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) onTopSentinelVisible();
			},
			{ root, rootMargin: '200px 0px 0px 0px', threshold: 0 }
		);

		bottomObserver = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) onBottomSentinelVisible();
			},
			{ root, rootMargin: '0px 0px 200px 0px', threshold: 0 }
		);

		if (topSentinelEl) topObserver.observe(topSentinelEl);
		if (bottomSentinelEl) bottomObserver.observe(bottomSentinelEl);
	}

	function cleanupObservers() {
		topObserver?.disconnect();
		bottomObserver?.disconnect();
		topObserver = null;
		bottomObserver = null;
	}

	// Re-setup observers when elements or activation state changes
	$effect(() => {
		const active = vs.isActive;
		topSentinelEl;
		bottomSentinelEl;
		messagesScrollEl;

		if (active && messagesScrollEl) {
			setupObservers();
		} else {
			cleanupObservers();
		}
	});

	// ========================================
	// AUTO-SCROLL & VIRTUAL SCROLL SYNC
	// ========================================

	// Auto-scroll: track message count and partial message updates
	$effect(() => {
		const currentMessageCount = filteredMessages.length;
		const isNewMessage = currentMessageCount > previousMessageCount;
		const isMessageCountDecreased = currentMessageCount < previousMessageCount;

		// Sync virtual scroll with message count changes
		if (hasInitiallyScrolled) {
			if (isMessageCountDecreased) {
				vs.reset(currentMessageCount);
			} else if (isNewMessage) {
				vs.sync(currentMessageCount, isUserAtBottom, appState.isLoading);
			}
		}

		// Track partial text changes across ALL streaming messages (not just the last)
		// This handles reasoning + text streams both being active simultaneously
		let partialTextChanged = false;
		let hasStreamingMessage = false;
		let currentPartialHash = '';
		for (const msg of filteredMessages) {
			if ('type' in msg && msg.type === 'stream_event' && 'partialText' in msg) {
				hasStreamingMessage = true;
				currentPartialHash += `${(msg as any).partialText?.length || 0}:`;
			}
		}
		if (currentPartialHash !== lastPartialTextHash) {
			if (currentPartialHash !== '') partialTextChanged = true;
			lastPartialTextHash = currentPartialHash;
		}

		// Check for tool result updates ($result additions) across all messages
		let toolResultChanged = false;
		let currentToolResultsHash = '';

		// Build a hash of all tool results to detect changes
		for (const message of filteredMessages) {
			if ('message' in message) {
				const messageContent = (message as any).message?.content;
				if (Array.isArray(messageContent)) {
					for (const item of messageContent) {
						if (item?.type === 'tool_use' && item.$result) {
							currentToolResultsHash += `${item.id}:${JSON.stringify(item.$result).length}|`;
						}
					}
				}
			}
		}

		// Check if tool results have changed
		if (currentToolResultsHash !== lastToolResultsHash) {
			toolResultChanged = true;
			lastToolResultsHash = currentToolResultsHash;
		}

		// When message count decreases (e.g. after undo/reload), scroll to bottom
		if (isMessageCountDecreased && hasInitiallyScrolled) {
			requestAnimationFrame(() => {
				scrollMessagesToBottom(false);
			});
			previousMessageCount = currentMessageCount;
			return;
		}

		// Scroll on new message, partial text changes, or tool result changes
		if ((isNewMessage || partialTextChanged || toolResultChanged) && isUserAtBottom) {
			requestAnimationFrame(() => {
				if (editModeState.isEditing) return;

				// During streaming, scroll immediately (instant via scrollMessagesToBottom)
				// For non-streaming changes, add a small delay for smooth UX
				if (partialTextChanged || hasStreamingMessage) {
					scrollMessagesToBottom(false);
				} else {
					const delay = toolResultChanged ? 50 : 100;
					setTimeout(() => {
						if (!editModeState.isEditing) {
							scrollMessagesToBottom(true);
						}
					}, delay);
				}
			});
		}

		// Reset partial text hash when not streaming
		if (!hasStreamingMessage && lastPartialTextHash !== '') {
			lastPartialTextHash = '';
		}

		previousMessageCount = currentMessageCount;
	});

	// ========================================
	// TRANSITIONS & SCROLL LISTENERS
	// ========================================

	// Track if we should disable transitions (during restoration)
	const disableTransitions = $derived(appState.isRestoring || (!hasInitiallyScrolled && filteredMessages.length > 5));

	// Update scroll event listener when internal scroll element changes
	let currentListenerEl: HTMLElement | null = null;
	$effect(() => {
		const el = messagesScrollEl ?? scrollContainer;

		// Remove old listener if exists
		if (currentListenerEl && currentListenerEl !== el) {
			currentListenerEl.removeEventListener('scroll', handleMessagesScroll);
		}

		// Add new listener
		if (el && el !== currentListenerEl) {
			el.addEventListener('scroll', handleMessagesScroll, { passive: true });
			currentListenerEl = el;
		}
	});

	// ========================================
	// RESTORATION & INITIAL SCROLL
	// ========================================

	// Handle restoration and initial scroll
	$effect(() => {
		const currentMessages = filteredMessages.length;
		const isRestoring = appState.isRestoring;

		if (isRestoring) {
			// Keep content hidden during restoration
			isContentReady = false;
			hasInitiallyScrolled = false;
			return;
		}

		// Restoration complete
		if (!isRestoring && !hasInitiallyScrolled) {
			const el = getScrollEl();
			if (currentMessages > 0 && el) {
				// Mark as scrolled
				hasInitiallyScrolled = true;
				previousMessageCount = currentMessages;

				// Initialize virtual scroll
				vs.reset(currentMessages);

				// Scroll to bottom immediately (while still hidden)
				// Skip if edit mode is active - scroll-to-edit-message will handle positioning
				if (!editModeState.isEditing) {
					el.scrollTop = el.scrollHeight;
				}

				// Show content after a micro delay to ensure scroll is set
				requestAnimationFrame(() => {
					isContentReady = true;
				});
			} else if (currentMessages === 0) {
				// No messages, show immediately
				isContentReady = true;
				hasInitiallyScrolled = true;
			} else {
				// Wait for container
				setTimeout(() => {
					const el2 = getScrollEl();
					if (el2) {
						vs.reset(filteredMessages.length);
						el2.scrollTop = el2.scrollHeight;
						hasInitiallyScrolled = true;
					}
					isContentReady = true;
				}, 50);
			}
		}
	});

	// ========================================
	// EDIT MODE: SCROLL TO EDITED MESSAGE
	// ========================================

	// Auto-scroll to edited message when edit mode is activated (including refresh/project switch)
	let lastEditMessageId: string | null = null;

	function scrollToEditedMessage(messageId: string, retries = 10) {
		if (!messagesScrollEl || !isContentReady) {
			// Container not ready yet (refresh/project switch), retry
			if (retries > 0) {
				setTimeout(() => scrollToEditedMessage(messageId, retries - 1), 200);
			}
			return;
		}

		// Ensure message is within the virtual scroll window
		if (vs.isActive) {
			const msgIndex = filteredMessages.findIndex(m => m.metadata?.message_id === messageId);
			if (msgIndex >= 0 && (msgIndex < vs.windowStart || msgIndex >= vs.windowEnd)) {
				vs.ensureVisible(msgIndex);
				// Wait for DOM to update after window change
				tick().then(() => {
					requestAnimationFrame(() => {
						const el = messagesScrollEl?.querySelector(`[data-message-id="${messageId}"]`);
						if (el) {
							el.scrollIntoView({ behavior: 'smooth', block: 'center' });
						}
					});
				});
				return;
			}
		}

		const el = messagesScrollEl.querySelector(`[data-message-id="${messageId}"]`);
		if (el) {
			el.scrollIntoView({ behavior: 'smooth', block: 'center' });
		} else if (retries > 0) {
			// Messages might not be rendered yet, retry
			setTimeout(() => scrollToEditedMessage(messageId, retries - 1), 200);
		}
	}

	$effect(() => {
		const editMessageId = editModeState.isEditing ? editModeState.messageId : null;

		if (editMessageId && editMessageId !== lastEditMessageId) {
			// Wait for DOM to update then scroll to the edited message
			requestAnimationFrame(() => {
				scrollToEditedMessage(editMessageId);
			});
		}

		lastEditMessageId = editMessageId;
	});

	// ========================================
	// LIFECYCLE
	// ========================================

	onMount(() => {
		// Reset flags on mount
		hasInitiallyScrolled = false;

		// Start with content hidden if restoring
		if (appState.isRestoring) {
			isContentReady = false;
		} else {
			// Not restoring, check if we need to scroll
			const el = getScrollEl();
			if (filteredMessages.length > 0 && el) {
				// Initialize virtual scroll and scroll immediately
				vs.reset(filteredMessages.length);
				el.scrollTop = el.scrollHeight;
				hasInitiallyScrolled = true;
				isContentReady = true;
			} else {
				// No messages or no container yet, just show
				isContentReady = true;
			}
		}

		// Cleanup on component destroy
		return () => {
			cleanupObservers();
			if (currentListenerEl) {
				currentListenerEl.removeEventListener('scroll', handleMessagesScroll);
			}
			hasInitiallyScrolled = false;
		};
	});
</script>

<div class="flex flex-col h-full" style="position: relative">
	<!-- Messages container -->
	<div
		bind:this={messagesScrollEl}
		class="flex-1 overflow-y-auto pt-3 pb-14 lg:pb-16 px-3 lg:px-4 {isContentReady ? '' : 'invisible'}"
		style="{!isContentReady ? 'scroll-behavior: auto' : ''}">

		<!-- Top sentinel for virtual scroll (always present, observed only when active) -->
		<div bind:this={topSentinelEl} class="h-px w-full" aria-hidden="true"></div>

		<!-- Loading older messages indicator -->
		{#if isLoadingOlder}
			<div class="flex justify-center py-3">
				<div class="flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
					<div class="w-3 h-3 border-2 border-slate-300 dark:border-slate-600 border-t-transparent rounded-full animate-spin"></div>
					<span>Loading older messages...</span>
				</div>
			</div>
		{/if}

		{#each messagesWithDateSeparators as item (item.key)}
			{#if disableTransitions}
				<!-- No transition during restoration or initial load with many messages -->
				<div>
					{#if item.type === 'date'}
						<DateSeparator date={item.data} />
					{:else if item.type === 'message'}
						{@const messageId = item.data.metadata?.message_id}
						{@const isLastUser = messageId === lastUserMessageId}
						<div class="mb-2 lg:mb-4" data-message-id={messageId}>
							<ChatMessage message={item.data} isLastUserMessage={isLastUser} />
						</div>
					{/if}
				</div>
			{:else}
				<!-- Normal transition for new messages -->
				<div in:fade={{ duration: 300, delay: 0 }} out:fade={{ duration: 200 }}>
					{#if item.type === 'date'}
						<DateSeparator date={item.data} />
					{:else if item.type === 'message'}
						{@const messageId = item.data.metadata?.message_id}
						{@const isLastUser = messageId === lastUserMessageId}
						<div class="mb-2 lg:mb-4" data-message-id={messageId}>
							<ChatMessage message={item.data} isLastUserMessage={isLastUser} />
						</div>
					{/if}
				</div>
			{/if}
		{/each}

		<!-- Bottom sentinel for virtual scroll -->
		<div bind:this={bottomSentinelEl} class="h-px w-full" aria-hidden="true"></div>
	</div>
</div>
