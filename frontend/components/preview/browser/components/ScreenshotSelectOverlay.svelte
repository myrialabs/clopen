<script lang="ts">
	/**
	 * Area and element pickers for screenshots, laid over the page.
	 *
	 * Sized to the screen rect, so a point here maps to the page by plain
	 * proportion: the page is the emulated viewport, whatever size it is drawn
	 * at. Nothing reaches the page while a picker is open — choosing what to
	 * capture must not click it.
	 */
	import { onDestroy } from 'svelte';
	import type { ViewportSize } from '$frontend/utils/preview-constants';
	import { elementAt, type PickedElement, type ScreenshotTarget } from '$frontend/services/preview/browser/screenshot.service';
	import type { ScreenshotSelectMode } from '../core/screenshot-controller.svelte';
	import { debug } from '$shared/utils/logger';

	let {
		mode = 'region' as ScreenshotSelectMode,
		tabId = '',
		viewport = { width: 1440, height: 900 } as ViewportSize,
		/** Where the screen sits in the container, as CSS lengths. */
		left = '0px',
		top = '0px',
		width = '0px',
		height = '0px',
		onComplete = (_target: ScreenshotTarget) => {},
		onCancel = () => {}
	} = $props();

	let overlayElement = $state<HTMLDivElement | undefined>();

	// Region drag, in page coordinates.
	let dragStart = $state<{ x: number; y: number } | null>(null);
	let dragEnd = $state<{ x: number; y: number } | null>(null);

	// Element picker.
	let picked = $state<PickedElement | null>(null);
	let depth = $state(0);
	let lastPoint: { x: number; y: number } | null = null;
	/** Touch: where the first tap landed, waiting for the confirming one. */
	let touchArmed = $state<{ x: number; y: number } | null>(null);
	let probeInFlight = false;
	let probeQueued = false;
	let destroyed = false;

	/** Pixels on screen per page pixel. */
	let screenScale = $state(1);

	function toPage(event: PointerEvent): { x: number; y: number } | null {
		const rect = overlayElement?.getBoundingClientRect();
		if (!rect || rect.width === 0 || rect.height === 0) return null;
		screenScale = rect.width / viewport.width;
		return {
			x: Math.min(viewport.width, Math.max(0, ((event.clientX - rect.left) / rect.width) * viewport.width)),
			y: Math.min(viewport.height, Math.max(0, ((event.clientY - rect.top) / rect.height) * viewport.height))
		};
	}

	const region = $derived.by(() => {
		if (!dragStart || !dragEnd) return null;
		return {
			x: Math.min(dragStart.x, dragEnd.x),
			y: Math.min(dragStart.y, dragEnd.y),
			width: Math.abs(dragEnd.x - dragStart.x),
			height: Math.abs(dragEnd.y - dragStart.y)
		};
	});

	/**
	 * Ask the page what is under the pointer — one request at a time, the
	 * latest point winning, so a fast sweep does not queue a backlog of
	 * answers for places the pointer has already left.
	 */
	async function probe() {
		if (!lastPoint || !tabId) return;
		if (probeInFlight) {
			probeQueued = true;
			return;
		}
		probeInFlight = true;
		const point = lastPoint;
		try {
			const element = await elementAt(tabId, point.x, point.y, depth);
			if (!destroyed) picked = element;
		} catch (error) {
			debug.warn('preview', 'Element probe failed:', error);
		} finally {
			probeInFlight = false;
			if (probeQueued && !destroyed) {
				probeQueued = false;
				void probe();
			}
		}
	}

	function handlePointerDown(event: PointerEvent) {
		event.preventDefault();
		event.stopPropagation();
		const point = toPage(event);
		if (!point) return;

		if (mode === 'region') {
			overlayElement?.setPointerCapture(event.pointerId);
			dragStart = point;
			dragEnd = point;
			return;
		}

		if (event.pointerType === 'mouse') return;

		// No hover on touch: the first tap shows what would be captured, a
		// second one on the same spot captures it.
		if (touchArmed && picked && Math.abs(touchArmed.x - point.x) < 12 && Math.abs(touchArmed.y - point.y) < 12) {
			onComplete({ kind: 'element', x: touchArmed.x, y: touchArmed.y, depth });
			return;
		}
		touchArmed = point;
		lastPoint = point;
		depth = 0;
		void probe();
	}

	function handlePointerMove(event: PointerEvent) {
		event.preventDefault();
		event.stopPropagation();
		const point = toPage(event);
		if (!point) return;

		if (mode === 'region') {
			if (dragStart) dragEnd = point;
			return;
		}

		if (event.pointerType === 'mouse') {
			const moved = !lastPoint || Math.abs(lastPoint.x - point.x) > 1 || Math.abs(lastPoint.y - point.y) > 1;
			lastPoint = point;
			if (moved) {
				depth = 0;
				void probe();
			}
		}
	}

	function handlePointerUp(event: PointerEvent) {
		event.preventDefault();
		event.stopPropagation();

		if (mode === 'region') {
			const selected = region;
			dragStart = null;
			dragEnd = null;
			// A click without a drag selects nothing — and is not a mistake to report.
			if (selected && selected.width >= 4 && selected.height >= 4) {
				onComplete({ kind: 'region', ...selected });
			}
			return;
		}

		if (event.pointerType !== 'mouse') return;
		const point = toPage(event) ?? lastPoint;
		if (point) onComplete({ kind: 'element', x: point.x, y: point.y, depth });
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onCancel();
			return;
		}
		if (mode !== 'element' || !lastPoint) return;

		if (event.key === 'ArrowUp' && picked?.hasParent) {
			event.preventDefault();
			event.stopPropagation();
			depth = picked.depth + 1;
			void probe();
		} else if (event.key === 'ArrowDown' && depth > 0) {
			event.preventDefault();
			event.stopPropagation();
			depth -= 1;
			void probe();
		} else if (event.key === 'Enter' && picked) {
			event.preventDefault();
			event.stopPropagation();
			onComplete({ kind: 'element', x: lastPoint.x, y: lastPoint.y, depth });
		}
	}

	onDestroy(() => {
		destroyed = true;
	});

	const hint = $derived(
		mode === 'region'
			? 'Drag to select an area · Esc to cancel'
			: picked
				? touchArmed
					? `${picked.label} · tap it again to capture`
					: `${picked.label} · ${Math.round(picked.rect.width)}×${Math.round(picked.rect.height)} · ↑ parent · ↓ child · Esc to cancel`
				: 'Point at an element and click it · Esc to cancel'
	);
</script>

<svelte:window onkeydowncapture={handleKeydown} />

<div
	bind:this={overlayElement}
	class="absolute z-40 cursor-crosshair touch-none select-none overflow-hidden bg-slate-900/10"
	style="left: {left}; top: {top}; width: {width}; height: {height};"
	role="presentation"
	onpointerdown={handlePointerDown}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
	onpointercancel={() => {
		dragStart = null;
		dragEnd = null;
	}}
	oncontextmenu={(event) => {
		event.preventDefault();
		onCancel();
	}}
>
	{#if mode === 'region' && region}
		<div
			class="pointer-events-none absolute border-2 border-violet-500 bg-violet-500/10 shadow-[0_0_0_9999px_rgba(15,23,42,0.35)]"
			style="left: {region.x * screenScale}px; top: {region.y * screenScale}px; width: {region.width * screenScale}px; height: {region.height * screenScale}px;"
		>
			<span class="absolute -top-6 left-0 whitespace-nowrap rounded bg-slate-900/85 px-1.5 py-0.5 text-2xs font-medium tabular-nums text-white">
				{Math.round(region.width)} × {Math.round(region.height)}
			</span>
		</div>
	{/if}

	{#if mode === 'element' && picked}
		<div
			class="pointer-events-none absolute border-2 border-violet-500 bg-violet-500/15 transition-all duration-75"
			style="left: {picked.rect.x * screenScale}px; top: {picked.rect.y * screenScale}px; width: {picked.rect.width * screenScale}px; height: {picked.rect.height * screenScale}px;"
		></div>
	{/if}

	<div class="pointer-events-none absolute inset-x-0 top-2 flex justify-center gap-1.5 px-2">
		<span class="min-w-0 truncate rounded-full bg-slate-900/85 px-3 py-1 text-xs font-medium text-white shadow-lg">
			{hint}
		</span>
		<!-- Esc is not on every keyboard a phone shows, or on a phone at all. -->
		<button
			type="button"
			class="pointer-events-auto shrink-0 rounded-full bg-slate-900/85 px-3 py-1 text-xs font-medium text-white shadow-lg hover:bg-slate-900"
			onpointerdown={(event) => event.stopPropagation()}
			onpointerup={(event) => event.stopPropagation()}
			onclick={(event) => {
				event.stopPropagation();
				onCancel();
			}}
		>
			Cancel
		</button>
	</div>
</div>
