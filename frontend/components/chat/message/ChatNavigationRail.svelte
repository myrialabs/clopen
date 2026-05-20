<script lang="ts">
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import Icon from '$frontend/components/common/display/Icon.svelte';

	export interface NavItem {
		globalIndex: number;
		messageId: string;
		text: string;
		sender?: string;
	}

	interface Props {
		scrollEl: HTMLElement | undefined;
		items: NavItem[];
		isUserAtBottom: boolean;
		onJump: (item: NavItem) => void;
		onJumpToBottom: () => void;
	}

	const { scrollEl, items, isUserAtBottom, onJump, onJumpToBottom }: Props = $props();

	type HoverKey = string | 'up' | 'down' | null;
	let hovered = $state<HoverKey>(null);
	let activeId = $state<string | null>(null);
	let rafId = 0;
	let lockUntil = 0;

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

	function updateActive() {
		if (!scrollEl || items.length === 0) return;
		if (Date.now() < lockUntil) return;

		const scrollRect = scrollEl.getBoundingClientRect();
		const viewportCenter = scrollRect.height / 2;
		const idSet = new Set(items.map(i => i.messageId));

		let bestId: string | null = null;
		let bestDist = Infinity;

		const nodes = scrollEl.querySelectorAll<HTMLElement>('[data-message-id]');
		for (const el of nodes) {
			const id = el.getAttribute('data-message-id');
			if (!id || !idSet.has(id)) continue;

			const rect = el.getBoundingClientRect();
			const relTop = rect.top - scrollRect.top;
			const relBottom = relTop + rect.height;

			let dist: number;
			if (viewportCenter < relTop) dist = relTop - viewportCenter;
			else if (viewportCenter > relBottom) dist = viewportCenter - relBottom;
			else dist = 0;

			if (dist < bestDist) {
				bestDist = dist;
				bestId = id;
			}
		}

		if (bestId) activeId = bestId;
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

	onMount(() => {
		return () => {
			if (rafId) cancelAnimationFrame(rafId);
		};
	});

	function previewText(text: string): string {
		const clean = text.replace(/\s+/g, ' ').trim();
		return clean.length > 120 ? clean.slice(0, 120) + '…' : clean;
	}

	function jumpTo(item: NavItem) {
		activeId = item.messageId;
		lockUntil = Date.now() + 700;
		onJump(item);
	}

	function goUp() {
		if (upTarget) jumpTo(upTarget);
	}

	function goDown() {
		if (downTarget) jumpTo(downTarget);
	}
</script>

{#snippet tooltip(item: NavItem)}
	<div
		class="absolute right-full top-1/2 -translate-y-1/2 mr-3 px-3 py-2 rounded-xl shadow-lg pointer-events-none z-30 max-w-[260px] w-max
			bg-white/95 text-slate-900 ring-1 ring-slate-200
			dark:bg-slate-700/95 dark:text-white dark:ring-0"
	>
		{#if item.sender}
			<div class="text-xs text-slate-500 dark:text-slate-400 mb-0.5 font-medium">
				{item.sender}
			</div>
		{/if}
		<div class="text-sm leading-snug line-clamp-2 break-words">
			{previewText(item.text)}
		</div>
	</div>
{/snippet}

{#if items.length >= 1}
	<div
		class="absolute right-3 lg:right-4 top-3 bottom-14 lg:bottom-16 w-8 pointer-events-none z-20 flex flex-col items-center justify-center"
		aria-hidden="false"
	>
		<div
			class="pointer-events-auto flex flex-col items-center rounded-full py-2 bg-white/30 dark:bg-slate-900/20 backdrop-blur-sm ring-1 ring-slate-200/40 dark:ring-slate-700/40 opacity-40 hover:opacity-100 transition-opacity duration-200"
		>
		<div class="relative">
			<button
				type="button"
				onclick={goUp}
				onmouseenter={() => (hovered = 'up')}
				onmouseleave={() => (hovered = null)}
				onfocus={() => (hovered = 'up')}
				onblur={() => (hovered = null)}
				disabled={!canGoUp}
				class="flex p-0.5 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
				aria-label="Previous user message"
			>
				<Icon name="lucide:chevron-up" class="w-4 h-4" />
			</button>
			{#if hovered === 'up' && upTarget}
				{@render tooltip(upTarget)}
			{/if}
		</div>

		<div class="flex flex-col items-center gap-0.5 py-1.5">
			{#each items as item, idx (item.messageId)}
				{@const active = activeId === item.messageId}
				<div class="relative">
					<button
						type="button"
						onclick={() => jumpTo(item)}
						onmouseenter={() => (hovered = item.messageId)}
						onmouseleave={() => (hovered = null)}
						onfocus={() => (hovered = item.messageId)}
						onblur={() => (hovered = null)}
						class="flex items-center justify-center w-6 py-1.5 cursor-pointer group"
						aria-label="Jump to user message {idx + 1} of {items.length}: {previewText(item.text)}"
					>
						<span
							class="block h-px rounded-full transition-all duration-150
								{active
									? 'w-4 bg-slate-600 dark:bg-slate-300'
									: 'w-2 bg-slate-400 dark:bg-slate-500 group-hover:w-3 group-hover:bg-slate-600 dark:group-hover:bg-slate-300'}"
						></span>
					</button>
					{#if hovered === item.messageId}
						{@render tooltip(item)}
					{/if}
				</div>
			{/each}
		</div>

		<div class="relative">
			<button
				type="button"
				onclick={goDown}
				onmouseenter={() => (hovered = 'down')}
				onmouseleave={() => (hovered = null)}
				onfocus={() => (hovered = 'down')}
				onblur={() => (hovered = null)}
				disabled={!canGoDown}
				class="flex p-0.5 text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
				aria-label="Next user message"
			>
				<Icon name="lucide:chevron-down" class="w-4 h-4" />
			</button>
			{#if hovered === 'down' && downTarget}
				{@render tooltip(downTarget)}
			{/if}
		</div>
		</div>
	</div>
{/if}

{#if !isUserAtBottom}
	<button
		type="button"
		onclick={onJumpToBottom}
		in:fade={{ duration: 150 }}
		out:fade={{ duration: 100 }}
		class="absolute right-3 lg:right-4 bottom-3 lg:bottom-4 z-30 flex items-center justify-center w-9 h-9 rounded-full bg-white/95 dark:bg-slate-700/95 backdrop-blur-sm ring-1 ring-slate-200 dark:ring-slate-600 shadow-lg text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors"
		aria-label="Scroll to bottom"
	>
		<Icon name="lucide:arrow-down" class="w-4 h-4" />
	</button>
{/if}
