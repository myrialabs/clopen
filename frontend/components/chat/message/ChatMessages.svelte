<script lang="ts">
	import { sessionState, fetchOlderPage, applyOlderPage, isMessageLoaded } from '$frontend/stores/core/sessions.svelte';
	import { appState } from '$frontend/stores/core/app.svelte';
	import ChatMessage from './ChatMessage.svelte';
	import DateSeparator from './DateSeparator.svelte';
	import ChatNavigationRail, { type NavItem } from './ChatNavigationRail.svelte';
	import { onMount, tick } from 'svelte';

	// Import utilities
	import { shouldFilterMessage } from '$frontend/utils/chat/message-processor';
	import { groupMessages, embedToolResults } from '$frontend/utils/chat/message-grouper';
	import { addDateSeparators, type DateSeparatorItem } from '$frontend/utils/chat/date-separator';
	import { editModeState } from '$frontend/stores/ui/edit-mode.svelte';
	import { createVirtualScroll, VS_CONFIG_CLASSIC, VS_CONFIG_COMPACT } from '$frontend/utils/chat/virtual-scroll.svelte';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import { getChatScroll, setChatScroll } from '$frontend/stores/features/chat-workspace.svelte';
	import { flushWorkspaceSave } from '$frontend/stores/ui/project-workspace.svelte';

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

	/**
	 * Added to every item's index to form its render key. Keys are positional
	 * (a streaming placeholder must keep its key when the final message replaces
	 * it), so inserting an older page at the front would shift every key and
	 * rebuild the whole list. Lowering the offset by the number of inserted items
	 * keeps each existing item's key — and its DOM — exactly as it was.
	 */
	let keyOffset = $state(0);

	/** Start the window and the keys over for a list that was replaced, not extended. */
	function resetView(count: number) {
		vs.reset(count);
		keyOffset = 0;
		keptAnchor = null;
	}

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

	/** Index in filteredMessages of the first rendered message. */
	const windowBase = $derived(vs.isActive ? vs.windowStart : 0);

	// Add date separators to windowed messages (with global index offset for stable keys)
	const messagesWithDateSeparators = $derived.by((): DateSeparatorItem[] => {
		return addDateSeparators(windowedMessages, keyOffset + windowBase);
	});

	// Whether a message participates in the compact timeline rail (agent / reasoning)
	function isRailRole(message: any): boolean {
		if (!message) return false;
		if (message.type === 'reasoning') return true;
		if (message.type === 'stream_event') return Boolean(message.reasoning);
		if (message.type === 'assistant' && Array.isArray(message.content)) {
			return message.content.some((c: any) => c.type === 'tool_use');
		}
		return false;
	}

	// Per-message rail connection flags (whether to bridge the rail up/down to neighbours)
	const railFlagsByKey = $derived.by(() => {
		const items = messagesWithDateSeparators;
		const map = new Map<string, { up: boolean; down: boolean }>();
		for (let i = 0; i < items.length; i++) {
			const it = items[i];
			if (it.type !== 'message') continue;
			if (!isRailRole(it.data)) continue;
			const prev = items[i - 1];
			const next = items[i + 1];
			const up = prev?.type === 'message' && isRailRole(prev.data);
			const down = next?.type === 'message' && isRailRole(next.data);
			map.set(it.key, { up, down });
		}
		return map;
	});

	// Get last user message ID for undo button logic. Excludes synthetic
	// (engine-generated) user messages — e.g. Codex inline error notices —
	// which are never something the human actually typed and shouldn't count
	// as "the last turn" for undo purposes.
	const lastUserMessageId = $derived.by(() => {
		const userMessages = filteredMessages.filter(m => m.type === 'user' && !(m as any).synthetic);
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

	// Nav items for ChatNavigationRail — every real user prompt on the branch, loaded
	// or not: the server's prompt index covers the pages not loaded yet, and the
	// loaded messages add whatever was sent since the index was read.
	const userNavItems = $derived.by<NavItem[]>(() => {
		const loaded = new Map<string, { globalIndex: number; text: string }>();
		filteredMessages.forEach((msg, globalIndex) => {
			if (msg.type !== 'user') return;
			if ((msg as any).synthetic) return;
			const parentToolUseId = (msg as any).parent?.toolUseId;
			if (parentToolUseId) return;
			const messageId = 'messageId' in msg ? msg.messageId : undefined;
			const text = extractUserText(msg);
			if (!messageId || !text) return;
			loaded.set(messageId, { globalIndex, text });
		});

		const result: NavItem[] = [];
		const seen = new Set<string>();
		for (const entry of sessionState.promptIndex) {
			if (!entry.text.trim()) continue;
			const hit = loaded.get(entry.messageId);
			result.push({ globalIndex: hit?.globalIndex ?? -1, messageId: entry.messageId, text: hit?.text ?? entry.text });
			seen.add(entry.messageId);
		}
		// Loaded prompts the index does not list (sent since it was read) go right
		// after the nearest loaded prompt before them, keeping the rail in order.
		for (const [messageId, hit] of loaded) {
			if (seen.has(messageId)) continue;
			let at = result.length;
			for (let i = result.length - 1; i >= 0; i--) {
				const gi = result[i].globalIndex;
				if (gi < 0) continue;
				if (gi < hit.globalIndex) break;
				at = i;
			}
			result.splice(at, 0, { globalIndex: hit.globalIndex, messageId, text: hit.text });
		}
		return result;
	});

	// ========================================
	// OLDER PAGES
	// ========================================

	/**
	 * Fetch the next older page and put it in front of the list without moving
	 * anything on screen: the window and the keys shift by the number of items
	 * added, in the same synchronous step as the insert, so the DOM is untouched
	 * and the auto-scroll effect does not see "new messages". Returns how many
	 * list items were added, or null when no page came back. With `untilId` the
	 * page reaches back to that message in the same request.
	 */
	async function loadOlderPage(untilId?: string): Promise<number | null> {
		const page = await fetchOlderPage(untilId);
		if (!page) return null;
		const before = filteredMessages.length;
		if (applyOlderPage(page) === 0) return 0;
		const added = filteredMessages.length - before;
		if (added > 0) {
			keyOffset -= added;
			vs.prepend(added);
		}
		previousMessageCount = filteredMessages.length;
		return added;
	}

	/**
	 * Load back to a message. True when it is (or already was) loaded. Usually
	 * one request; a loop only because a page already in flight (a prefetch) is
	 * shared and may stop short of the message.
	 */
	async function ensureMessageLoaded(messageId: string): Promise<boolean> {
		for (let guard = 0; guard < 50 && !isMessageLoaded(messageId); guard++) {
			if (!sessionState.hasOlderMessages) return false;
			if ((await loadOlderPage(messageId)) === null) break;
		}
		return isMessageLoaded(messageId);
	}

	/**
	 * Page the server in the background while the user is still a few screens
	 * away from the top, so the next page is usually there before they reach it.
	 * Applying it is invisible: the window shifts with the insert.
	 */
	let isPrefetchingOlder = false;
	function prefetchOlderIfNear(el: HTMLElement) {
		if (isPrefetchingOlder || !sessionState.hasOlderMessages) return;
		const hiddenAbove = vs.isActive ? vs.windowStart : 0;
		if (hiddenAbove > vs.bufferSize * 2) return;
		if (el.scrollTop > Math.max(vs.loadMoreMargin * 3, el.clientHeight * 1.5)) return;
		isPrefetchingOlder = true;
		void loadOlderPage()
			.catch(() => null)
			.finally(() => {
				isPrefetchingOlder = false;
			});
	}

	/** Index of a message in the rendered list, or -1. */
	function indexOfMessage(messageId: string): number {
		return filteredMessages.findIndex((m) => 'messageId' in m && (m as { messageId?: string }).messageId === messageId);
	}

	/**
	 * A first page that does not fill the viewport cannot be scrolled, so the
	 * scroll-driven load would never fire: page back until it can (or there is
	 * nothing older), keeping the bottom where it was.
	 */
	async function fillViewportIfShort() {
		const el = getScrollEl();
		if (!el) return;
		for (let guard = 0; guard < 20; guard++) {
			const short = el.scrollHeight <= el.clientHeight + vs.loadMoreMargin;
			if (!short) return;
			if (vs.isActive && vs.hasMoreAbove) {
				vs.expandUp();
			} else if (sessionState.hasOlderMessages) {
				if (!(await loadOlderPage())) return;
				if (vs.isActive && vs.hasMoreAbove) vs.expandUp();
			} else {
				return;
			}
			await tick();
			if (isUserAtBottom) el.scrollTop = el.scrollHeight;
		}
	}

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

	/**
	 * Whether the reader is at the end of the chat: near the bottom of what is
	 * rendered AND nothing newer is held back by the window. Near the bottom of
	 * an older window is not "at the bottom" — following new messages from there
	 * would yank the window to the end.
	 */
	function isAtBottom(el: HTMLElement, threshold = 200): boolean {
		if (vs.hasMoreBelow) return false;
		return el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
	}

	// Auto-scroll to bottom when new messages arrive
	function scrollMessagesToBottom(smooth = true) {
		const el = getScrollEl();
		if (el) {
			// The anchor keeper must pin to the bottom while this (possibly smooth)
			// scroll is still on its way there.
			pinIntentUntil = Date.now() + 600;
			keptPinned = true;
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
		const atBottom = isAtBottom(el);
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
			if (Date.now() >= scrollLockUntil) isUserAtBottom = isAtBottom(el);
			saveReadingPosition(el);
		}, 120);
	}

	/**
	 * The page is going away (refresh, tab closed or hidden): take the pending
	 * settle capture now and push the save out, rather than lose the last bit of
	 * scrolling to the two debounces in between.
	 */
	function flushReadingPosition(event: Event) {
		if (event.type === 'visibilitychange' && document.visibilityState !== 'hidden') return;
		if (saveScrollTimer) {
			clearTimeout(saveScrollTimer);
			saveScrollTimer = null;
			const el = getScrollEl();
			if (el) saveReadingPosition(el);
		}
		flushWorkspaceSave();
	}

	// ========================================
	// ANCHOR KEEPER
	// ========================================

	/**
	 * Keeps what the reader is looking at in place whenever the content changes
	 * size: the window revealing or trimming items at either end, an older page
	 * landing, markdown/code/images finishing their render, the panel resizing.
	 *
	 * The browser's own scroll anchoring is switched off (`overflow-anchor:
	 * none`) — Safari has none at all, and two mechanisms correcting the same
	 * scroll fight each other. Instead the first visible message is recorded on
	 * every scroll, and a ResizeObserver on the list puts it back at the same
	 * offset before the frame is painted. Changes below the anchor move nothing,
	 * so they cost nothing. A reader pinned to the bottom stays pinned instead.
	 */
	let keptAnchor: { id: string; offset: number } | null = null;
	let keptPinned = true;
	/** A programmatic scroll to the bottom is in progress — keep pinning. */
	let pinIntentUntil = 0;
	let listEl: HTMLElement | undefined = $state();

	function captureAnchor(el: HTMLElement) {
		keptPinned = Date.now() < pinIntentUntil || isAtBottom(el, 2);
		keptAnchor = keptPinned ? null : captureChatAnchor(el);
	}

	function keepAnchor() {
		const el = getScrollEl();
		// The initial restore owns the scroll while it runs.
		if (!el || !hasInitiallyScrolled || suppressAutoScroll) return;
		// A position hold is running: keep ITS target, right away rather than
		// on its next frame, so a change landing mid-frame never paints shifted.
		if (releaseHold) {
			if (heldTarget === 'bottom') {
				if (el.scrollHeight - el.clientHeight - el.scrollTop > 1) el.scrollTop = el.scrollHeight;
			} else if (heldTarget) {
				const node = el.querySelector<HTMLElement>(`[data-message-id="${heldTarget.anchorId}"]`);
				if (!node) return;
				const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top - heldTarget.offset;
				if (Math.abs(delta) > 1) el.scrollTop += delta;
			}
			return;
		}
		if (keptPinned) {
			if (editModeState.isEditing) return;
			if (el.scrollHeight - el.clientHeight - el.scrollTop > 1) el.scrollTop = el.scrollHeight;
			return;
		}
		if (!keptAnchor) return;
		const node = el.querySelector<HTMLElement>(`[data-message-id="${keptAnchor.id}"]`);
		if (!node) return;
		const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top - keptAnchor.offset;
		if (Math.abs(delta) >= 1) el.scrollTop += delta;
	}

	$effect(() => {
		const el = messagesScrollEl;
		const list = listEl;
		if (!el || !list) return;
		const observer = new ResizeObserver(() => keepAnchor());
		observer.observe(list);
		observer.observe(el);
		// The reader taking over cancels a pending pin to the bottom.
		const takeOver = () => {
			pinIntentUntil = 0;
		};
		for (const type of ['wheel', 'touchstart', 'keydown'] as const) {
			el.addEventListener(type, takeOver, { passive: true });
		}
		return () => {
			observer.disconnect();
			for (const type of ['wheel', 'touchstart', 'keydown'] as const) {
				el.removeEventListener(type, takeOver);
			}
		};
	});

	// ========================================
	// EDGES: REVEAL / LOAD MORE
	// ========================================

	/**
	 * Rendered items wholly beyond the viewport (plus a margin) at one end —
	 * the most the window may drop there without anything visible vanishing.
	 */
	function countOffscreen(el: HTMLElement, side: 'above' | 'below'): number {
		const nodes = el.querySelectorAll<HTMLElement>('[data-vs-item]');
		const rect = el.getBoundingClientRect();
		const margin = vs.loadMoreMargin;
		let count = 0;
		if (side === 'below') {
			for (let i = nodes.length - 1; i >= 0; i--) {
				if (nodes[i].getBoundingClientRect().top <= rect.bottom + margin) break;
				count++;
			}
		} else {
			for (let i = 0; i < nodes.length; i++) {
				if (nodes[i].getBoundingClientRect().bottom >= rect.top - margin) break;
				count++;
			}
		}
		return count;
	}

	let isEdgeBusy = false;

	/** Run one window change, let it render, then look at the edges again. */
	async function runEdge(change: () => void) {
		isEdgeBusy = true;
		try {
			change();
			await tick();
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		} finally {
			isEdgeBusy = false;
		}
		checkEdges();
	}

	/** Fetch the next older page while the reader waits at the top. */
	async function loadOlderAtTop() {
		isEdgeBusy = true;
		isLoadingOlder = true;
		try {
			await loadOlderPage();
			await tick();
		} catch {
			// fetchOlderPage already logged it; the next scroll retries.
		} finally {
			isLoadingOlder = false;
			isEdgeBusy = false;
		}
		checkEdges();
	}

	/**
	 * Reveal or load whatever is next to the reader at either end. Called on
	 * every scroll AND after every load/reveal finishes: scrolling into the top
	 * while a page was still on its way left nothing to trigger the next step,
	 * so the chat sat stuck at the top until the user scrolled again.
	 */
	function checkEdges() {
		const el = getScrollEl();
		if (!el || isEdgeBusy || !hasInitiallyScrolled || suppressAutoScroll) return;
		const margin = vs.loadMoreMargin;
		const { scrollTop, scrollHeight, clientHeight } = el;

		prefetchOlderIfNear(el);

		if (scrollTop <= margin) {
			if (vs.isActive && vs.hasMoreAbove) {
				const spare = countOffscreen(el, 'below');
				void runEdge(() => {
					vs.expandUp();
					vs.trimBottom(spare);
				});
				return;
			}
			if (sessionState.hasOlderMessages) {
				void loadOlderAtTop();
				return;
			}
		}

		if (vs.isActive && vs.hasMoreBelow && scrollHeight - scrollTop - clientHeight <= margin) {
			const spare = countOffscreen(el, 'above');
			void runEdge(() => {
				vs.expandDown();
				vs.trimTop(spare);
			});
		}
	}

	// Scroll detection with bottom position tracking + load more triggers
	function handleMessagesScroll() {
		const el = getScrollEl();
		if (!el) return;

		captureAnchor(el);

		// While the lock is active we can't trust scroll events to reflect user
		// intent (they may be echoes of our own programmatic scroll), so leave
		// isUserAtBottom untouched — but DO schedule a settle-capture so a real
		// user scroll during the lock still updates the saved position.
		if (Date.now() < scrollLockUntil) {
			scheduleReadingPositionSave();
			checkEdges();
			return;
		}

		isUserAtBottom = isAtBottom(el);

		// Remember this session's reading position (synchronous in the common,
		// unlocked case so a project switch immediately after still flushes it).
		saveReadingPosition(el);

		checkEdges();
	}

	// ========================================
	// AUTO-SCROLL & VIRTUAL SCROLL SYNC
	// ========================================

	/**
	 * A cheap stand-in for a tool result's size, enough to notice it arriving or
	 * growing. Serialising every result (screenshots included) on every streamed
	 * token and every loaded page was a large share of the chat's main-thread
	 * time once a session got long.
	 */
	function resultSignature(result: unknown): number {
		const content = (result as { content?: unknown } | null)?.content ?? result;
		if (typeof content === 'string') return content.length;
		if (!Array.isArray(content)) return 1;
		let size = content.length;
		for (const part of content) {
			const p = part as { text?: unknown; data?: unknown; source?: { data?: unknown } } | null;
			if (typeof p?.text === 'string') size += p.text.length;
			else if (typeof p?.data === 'string') size += p.data.length;
			else if (typeof p?.source?.data === 'string') size += p.source.data.length;
			else size += 1;
		}
		return size;
	}

	// Auto-scroll: track message count and partial message updates
	$effect(() => {
		const currentMessageCount = filteredMessages.length;
		const isNewMessage = currentMessageCount > previousMessageCount;
		const isMessageCountDecreased = currentMessageCount < previousMessageCount;

		// Sync virtual scroll with message count changes
		if (hasInitiallyScrolled && !suppressAutoScroll) {
			if (isMessageCountDecreased) {
				resetView(currentMessageCount);
			} else if (isNewMessage) {
				vs.sync(currentMessageCount, isUserAtBottom);
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
					currentToolResultsHash += `${item.id}:${resultSignature(item.result)}|`;
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

	/** Input that means the user has taken over the scroll position. */
	const USER_SCROLL_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

	/** How long a restored position is held against late layout. */
	const HOLD_POSITION_MS = 2000;

	let releaseHold: (() => void) | null = null;
	/** What the running hold keeps in place (the anchor keeper applies it too). */
	let heldTarget: { anchorId: string; offset: number } | 'bottom' | null = null;

	/**
	 * Keep a restored position in place while the layout finishes settling.
	 *
	 * Aligning once is not enough: after it, markdown, code blocks and images
	 * around the anchor finish rendering, and the window may reveal more items
	 * above it. So the position is re-applied every frame for a short while,
	 * and given up the moment the user scrolls, clicks or types, or the session
	 * changes — the anchor keeper takes over from there.
	 *
	 * `target` is the anchor to hold, or null to hold the bottom.
	 */
	function holdPosition(el: HTMLElement, target: { anchorId: string; offset: number } | null) {
		releaseHold?.();
		const sessionId = sessionState.currentSession?.id;
		const until = Date.now() + HOLD_POSITION_MS;
		let frame = 0;
		const stop = () => {
			cancelAnimationFrame(frame);
			for (const type of USER_SCROLL_INPUT) {
				el.removeEventListener(type, stop);
				window.removeEventListener(type, stop);
			}
			if (releaseHold === stop) {
				releaseHold = null;
				heldTarget = null;
				// Hand the position back to the anchor keeper.
				captureAnchor(el);
			}
		};
		const step = () => {
			if (Date.now() > until || sessionState.currentSession?.id !== sessionId || editModeState.isEditing) {
				stop();
				return;
			}
			if (target) {
				const anchorEl = el.querySelector<HTMLElement>(`[data-message-id="${target.anchorId}"]`);
				if (!anchorEl) {
					stop();
					return;
				}
				const delta = anchorEl.getBoundingClientRect().top - el.getBoundingClientRect().top - target.offset;
				if (Math.abs(delta) > 1) {
					scrollLockUntil = Date.now() + 200;
					el.scrollTop += delta;
				}
			} else if (el.scrollHeight - el.clientHeight - el.scrollTop > 1) {
				scrollLockUntil = Date.now() + 200;
				el.scrollTop = el.scrollHeight;
			}
			frame = requestAnimationFrame(step);
		};
		for (const type of USER_SCROLL_INPUT) {
			el.addEventListener(type, stop, { passive: true });
			// Keyboard scrolling and clicks can land outside the list itself.
			window.addEventListener(type, stop, { passive: true });
		}
		releaseHold = stop;
		heldTarget = target ?? 'bottom';
		frame = requestAnimationFrame(step);
	}

	// Restore the session's saved reading position, or fall back to the bottom.
	// Only restores when the user had genuinely scrolled up — the common
	// at-bottom case behaves exactly as before. Async: restoring an anchor may
	// require expanding the virtual window and waiting for the DOM to render.
	async function applyInitialScroll(el: HTMLElement) {
		if (editModeState.isEditing) return;
		// Hold auto-scroll off for the whole (possibly multi-page) positioning;
		// the callers release it once this resolves.
		suppressAutoScroll = true;
		// Lock scroll detection across the (possibly async) positioning so the
		// scroll events we cause don't flip isUserAtBottom back to true.
		scrollLockUntil = Date.now() + 800;
		const sid = sessionState.currentSession?.id;
		const saved = sid ? getChatScroll(sid) : undefined;

		if (saved && !saved.atBottom && saved.anchorMessageId) {
			const anchorId = saved.anchorMessageId;
			// The chat opens on its latest page; the message the user was reading
			// may be older. Page back to it before positioning — this is what
			// "restore where I was" means once history is paged.
			if (!isMessageLoaded(anchorId) && sessionState.hasOlderMessages) {
				await ensureMessageLoaded(anchorId);
				resetView(filteredMessages.length);
				previousMessageCount = filteredMessages.length;
				scrollLockUntil = Date.now() + 800;
			}
			const idx = indexOfMessage(anchorId);
			if (idx >= 0) {
				isUserAtBottom = false;
				// Pull the anchor into the virtual window, then wait for it to render.
				if (vs.isActive) vs.ensureVisible(idx);
				await tick();

				// Align the anchor to its saved offset, then RE-ALIGN across several
				// frames: messages that just mounted are still settling their real
				// height (markdown, code, images) and shove the anchor away from where
				// we just put it. Each pass re-measures and corrects until the position
				// stabilizes, keeping the lock raised so these programmatic scrolls
				// aren't mistaken for user input.
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
				if (aligned) {
					holdPosition(el, { anchorId, offset: saved.anchorOffset });
					return;
				}
			}
		}

		// Default / fallback: pin to the bottom.
		el.scrollTop = el.scrollHeight;
		isUserAtBottom = true;
		holdPosition(el, null);
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
				resetView(currentMessages);

				// Restore the saved reading position (or bottom) while still hidden,
				// then reveal + re-enable auto-scroll once positioned.
				applyInitialScroll(el)
					.then(() => fillViewportIfShort())
					.finally(() => {
						suppressAutoScroll = false;
						checkEdges();
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
						resetView(filteredMessages.length);
						hasInitiallyScrolled = true;
						applyInitialScroll(el2)
							.then(() => fillViewportIfShort())
							.finally(() => {
								suppressAutoScroll = false;
								checkEdges();
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

		// An edit restored after a refresh can target a message on a page that is
		// not loaded yet: page back to it first.
		if (!isMessageLoaded(messageId) && sessionState.hasOlderMessages) {
			void ensureMessageLoaded(messageId).then((found) => {
				if (found) scrollToEditedMessage(messageId, retries);
			});
			return;
		}

		// Ensure message is within the virtual scroll window
		if (vs.isActive) {
			const msgIndex = indexOfMessage(messageId);
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

	/** Where a jumped-to prompt lands, from the top of the list. */
	const NAV_JUMP_OFFSET = 24;

	/** The prompt a jump is on its way to — the rail shows it as loading. */
	let navPendingId = $state<string | null>(null);
	/** Bumped by every jump, so a slower earlier one never lands after a later one. */
	let navJumpToken = 0;

	async function handleNavJump(item: NavItem) {
		const el = getScrollEl();
		if (!el) return;
		const token = ++navJumpToken;
		navPendingId = item.messageId;
		try {
			// The prompt may be on a page that is not loaded yet.
			if (!isMessageLoaded(item.messageId) && !(await ensureMessageLoaded(item.messageId))) return;
			if (token !== navJumpToken) return;
			const index = indexOfMessage(item.messageId);
			if (index < 0) return;

			if (vs.isActive && (index < vs.windowStart || index >= vs.windowEnd)) {
				vs.ensureVisible(index);
				await tick();
				if (token !== navJumpToken) return;
			}

			const target = el.querySelector<HTMLElement>(`[data-message-id="${item.messageId}"]`);
			if (!target) return;
			// Lock scroll detection so the jump doesn't flip isUserAtBottom.
			scrollLockUntil = Date.now() + 400;
			pinIntentUntil = 0;
			keptPinned = false;
			isUserAtBottom = false;
			el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - NAV_JUMP_OFFSET;
			// Messages around the target are still settling (markdown, code,
			// images) and the window may reveal more above it: hold it in place
			// until it is stable or the user takes over.
			holdPosition(el, { anchorId: item.messageId, offset: NAV_JUMP_OFFSET });
		} finally {
			if (token === navJumpToken) navPendingId = null;
		}
	}

	function handleNavJumpToBottom() {
		const el = getScrollEl();
		if (!el || filteredMessages.length === 0) return;

		// Supersede a jump still loading, and any position being held.
		navJumpToken++;
		navPendingId = null;
		releaseHold?.();

		const lastIndex = filteredMessages.length - 1;

		const performScroll = () => {
			scrollLockUntil = Date.now() + 600;
			el.scrollTop = el.scrollHeight;
			isUserAtBottom = true;
			// Late layout below is followed by the hold (and the anchor keeper after it).
			holdPosition(el, null);
		};

		if (vs.isActive && vs.hasMoreBelow) {
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
		window.addEventListener('pagehide', flushReadingPosition);
		document.addEventListener('visibilitychange', flushReadingPosition);

		// Start with content hidden if restoring
		if (appState.isRestoring) {
			isContentReady = false;
		} else {
			// Not restoring, check if we need to scroll
			const el = getScrollEl();
			if (filteredMessages.length > 0 && el) {
				// Initialize virtual scroll and scroll immediately
				resetView(filteredMessages.length);
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
			releaseHold?.();
			window.removeEventListener('pagehide', flushReadingPosition);
			document.removeEventListener('visibilitychange', flushReadingPosition);
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
			pendingId={navPendingId}
			{isUserAtBottom}
			onJump={handleNavJump}
			onJumpToBottom={handleNavJumpToBottom}
		/>
	{/if}

	<!-- Loading older messages indicator. An overlay, not part of the list: as an
	     in-flow row it pushed every message down when it appeared and back up when
	     it went, which is exactly the jump paging is careful to avoid. -->
	{#if isLoadingOlder}
		<div class="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 z-10">
			<div class="flex items-center gap-2 rounded-full bg-white/90 dark:bg-slate-900/90 px-3 py-1 text-xs text-slate-400 dark:text-slate-500 shadow-sm">
				<div class="w-3 h-3 border-2 border-slate-300 dark:border-slate-600 border-t-transparent rounded-full animate-spin"></div>
				<span>Loading older messages...</span>
			</div>
		</div>
	{/if}

	<!-- Messages container -->
	<div
		bind:this={messagesScrollEl}
		class="chat-scroll flex-1 overflow-y-auto pt-3 pb-14 lg:pb-16 px-3 lg:px-4 {isContentReady ? '' : 'invisible'}"
		style="{!isContentReady ? 'scroll-behavior: auto' : ''}">

		<!-- One render path for every state. Rendering through two branches (no
		     transition while restoring, fade otherwise) remounted every message
		     the moment a restore finished — dropping each one's measured height
		     right while the reading position was being aligned to them.
		     The wrapper is what the anchor keeper watches for size changes. -->
		<div bind:this={listEl}>
		{#each messagesWithDateSeparators as item (item.key)}
			<div>
				{#if item.type === 'date'}
					<DateSeparator date={item.data} />
				{:else if item.type === 'message'}
					{@const messageId = 'messageId' in item.data ? item.data.messageId : undefined}
					{@const isLastUser = messageId === lastUserMessageId}
					{@const rail = railFlagsByKey.get(item.key)}
					<!-- data-msg-index: the message's place in the whole list, so the nav
					     rail can tell which prompt's section is on screen even when that
					     prompt itself is outside the rendered window. -->
					<div class={isCompact ? 'mb-2' : 'mb-2 lg:mb-4'} data-message-id={messageId} data-msg-index={windowBase + (item.position ?? 0)} data-vs-item>
						<ChatMessage message={item.data} isLastUserMessage={isLastUser} railConnectUp={rail?.up ?? false} railConnectDown={rail?.down ?? false} />
					</div>
				{/if}
			</div>
		{/each}
		</div>

	</div>
</div>

<style>
	/* The anchor keeper holds the reading position on every browser alike;
	   native scroll anchoring would correct the same scroll a second time. */
	.chat-scroll {
		overflow-anchor: none;
	}
</style>
