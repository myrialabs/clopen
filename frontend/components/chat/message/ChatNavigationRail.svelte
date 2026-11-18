<script lang="ts">
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import Icon from '$frontend/components/common/display/Icon.svelte';

	export interface NavItem {
		globalIndex: number;
		messageId: string;
		text: string;
	}

	interface Props {
		scrollEl: HTMLElement | undefined;
		items: NavItem[];
		/** The prompt a jump is still loading (or scrolling) to. */
		pendingId: string | null;
		isUserAtBottom: boolean;
		onJump: (item: NavItem) => void;
		onJumpToBottom: () => void;
	}

	const { scrollEl, items, pendingId, isUserAtBottom, onJump, onJumpToBottom }: Props = $props();

	type HoverKey = string | 'up' | 'down' | null;
	type PendingSource = 'up' | 'down' | 'dot' | null;

	/** Mouse hover or keyboard focus only — touch never sets it (see the scrubber). */
	let hovered = $state<HoverKey>(null);
	let activeId = $state<string | null>(null);
	let rafId = 0;
	let lockUntil = 0;
	let bandHeight = $state(0);
	let bandEl: HTMLElement | undefined = $state();
	let pillEl: HTMLElement | undefined = $state();

	/** What started the pending jump, so the spinner shows on the thing pressed. */
	let pendingSource = $state<PendingSource>(null);
	/** Spinner shown only for jumps that take a moment, so instant ones never flash. */
	let showPending = $state(false);

	/** Touch scrub in progress: the prompt under the gesture and where the finger is. */
	let scrub = $state<{ idx: number; y: number; cancel: boolean } | null>(null);
	let previewHeight = $state(0);

	const activeIdx = $derived(
		activeId ? items.findIndex(i => i.messageId === activeId) : -1
	);
	const canGoUp = $derived(items.length > 0 && (activeIdx === -1 || activeIdx > 0));
	const canGoDown = $derived(
		items.length > 0 && (activeIdx === -1 || activeIdx < items.length - 1)
	);

	const upTarget = $derived<NavItem | null>(
		!canGoUp ? null : activeIdx === -1 ? items[items.length - 1] : items[activeIdx - 1]
	);
	const downTarget = $derived<NavItem | null>(
		!canGoDown ? null : activeIdx === -1 ? items[0] : items[activeIdx + 1]
	);

	// --- Windowing: cap visible dots to the available band height ---
	//
	// Every dot is rendered in one column that slides behind a clipped viewport
	// (translateY), so moving the window glides instead of re-slicing the list
	// in one frame. While a jump is loading the window stays exactly where it
	// was — the spinner sits on the dot that was pressed — and only moves once
	// the jump has landed.
	const PER_DOT = 15; // px per dot row (fixed row height)
	const CHROME = 68; // px for chevrons + pill/container padding
	const ELLIPSIS = 18; // px per ellipsis marker

	const capacity = $derived.by(() => {
		if (bandHeight <= 0) return Number.MAX_SAFE_INTEGER;
		return Math.max(1, Math.floor((bandHeight - CHROME) / PER_DOT));
	});

	const isWindowed = $derived(items.length > capacity);

	const windowSize = $derived.by(() => {
		if (!isWindowed) return items.length;
		const forDots = bandHeight - CHROME - 2 * ELLIPSIS;
		return Math.max(1, Math.min(items.length, Math.floor(forDots / PER_DOT)));
	});

	/** The dot the window centres on: the one being scrubbed to, else the active one. */
	const focusIdx = $derived(scrub ? scrub.idx : activeIdx);

	/** Window start held while a jump is on its way (null when free). */
	let frozenStart = $state<number | null>(null);

	const windowStart = $derived.by(() => {
		const total = items.length;
		if (!isWindowed) return 0;
		const maxStart = total - windowSize;
		if (frozenStart !== null && !scrub) return Math.max(0, Math.min(frozenStart, maxStart));
		const center = focusIdx === -1 ? total - 1 : focusIdx;
		const start = center - Math.floor(windowSize / 2);
		return Math.max(0, Math.min(start, maxStart));
	});

	// Release the hold once nothing is pending — right away for a jump that
	// needed no loading, when it lands for one that did.
	$effect(() => {
		if (frozenStart !== null && !pendingId) frozenStart = null;
	});

	/** Slide transitions are off until the rail has settled, and for a new chat. */
	let animate = $state(false);
	const chatKey = $derived(items[0]?.messageId ?? '');
	$effect(() => {
		chatKey;
		animate = false;
		let inner = 0;
		const outer = requestAnimationFrame(() => {
			inner = requestAnimationFrame(() => (animate = true));
		});
		return () => {
			cancelAnimationFrame(outer);
			cancelAnimationFrame(inner);
		};
	});

	function isVisibleIdx(idx: number): boolean {
		return idx >= windowStart && idx < windowStart + windowSize;
	}
	const moreAbove = $derived(windowStart);
	/** The dot whose tooltip is showing (mouse hover / keyboard focus), or -1. */
	const hoveredIdx = $derived.by(() => {
		const key = hovered;
		if (key === null || key === 'up' || key === 'down') return -1;
		const idx = items.findIndex(i => i.messageId === key);
		return isVisibleIdx(idx) ? idx : -1;
	});
	const moreBelow = $derived(items.length - (windowStart + windowSize));
	const pageStep = $derived(Math.max(1, windowSize - 1));

	/** Keep the rail fully visible while it is doing something. */
	const isEngaged = $derived(scrub !== null || (pendingId !== null && showPending));

	/**
	 * Where the reader's eye is: a prompt becomes active once its top crosses
	 * this line, and stays active through its replies until the next prompt
	 * crosses it. "Nearest to the middle of the viewport" switched late and
	 * unpredictably — a prompt already scrolled past could still be nearer than
	 * the one now on screen.
	 */
	const READING_LINE_RATIO = 0.3;
	const READING_LINE_MAX_PX = 240;

	function updateActive() {
		if (!scrollEl || items.length === 0) return;
		// A jump still on its way owns the highlight.
		if (pendingId || Date.now() < lockUntil) return;

		// Work in message positions, not prompt elements: a long agent turn can
		// fill the whole rendered window with tool calls, leaving its prompt
		// outside it — scanning only rendered prompts then found nothing and the
		// highlight stayed wherever it was (e.g. after "scroll to bottom").
		const nodes = scrollEl.querySelectorAll<HTMLElement>('[data-msg-index]');
		if (nodes.length === 0) return;

		const scrollRect = scrollEl.getBoundingClientRect();
		const line = scrollRect.top + Math.min(scrollRect.height * READING_LINE_RATIO, READING_LINE_MAX_PX);
		const atEnd = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 4;

		// The message being read: the last one that has crossed the reading line,
		// or — scrolled to the end — the last one on screen, since the final
		// section can never reach the line.
		let reading = -1;
		for (const el of nodes) {
			const top = el.getBoundingClientRect().top;
			if (top <= line || (atEnd && top < scrollRect.bottom)) reading = Number(el.dataset.msgIndex);
			else break;
		}
		// Nothing has crossed yet: the reader is still in the section before
		// the first rendered message.
		if (reading === -1) reading = Number(nodes[0].dataset.msgIndex) - 1;

		// The active prompt opens that section: the last loaded prompt at or
		// before it, else the newest prompt older than everything loaded.
		let next = -1;
		let firstLoaded = items.length;
		for (let i = 0; i < items.length; i++) {
			const gi = items[i].globalIndex;
			if (gi < 0) continue;
			if (firstLoaded === items.length) firstLoaded = i;
			if (gi <= reading) next = i;
		}
		if (next === -1) next = Math.max(0, firstLoaded - 1);
		activeId = items[next].messageId;
	}

	function scheduleUpdate() {
		if (rafId) return;
		rafId = requestAnimationFrame(() => {
			rafId = 0;
			updateActive();
		});
	}

	function findScrollableAncestors(el: HTMLElement): HTMLElement[] {
		const result: HTMLElement[] = [];
		let cur: HTMLElement | null = el;
		while (cur && cur !== document.body) {
			const style = getComputedStyle(cur);
			if (/(auto|scroll|overlay)/.test(style.overflowY)) {
				result.push(cur);
			}
			cur = cur.parentElement;
		}
		return result;
	}

	$effect(() => {
		if (!scrollEl) return;
		const targets = findScrollableAncestors(scrollEl);
		for (const t of targets) t.addEventListener('scroll', scheduleUpdate, { passive: true });
		// Initial run, deferred so layout is settled after mount/auto-scroll
		const tid = setTimeout(scheduleUpdate, 50);
		return () => {
			for (const t of targets) t.removeEventListener('scroll', scheduleUpdate);
			clearTimeout(tid);
		};
	});

	$effect(() => {
		items.length;
		scheduleUpdate();
	});

	// Content can move without a scroll event — the window swapping in other
	// messages, replies finishing their render, a clamp at the end — so layout
	// changes re-check too.
	$effect(() => {
		const el = scrollEl;
		const list = el?.firstElementChild;
		if (!el || !list) return;
		const observer = new ResizeObserver(() => scheduleUpdate());
		observer.observe(list);
		observer.observe(el);
		return () => observer.disconnect();
	});

	$effect(() => {
		if (isUserAtBottom) scheduleUpdate();
	});

	// Pending jump: show the spinner after a beat; once it lands, keep the
	// highlight on the target a moment longer while the position settles.
	$effect(() => {
		if (!pendingId) {
			showPending = false;
			return;
		}
		const show = setTimeout(() => (showPending = true), 150);
		return () => {
			clearTimeout(show);
			lockUntil = Date.now() + 300;
			setTimeout(scheduleUpdate, 320);
		};
	});

	$effect(() => {
		if (!pendingId) pendingSource = null;
	});

	// A hover whose element went away (the dot window moved, the chevron got
	// disabled) never receives its leave event: drop it here instead of leaving
	// a tooltip on screen.
	$effect(() => {
		const key = hovered;
		if (key === null) return;
		if (key === 'up') {
			if (!canGoUp) hovered = null;
		} else if (key === 'down') {
			if (!canGoDown) hovered = null;
		} else if (!isVisibleIdx(items.findIndex(i => i.messageId === key))) {
			hovered = null;
		}
	});

	onMount(() => {
		return () => {
			if (rafId) cancelAnimationFrame(rafId);
			endPress();
		};
	});

	function previewText(text: string): string {
		const clean = text.replace(/\s+/g, ' ').trim();
		return clean.length > 120 ? clean.slice(0, 120) + '…' : clean;
	}

	function jumpTo(item: NavItem, source: PendingSource = 'dot') {
		// Hold the dots still for as long as the jump is loading.
		frozenStart = windowStart;
		activeId = item.messageId;
		lockUntil = Date.now() + 700;
		pendingSource = source;
		onJump(item);
	}

	function jumpToBottom() {
		// The end of the chat is the last prompt's section: show it right away
		// rather than wait for the scroll to settle.
		const last = items[items.length - 1];
		if (last) {
			activeId = last.messageId;
			lockUntil = Date.now() + 400;
			setTimeout(scheduleUpdate, 420);
		}
		onJumpToBottom();
	}

	function goUp() {
		if (isClickSuppressed()) return;
		if (upTarget) jumpTo(upTarget, 'up');
	}

	function goDown() {
		if (isClickSuppressed()) return;
		if (downTarget) jumpTo(downTarget, 'down');
	}

	// Page the window up/down by ~one window when an ellipsis marker is clicked
	function pageBy(delta: number) {
		if (isClickSuppressed()) return;
		const total = items.length;
		if (total === 0) return;
		const center = activeIdx === -1 ? total - 1 : activeIdx;
		const target = Math.max(0, Math.min(total - 1, center + delta));
		jumpTo(items[target]);
	}

	function clickDot(item: NavItem) {
		if (isClickSuppressed()) return;
		jumpTo(item);
	}

	// --- Hover (mouse) and focus (keyboard) ---

	function hoverIn(event: PointerEvent, key: HoverKey) {
		if (event.pointerType === 'mouse') hovered = key;
	}

	function hoverOut(event: PointerEvent, key: HoverKey) {
		if (event.pointerType === 'mouse' && hovered === key) hovered = null;
	}

	function focusIn(event: FocusEvent, key: HoverKey) {
		// Only keyboard focus: a clicked button keeps focus after the mouse has
		// gone, which is what left tooltips lingering.
		if ((event.currentTarget as HTMLElement).matches(':focus-visible')) hovered = key;
	}

	function focusOut(key: HoverKey) {
		if (hovered === key) hovered = null;
	}

	// --- Touch: tap to jump, press-and-hold to preview, hold and slide to scrub ---
	//
	// The dots are a few pixels apart, far too close to aim at with a finger,
	// so a scrub does not follow the dot under the finger. Finger travel maps
	// to a number of prompts instead: a steady, generous step for the first
	// few (fine control), growing for longer slides (reach across a long chat).
	// Hysteresis stops the preview flickering at a step boundary, and turning
	// back re-bases the slide so the fine steps return in the new direction.

	const HOLD_MS = 300;
	const SLOP_PX = 8;
	/** Finger travel per prompt for the first LINEAR_STEPS prompts. */
	const STEP_PX = 22;
	const LINEAR_STEPS = 4;
	const HYSTERESIS = 0.3;
	/** Travel back against the slide that counts as turning around. */
	const TURN_PX = 6;
	/** Slide this far left, away from the rail, and releasing cancels. */
	const CANCEL_PX = 72;
	const SUPPRESS_CLICK_MS = 600;

	interface Press {
		pointerId: number;
		x0: number;
		y0: number;
		/** The dot pressed, or -1 when the press started on a chevron or ellipsis. */
		dotIdx: number;
		timer: ReturnType<typeof setTimeout> | null;
		scrubbing: boolean;
		baseY: number;
		baseIdx: number;
		dir: number;
		extremeY: number;
	}

	let press: Press | null = null;
	let suppressClickUntil = 0;

	function isClickSuppressed(): boolean {
		return Date.now() < suppressClickUntil;
	}

	function nearestDot(clientY: number): number {
		if (!pillEl) return -1;
		let best = -1;
		let bestDist = Infinity;
		for (const node of pillEl.querySelectorAll<HTMLElement>('[data-nav-idx]')) {
			if (!isVisibleIdx(Number(node.dataset.navIdx))) continue;
			const rect = node.getBoundingClientRect();
			const dist = Math.abs(rect.top + rect.height / 2 - clientY);
			if (dist < bestDist) {
				bestDist = dist;
				best = Number(node.dataset.navIdx);
			}
		}
		return bestDist <= PER_DOT ? best : -1;
	}

	function onPressStart(event: PointerEvent) {
		if (event.pointerType === 'mouse' || !event.isPrimary || items.length === 0) return;
		endPress();
		hovered = null;
		const onControl = (event.target as HTMLElement).closest('[data-nav-ctrl]') !== null;
		const dotIdx = onControl ? -1 : nearestDot(event.clientY);
		press = {
			pointerId: event.pointerId,
			x0: event.clientX,
			y0: event.clientY,
			dotIdx,
			timer: setTimeout(() => startScrub(event.clientY), HOLD_MS),
			scrubbing: false,
			baseY: event.clientY,
			baseIdx: 0,
			dir: 0,
			extremeY: event.clientY
		};
	}

	function startScrub(clientY: number) {
		if (!press || press.scrubbing) return;
		if (press.timer) clearTimeout(press.timer);
		press.timer = null;
		press.scrubbing = true;
		const center = activeIdx === -1 ? items.length - 1 : activeIdx;
		press.baseIdx = press.dotIdx >= 0 ? press.dotIdx : center;
		press.baseY = press.y0;
		press.extremeY = clientY;
		try {
			pillEl?.setPointerCapture(press.pointerId);
		} catch {
			// The pointer is already gone; the up/cancel handler cleans up.
		}
		scrub = { idx: press.baseIdx, y: clientY, cancel: false };
		buzz();
		moveScrub(press.x0, clientY);
	}

	/** Continuous prompt offset for a finger travel: linear first, then accelerating. */
	function travelToSteps(px: number): number {
		const n = Math.abs(px) / STEP_PX;
		const steps = n <= LINEAR_STEPS ? n : LINEAR_STEPS + (n - LINEAR_STEPS) * (1 + (n - LINEAR_STEPS) / LINEAR_STEPS);
		return Math.sign(px) * steps;
	}

	function moveScrub(clientX: number, clientY: number) {
		if (!press || !scrub) return;
		const last = items.length - 1;

		// Turning around re-bases the slide on the current prompt.
		const moved = clientY - press.extremeY;
		if (press.dir === 0) {
			if (Math.abs(clientY - press.baseY) > 2) {
				press.dir = Math.sign(clientY - press.baseY);
				press.extremeY = clientY;
			}
		} else if (Math.sign(moved) === press.dir) {
			press.extremeY = clientY;
		} else if (Math.abs(moved) > TURN_PX) {
			press.baseY = press.extremeY;
			press.baseIdx = scrub.idx;
			press.dir = -press.dir;
			press.extremeY = clientY;
		}

		const target = Math.max(0, Math.min(last, press.baseIdx + travelToSteps(clientY - press.baseY)));
		let idx = Math.min(scrub.idx, last);
		if (Math.abs(target - idx) >= 0.5 + HYSTERESIS) idx = Math.round(target);
		const cancel = press.x0 - clientX > CANCEL_PX;
		if (idx !== scrub.idx) buzz();
		scrub = { idx, y: clientY, cancel };
	}

	function onPressMove(event: PointerEvent) {
		if (!press || event.pointerId !== press.pointerId) return;
		if (!press.scrubbing) {
			const dist = Math.hypot(event.clientX - press.x0, event.clientY - press.y0);
			if (dist > SLOP_PX) startScrub(event.clientY);
			return;
		}
		moveScrub(event.clientX, event.clientY);
	}

	function onPressEnd(event: PointerEvent) {
		if (!press || event.pointerId !== press.pointerId) return;
		const ended = press;
		const current = scrub;
		endPress();
		if (ended.scrubbing) {
			suppressClickUntil = Date.now() + SUPPRESS_CLICK_MS;
			if (current && !current.cancel && items[current.idx]) jumpTo(items[current.idx]);
			return;
		}
		// A tap on a dot jumps right away; a tap on a chevron or ellipsis is
		// left to its own click handler.
		if (ended.dotIdx >= 0 && items[ended.dotIdx]) {
			suppressClickUntil = Date.now() + SUPPRESS_CLICK_MS;
			jumpTo(items[ended.dotIdx]);
		}
	}

	function onPressCancel(event: PointerEvent) {
		if (!press || event.pointerId !== press.pointerId) return;
		if (press.scrubbing) suppressClickUntil = Date.now() + SUPPRESS_CLICK_MS;
		endPress();
	}

	function endPress() {
		if (press?.timer) clearTimeout(press.timer);
		press = null;
		scrub = null;
	}

	function buzz() {
		try {
			navigator.vibrate?.(6);
		} catch {
			// Not allowed here — the preview change is feedback enough.
		}
	}

	function onContextMenu(event: Event) {
		// A long press would otherwise open the browser's context menu.
		if (press) event.preventDefault();
	}

	// --- Scrub preview card ---

	const scrubItem = $derived(scrub ? items[scrub.idx] ?? null : null);
	const scrubPrev = $derived(scrub && scrub.idx > 0 ? items[scrub.idx - 1] : null);
	const scrubNext = $derived(scrub && scrub.idx < items.length - 1 ? items[scrub.idx + 1] : null);

	const previewTop = $derived.by(() => {
		if (!scrub || !bandEl) return 0;
		const bandTop = bandEl.getBoundingClientRect().top;
		const wanted = scrub.y - bandTop - previewHeight / 2;
		return Math.max(0, Math.min(wanted, Math.max(0, bandHeight - previewHeight)));
	});
</script>

{#snippet tooltip(item: NavItem)}
	<div
		class="absolute right-full top-1/2 -translate-y-1/2 mr-3 px-3 py-2 rounded-xl shadow-lg pointer-events-none z-30 max-w-[260px] w-max
			bg-white/95 text-slate-900 ring-1 ring-slate-200
			dark:bg-slate-700/95 dark:text-white dark:ring-0"
	>
		<div class="text-sm leading-snug line-clamp-2 break-words">
			{previewText(item.text)}
		</div>
	</div>
{/snippet}

{#snippet spinner(size: string)}
	<Icon name="lucide:loader" class="{size} animate-spin text-slate-600 dark:text-slate-300" />
{/snippet}

{#if items.length >= 1}
	<div
		bind:this={bandEl}
		class="absolute right-3 lg:right-4 top-3 bottom-14 lg:bottom-16 w-8 pointer-events-none z-20 flex flex-col items-center justify-center"
		bind:clientHeight={bandHeight}
	>
		<!-- touch-action: none so a press-and-slide scrubs instead of scrolling the chat -->
		<div
			bind:this={pillEl}
			role="navigation"
			aria-label="User messages"
			onpointerdown={onPressStart}
			onpointermove={onPressMove}
			onpointerup={onPressEnd}
			onpointercancel={onPressCancel}
			oncontextmenu={onContextMenu}
			class="pointer-events-auto touch-none select-none [-webkit-touch-callout:none] flex flex-col items-center rounded-full py-2 bg-white/30 dark:bg-slate-900/20 backdrop-blur-sm ring-1 ring-slate-200/40 dark:ring-slate-700/40 transition-opacity duration-200
				{isEngaged ? 'opacity-100' : 'opacity-40 hover:opacity-100 focus-within:opacity-100'}"
		>
		<div
			class="relative"
			role="presentation"
			onpointerenter={(e) => hoverIn(e, 'up')}
			onpointerleave={(e) => hoverOut(e, 'up')}
		>
			<button
				type="button"
				data-nav-ctrl
				onclick={goUp}
				onfocus={(e) => focusIn(e, 'up')}
				onblur={() => focusOut('up')}
				disabled={!canGoUp}
				class="flex p-0.5 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
				aria-label="Previous user message"
			>
				{#if showPending && pendingSource === 'up'}
					{@render spinner('w-4 h-4')}
				{:else}
					<Icon name="lucide:chevron-up" class="w-4 h-4" />
				{/if}
			</button>
			{#if hovered === 'up' && upTarget}
				{@render tooltip(upTarget)}
			{/if}
		</div>

		<div class="flex flex-col items-center py-1.5">
			<!-- The ellipsis rows keep their space whenever the rail is windowed, so
			     one appearing or going away never shifts the dots. -->
			{#if isWindowed}
				<button
					type="button"
					data-nav-ctrl
					onclick={() => pageBy(-pageStep)}
					disabled={moreAbove === 0}
					tabindex={moreAbove === 0 ? -1 : 0}
					class="flex items-center justify-center w-6 h-[18px] text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-[color,opacity] duration-200 {moreAbove === 0 ? 'opacity-0 pointer-events-none' : ''}"
					aria-label="Show {moreAbove} earlier user message{moreAbove === 1 ? '' : 's'}"
					title="{moreAbove} more above"
				>
					<Icon name="lucide:ellipsis-vertical" class="w-3.5 h-3.5" />
				</button>
			{/if}
			<div class="relative w-6">
				<div class="overflow-hidden" style="height: {windowSize * PER_DOT}px">
					<div
						class="flex flex-col ease-out {animate ? 'transition-transform' : ''}"
						style="transform: translateY({-windowStart * PER_DOT}px); transition-duration: {scrub ? 120 : 280}ms"
					>
						{#each items as item, idx (item.messageId)}
							{@const visible = isVisibleIdx(idx)}
							{@const active = scrub ? scrub.idx === idx : activeId === item.messageId}
							{@const loading = showPending && pendingSource === 'dot' && pendingId === item.messageId}
							<div
								class="shrink-0"
								style="height: {PER_DOT}px"
								role="presentation"
								onpointerenter={(e) => hoverIn(e, item.messageId)}
								onpointerleave={(e) => hoverOut(e, item.messageId)}
							>
								<button
									type="button"
									data-nav-idx={idx}
									onclick={() => clickDot(item)}
									onfocus={(e) => focusIn(e, item.messageId)}
									onblur={() => focusOut(item.messageId)}
									tabindex={visible ? 0 : -1}
									aria-hidden={!visible}
									class="flex items-center justify-center w-6 h-full cursor-pointer group"
									aria-label="Jump to user message {idx + 1} of {items.length}: {previewText(item.text)}"
									aria-busy={loading}
								>
									{#if loading}
										{@render spinner('w-3.5 h-3.5')}
									{:else}
										<span
											class="block h-px rounded-full transition-all duration-150
												{active
													? 'w-4 bg-slate-600 dark:bg-slate-300'
													: 'w-2 bg-slate-400 dark:bg-slate-500 group-hover:w-3 group-hover:bg-slate-600 dark:group-hover:bg-slate-300'}"
										></span>
									{/if}
								</button>
							</div>
						{/each}
					</div>
				</div>
				<!-- Outside the clipped viewport so it is not cut off. -->
				{#if hoveredIdx !== -1 && !scrub}
					<div class="absolute inset-x-0 h-0" style="top: {(hoveredIdx - windowStart) * PER_DOT + PER_DOT / 2}px">
						{@render tooltip(items[hoveredIdx])}
					</div>
				{/if}
			</div>
			{#if isWindowed}
				<button
					type="button"
					data-nav-ctrl
					onclick={() => pageBy(pageStep)}
					disabled={moreBelow === 0}
					tabindex={moreBelow === 0 ? -1 : 0}
					class="flex items-center justify-center w-6 h-[18px] text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-[color,opacity] duration-200 {moreBelow === 0 ? 'opacity-0 pointer-events-none' : ''}"
					aria-label="Show {moreBelow} later user message{moreBelow === 1 ? '' : 's'}"
					title="{moreBelow} more below"
				>
					<Icon name="lucide:ellipsis-vertical" class="w-3.5 h-3.5" />
				</button>
			{/if}
		</div>

		<div
			class="relative"
			role="presentation"
			onpointerenter={(e) => hoverIn(e, 'down')}
			onpointerleave={(e) => hoverOut(e, 'down')}
		>
			<button
				type="button"
				data-nav-ctrl
				onclick={goDown}
				onfocus={(e) => focusIn(e, 'down')}
				onblur={() => focusOut('down')}
				disabled={!canGoDown}
				class="flex p-0.5 text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
				aria-label="Next user message"
			>
				{#if showPending && pendingSource === 'down'}
					{@render spinner('w-4 h-4')}
				{:else}
					<Icon name="lucide:chevron-down" class="w-4 h-4" />
				{/if}
			</button>
			{#if hovered === 'down' && downTarget}
				{@render tooltip(downTarget)}
			{/if}
		</div>
		</div>

		<!-- Touch scrub preview: the prompt the gesture is on, with its neighbours
		     for context, next to the finger rather than under it. -->
		{#if scrub && scrubItem}
			<div
				bind:clientHeight={previewHeight}
				class="absolute right-full mr-3 pointer-events-none z-30 w-[min(280px,calc(100vw-5rem))] px-3 py-2.5 rounded-xl shadow-lg transition-opacity duration-100
					bg-white/95 text-slate-900 ring-1 ring-slate-200
					dark:bg-slate-700/95 dark:text-white dark:ring-0
					{scrub.cancel ? 'opacity-50' : 'opacity-100'}"
				style="top: {previewTop}px"
				aria-live="polite"
			>
				<div class="text-2xs font-medium text-slate-500 dark:text-slate-400 mb-1">
					Prompt {scrub.idx + 1} of {items.length}
				</div>
				{#if scrubPrev}
					<div class="text-xs text-slate-400 dark:text-slate-400 truncate">{previewText(scrubPrev.text)}</div>
				{/if}
				<div class="text-sm leading-snug font-medium line-clamp-4 break-words my-1">
					{previewText(scrubItem.text)}
				</div>
				{#if scrubNext}
					<div class="text-xs text-slate-400 dark:text-slate-400 truncate">{previewText(scrubNext.text)}</div>
				{/if}
				<div class="mt-1.5 text-2xs text-slate-400 dark:text-slate-400">
					{scrub.cancel ? 'Release to cancel' : 'Release to jump · slide left to cancel'}
				</div>
			</div>
		{/if}
	</div>
{/if}

{#if !isUserAtBottom}
	<button
		type="button"
		onclick={jumpToBottom}
		in:fade={{ duration: 150 }}
		out:fade={{ duration: 100 }}
		class="absolute right-3 lg:right-4 bottom-3 lg:bottom-4 z-30 flex items-center justify-center w-9 h-9 rounded-full bg-white/95 dark:bg-slate-700/95 backdrop-blur-sm ring-1 ring-slate-200 dark:ring-slate-600 shadow-lg text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors"
		aria-label="Scroll to bottom"
	>
		<Icon name="lucide:arrow-down" class="w-4 h-4" />
	</button>
{/if}
