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
	import { getChatScroll, setChatScroll } from '$frontend/stores/features/chat-workspace.svelte';

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
	// While restoring a saved reading position, suppress the auto-scroll effect so
	// it can't snap to the bottom before applyInitialScroll positions the anchor.
	let suppressAutoScroll = false;

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

	// Persist the session's reading position so returning to the project restores
	// it instead of snapping to the bottom. Uses a message ANCHOR (robust to the
	// virtual window) rather than a raw scrollTop. Skipped while restoring so a
	// transient mid-restore position can't overwrite the saved one.
	function saveReadingPosition(el: HTMLElement) {
		if (appState.isRestoring || suppressAutoScroll) return;
		const sid = sessionState.currentSession?.id;
		if (!sid) return;
		const { scrollTop, scrollHeight, clientHeight } = el;
		const atBottom = scrollTop + clientHeight >= scrollHeight - 200;
		if (atBottom) {
			setChatScroll(sid, { atBottom: true, anchorMessageId: null, anchorOffset: 0 });
		} else {
			const anchor = captureChatAnchor(el);
			setChatScroll(sid, {
				atBottom: false,
				anchorMessageId: anchor?.id ?? null,
				anchorOffset: anchor?.offset ?? 0
			});
		}
	}

	// Debounced "settle" capture. The scroll lock suppresses the synchronous save
	// path so programmatic-scroll echoes can't flip isUserAtBottom — but a genuine
	// user scroll during that window (e.g. scrolling up right after a project
	// switch restores the chat) must still be remembered, otherwise we keep
	// persisting the stale restored position. We can't tell echo from gesture
	// synchronously, so we defer to this capture which reads the FINAL resting
	// position after any programmatic animation settles: for an untouched
	// programmatic scroll that's the bottom (correct), and for a user scroll it's
	// wherever they stopped (correct).
	let saveScrollTimer: ReturnType<typeof setTimeout> | null = null;
	function scheduleReadingPositionSave() {
		if (saveScrollTimer) clearTimeout(saveScrollTimer);
		saveScrollTimer = setTimeout(() => {
			saveScrollTimer = null;
			const el = getScrollEl();
			if (!el) return;
			// The lock has expired by now; refresh isUserAtBottom too so live
			// auto-scroll follows from the user's real position.
			if (Date.now() >= scrollLockUntil) {
				const { scrollTop, scrollHeight, clientHeight } = el;
				isUserAtBottom = scrollTop + clientHeight >= scrollHeight - 200;
			}
			saveReadingPosition(el);
		}, 120);
	}

	// Scroll detection with bottom position tracking + load more triggers
	function handleMessagesScroll() {
		const el = getScrollEl();
		if (!el) return;

		// While the lock is active we can't trust scroll events to reflect user
		// intent (they may be echoes of our own programmatic scroll), so leave
		// isUserAtBottom and load-more untouched — but DO schedule a settle-capture
		// so a real user scroll during the lock still updates the saved position.
		if (Date.now() < scrollLockUntil) {
			scheduleReadingPositionSave();
			return;
		}

		const { scrollTop, scrollHeight, clientHeight } = el;
		const threshold = 200;
		isUserAtBottom = scrollTop + clientHeight >= scrollHeight - threshold;

		// Remember this session's reading position (synchronous in the common,
		// unlocked case so a project switch immediately after still flushes it).
		saveReadingPosition(el);

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
		if (hasInitiallyScrolled && !suppressAutoScroll) {
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

		// Build a hash of all tool results and sub-agent activities to detect changes.
		// Tool results are embedded onto the tool_use block (block.result /
		// block.subActivities) by the grouper, so they never arrive as new entries
		// in filteredMessages — this hash is the only signal that lets auto-scroll
		// follow tool output as it streams in.
		for (const message of filteredMessages) {
			if (!('content' in message) || !Array.isArray(message.content)) continue;
			for (const item of message.content) {
				if (item?.type !== 'tool_use') continue;
				if (item.result) {
					currentToolResultsHash += `${item.id}:${JSON.stringify(item.result).length}|`;
				}
				if (item.subActivities?.length) {
					currentSubAgentHash += `${item.id}:${item.subActivities.length}|`;
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

		// Scroll on new message, partial text changes, tool result changes, or sub-agent updates.
		// Gated on hasInitiallyScrolled so applyInitialScroll() owns the FIRST position:
		// otherwise, on a full refresh (where appState.isRestoring is never set), this
		// effect would snap to the bottom before applyInitialScroll() can restore the
		// saved reading position — clobbering it. After the initial restore, normal
		// auto-scroll resumes. Mirrors the same guard already used for vs.sync above.
		if (
			hasInitiallyScrolled &&
			(isNewMessage || partialTextChanged || toolResultChanged || subAgentChanged) &&
			isUserAtBottom &&
			!suppressAutoScroll
		) {
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

	// Find the message at the top of the viewport (the anchor) and its pixel
	// offset from the container top. Cheap: the virtual window renders few nodes.
	function captureChatAnchor(el: HTMLElement): { id: string; offset: number } | null {
		const containerTop = el.getBoundingClientRect().top;
		const nodes = el.querySelectorAll<HTMLElement>('[data-message-id]');
		for (const node of nodes) {
			const rect = node.getBoundingClientRect();
			if (rect.bottom > containerTop + 4) {
				const id = node.dataset.messageId;
				if (id) return { id, offset: rect.top - containerTop };
			}
		}
		return null;
	}

	// Restore the session's saved reading position, or fall back to the bottom.
	// Only restores when the user had genuinely scrolled up — the common
	// at-bottom case behaves exactly as before. Async: restoring an anchor may
	// require expanding the virtual window and waiting for the DOM to render.
	async function applyInitialScroll(el: HTMLElement) {
		if (editModeState.isEditing) return;
		// Lock scroll detection across the (possibly async) positioning so the
		// scroll events we cause don't flip isUserAtBottom back to true.
		scrollLockUntil = Date.now() + 800;
		const sid = sessionState.currentSession?.id;
		const saved = sid ? getChatScroll(sid) : undefined;

		if (saved && !saved.atBottom && saved.anchorMessageId) {
			const anchorId = saved.anchorMessageId;
			const idx = filteredMessages.findIndex(
				(m) => 'messageId' in m && (m as { messageId?: string }).messageId === anchorId
			);
			if (idx >= 0) {
				isUserAtBottom = false;
				// Pull the anchor into the virtual window, then wait for it to render.
				if (vs.isActive) vs.ensureVisible(idx);
				await tick();

				// Align the anchor to its saved offset, then RE-ALIGN across several
				// frames. Messages use `content-visibility: auto` with a 200px
				// intrinsic-size estimate, so those above the anchor are laid out as
				// short placeholders until they near the viewport — once they render
				// at their real height (often far more than 200px for long messages)
				// they shove the anchor away from where we just put it. Each pass
				// re-measures and corrects until the position stabilizes, keeping the
				// lock raised so these programmatic scrolls aren't mistaken for user
				// input.
				let aligned = false;
				for (let pass = 0; pass < 12; pass++) {
					await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
					const anchorEl = el.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`);
					if (!anchorEl) break;
					scrollLockUntil = Date.now() + 800;
					const offsetNow = anchorEl.getBoundingClientRect().top - el.getBoundingClientRect().top;
					const delta = offsetNow - saved.anchorOffset;
					aligned = true;
					if (Math.abs(delta) <= 1) break;
					el.scrollTop += delta;
				}
				if (aligned) return;
			}
		}

		// Default / fallback: pin to the bottom.
		el.scrollTop = el.scrollHeight;
		isUserAtBottom = true;
	}

	// Handle restoration and initial scroll
	$effect(() => {
		const currentMessages = filteredMessages.length;
		const isRestoring = appState.isRestoring;

		if (isRestoring) {
			// Keep content hidden during restoration. Crucially, suppress the
			// auto-scroll effect NOW (it runs before this effect): otherwise, when
			// the new session's messages load, it would snap to the bottom before
			// applyInitialScroll gets a chance to restore the saved position.
			isContentReady = false;
			hasInitiallyScrolled = false;
			suppressAutoScroll = true;
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

				// Restore the saved reading position (or bottom) while still hidden,
				// then reveal + re-enable auto-scroll once positioned.
				applyInitialScroll(el).then(() => {
					suppressAutoScroll = false;
					requestAnimationFrame(() => {
						isContentReady = true;
					});
				});
			} else if (currentMessages === 0) {
				// No messages, show immediately
				isContentReady = true;
				hasInitiallyScrolled = true;
				suppressAutoScroll = false;
			} else {
				// Wait for container
				setTimeout(() => {
					const el2 = getScrollEl();
					if (el2) {
						vs.reset(filteredMessages.length);
						hasInitiallyScrolled = true;
						applyInitialScroll(el2).then(() => {
							suppressAutoScroll = false;
							isContentReady = true;
						});
					} else {
						suppressAutoScroll = false;
						isContentReady = true;
					}
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

	function handleNavJumpToBottom() {
		const el = getScrollEl();
		if (!el || filteredMessages.length === 0) return;

		const lastIndex = filteredMessages.length - 1;

		// Re-scroll across frames: content-visibility'd items resolve their
		// real height only after they come on-screen, growing scrollHeight.
		const performScroll = () => {
			scrollLockUntil = Date.now() + 600;
			let attempts = 3;
			const step = () => {
				el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
				attempts--;
				if (attempts > 0) {
					requestAnimationFrame(step);
				} else {
					isUserAtBottom = true;
				}
			};
			step();
		};

		if (vs.isActive && (lastIndex < vs.windowStart || lastIndex >= vs.windowEnd)) {
			vs.ensureVisible(lastIndex);
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
			if (saveScrollTimer) clearTimeout(saveScrollTimer);
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
			{isUserAtBottom}
			onJump={handleNavJump}
			onJumpToBottom={handleNavJumpToBottom}
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
