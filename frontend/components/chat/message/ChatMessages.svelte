<script lang="ts">
	import { sessionState } from '$frontend/stores/core/sessions.svelte';
	import { appState } from '$frontend/stores/core/app.svelte';
	import ChatMessage from './ChatMessage.svelte';
	import DateSeparator from './DateSeparator.svelte';
	import ChatNavigationRail, { type NavItem } from './ChatNavigationRail.svelte';
	import { onMount, tick } from 'svelte';
	import { fade } from 'svelte/transition';

	// Import utilities
	import { shouldFilterMessage } from '$frontend/utils/chat/message-processor';
	import { groupMessages, embedToolResults } from '$frontend/utils/chat/message-grouper';
	import { addDateSeparators, type DateSeparatorItem } from '$frontend/utils/chat/date-separator';
	import { editModeState } from '$frontend/stores/ui/edit-mode.svelte';
	import { createVirtualScroll, VS_CONFIG_CLASSIC, VS_CONFIG_COMPACT } from '$frontend/utils/chat/virtual-scroll.svelte';
	import { settings } from '$frontend/stores/features/settings.svelte';

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
	let lastSubAgentHash = $state('');
	// Prevent scroll events from overriding isUserAtBottom during programmatic scroll
	let scrollLockUntil = 0;

	// ========================================
	// VIRTUAL SCROLL
	// ========================================

	const vs = createVirtualScroll(() => settings.chatAppearance === 'compact' ? VS_CONFIG_COMPACT : VS_CONFIG_CLASSIC);
	let isLoadingOlder = $state(false);

	// ========================================
	// MESSAGE PROCESSING (full pipeline on all messages)
	// ========================================

	// Process messages through grouping and embedding
	const processedMessages = $derived.by(() => {
		const { groups, toolUseMap, subAgentMap, skillPromptMap } = groupMessages(sessionState.messages);
		return embedToolResults(groups, toolUseMap, subAgentMap, skillPromptMap);
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
		return 'messageId' in lastUserMsg ? lastUserMsg.messageId : undefined;
	});

	// Extract first text snippet from a user message (for nav preview)
	function extractUserText(message: any): string {
		const content = message?.content;
		if (!Array.isArray(content)) return '';
		for (const item of content) {
			if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
				return item.text;
			}
		}
		return '';
	}

	// Nav items for ChatNavigationRail — only real user messages (no synthetic / sub-agent prompts)
	const userNavItems = $derived.by<NavItem[]>(() => {
		const result: NavItem[] = [];
		filteredMessages.forEach((msg, globalIndex) => {
			if (msg.type !== 'user') return;
			if ((msg as any).synthetic) return;
			const parentToolUseId = (msg as any).parent?.toolUseId;
			if (parentToolUseId) return;
			const messageId = 'messageId' in msg ? msg.messageId : undefined;
			const text = extractUserText(msg);
			if (!messageId || !text) return;
			const sender = (msg as any).sender?.name as string | undefined;
			result.push({ globalIndex, messageId, text, sender });
		});
		return result;
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

	// Scroll detection with bottom position tracking + load more triggers
	function handleMessagesScroll() {
		// Don't override isUserAtBottom during/after a programmatic scroll
		if (Date.now() < scrollLockUntil) return;

		const el = getScrollEl();
		if (!el) return;

		const { scrollTop, scrollHeight, clientHeight } = el;
		const threshold = 200;
		isUserAtBottom = scrollTop + clientHeight >= scrollHeight - threshold;

		if (!vs.isActive) return;

		const margin = vs.loadMoreMargin;

		// Load older messages when near top
		if (scrollTop <= margin && vs.hasMoreAbove && !isLoadingOlder) {
			isLoadingOlder = true;

			const prevScrollHeight = el.scrollHeight;
			const prevScrollTop = el.scrollTop;

			const added = vs.expandUp();
			if (added > 0) {
				// Phase 1: DOM updates with expanded window (no trim yet)
				tick().then(() => {
					requestAnimationFrame(() => {
						// Restore scroll position based on content added at top
						const heightAdded = el.scrollHeight - prevScrollHeight;
						el.scrollTop = prevScrollTop + heightAdded;
						// Lock scroll to prevent re-triggering from programmatic scroll
						scrollLockUntil = Date.now() + 200;

						// Phase 2: trim bottom after scroll is settled
						requestAnimationFrame(() => {
							vs.trimBottom();
							setTimeout(() => { isLoadingOlder = false; }, 150);
						});
					});
				});
			} else {
				isLoadingOlder = false;
			}
		}

		// Load newer messages when near bottom
		const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
		if (distanceFromBottom <= margin && vs.hasMoreBelow) {
			vs.expandDown();
			// Trim top immediately — removed content is above viewport
			vs.trimTop();
		}
	}

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
			if ('type' in msg && msg.type === 'stream_event' && 'text' in msg) {
				hasStreamingMessage = true;
				currentPartialHash += `${(msg as any).text?.length || 0}:`;
			}
		}
		if (currentPartialHash !== lastPartialTextHash) {
			if (currentPartialHash !== '') partialTextChanged = true;
			lastPartialTextHash = currentPartialHash;
		}

		// Check for tool result updates ($result additions) across all messages
		let toolResultChanged = false;
		let currentToolResultsHash = '';
		let subAgentChanged = false;
		let currentSubAgentHash = '';

		// Build a hash of all tool results and sub-agent activities to detect changes
		for (const message of filteredMessages) {
			if ('message' in message) {
				const messageContent = (message as any).message?.content;
				if (Array.isArray(messageContent)) {
					for (const item of messageContent) {
						if (item?.type === 'tool_use' && item.$result) {
							currentToolResultsHash += `${item.id}:${JSON.stringify(item.$result).length}|`;
						}
						if (item?.type === 'tool_use' && item.$subMessages) {
							currentSubAgentHash += `${item.id}:${item.$subMessages.length}|`;
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

		// Check if sub-agent activities have changed
		if (currentSubAgentHash !== lastSubAgentHash) {
			subAgentChanged = true;
			lastSubAgentHash = currentSubAgentHash;
		}

		// When message count decreases (e.g. after undo/reload), scroll to bottom
		if (isMessageCountDecreased && hasInitiallyScrolled) {
			requestAnimationFrame(() => {
				scrollMessagesToBottom(false);
			});
			previousMessageCount = currentMessageCount;
			return;
		}

		// Scroll on new message, partial text changes, tool result changes, or sub-agent updates
		if ((isNewMessage || partialTextChanged || toolResultChanged || subAgentChanged) && isUserAtBottom) {
			requestAnimationFrame(() => {
				if (editModeState.isEditing) return;

				// During streaming, scroll immediately (instant via scrollMessagesToBottom)
				// For non-streaming changes, add a small delay for smooth UX
				if (partialTextChanged || hasStreamingMessage || subAgentChanged) {
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

	const isCompact = $derived(settings.chatAppearance === 'compact');

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
			const msgIndex = filteredMessages.findIndex(m => 'messageId' in m ? m.messageId === messageId : false);
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
	// NAV RAIL: JUMP TO USER MESSAGE
	// ========================================

	function handleNavJump(item: NavItem) {
		const el = getScrollEl();
		if (!el) return;

		// Lock scroll detection so jump doesn't flip isUserAtBottom incorrectly
		scrollLockUntil = Date.now() + 400;

		const performScroll = () => {
			const target = el.querySelector<HTMLElement>(`[data-message-id="${item.messageId}"]`);
			if (target) {
				const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 24;
				el.scrollTo({ top, behavior: 'auto' });
			}
		};

		if (vs.isActive && (item.globalIndex < vs.windowStart || item.globalIndex >= vs.windowEnd)) {
			vs.ensureVisible(item.globalIndex);
			tick().then(() => {
				requestAnimationFrame(performScroll);
			});
		} else {
			performScroll();
		}
	}

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
			if (currentListenerEl) {
				currentListenerEl.removeEventListener('scroll', handleMessagesScroll);
			}
			hasInitiallyScrolled = false;
		};
	});
</script>

<div class="flex flex-col h-full" style="position: relative">
	<!-- User-message navigation rail (side dots) -->
	{#if isContentReady}
		<ChatNavigationRail
			scrollEl={messagesScrollEl}
			items={userNavItems}
			onJump={handleNavJump}
		/>
	{/if}

	<!-- Messages container -->
	<div
		bind:this={messagesScrollEl}
		class="flex-1 overflow-y-auto pt-3 pb-14 lg:pb-16 px-3 lg:px-4 {isContentReady ? '' : 'invisible'}"
		style="{!isContentReady ? 'scroll-behavior: auto' : ''}">

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
				<div class={isCompact ? '' : 'chat-item'}>
					{#if item.type === 'date'}
						<DateSeparator date={item.data} />
					{:else if item.type === 'message'}
						{@const messageId = 'messageId' in item.data ? item.data.messageId : undefined}
						{@const isLastUser = messageId === lastUserMessageId}
						<div class={isCompact ? 'mb-2' : 'mb-2 lg:mb-4'} data-message-id={messageId}>
							<ChatMessage message={item.data} isLastUserMessage={isLastUser} />
						</div>
					{/if}
				</div>
			{:else}
				<!-- Normal transition for new messages -->
				<div class={isCompact ? '' : 'chat-item'} in:fade={{ duration: 300, delay: 0 }} out:fade={{ duration: 200 }}>
					{#if item.type === 'date'}
						<DateSeparator date={item.data} />
					{:else if item.type === 'message'}
						{@const messageId = 'messageId' in item.data ? item.data.messageId : undefined}
						{@const isLastUser = messageId === lastUserMessageId}
						<div class={isCompact ? 'mb-2' : 'mb-2 lg:mb-4'} data-message-id={messageId}>
							<ChatMessage message={item.data} isLastUserMessage={isLastUser} />
						</div>
					{/if}
				</div>
			{/if}
		{/each}

	</div>
</div>

<style>
	.chat-item {
		content-visibility: auto;
		contain-intrinsic-size: auto 200px;
	}
</style>
