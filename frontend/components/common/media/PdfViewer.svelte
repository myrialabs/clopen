<!--
  PDF viewer drawn with PDF.js, so a PDF reads the same on every device: all
  pages, scrollable, zoomable, with selectable text. Only the pages on (or near)
  the screen are drawn, and pages far away give their canvas back — a long PDF
  on a phone stays within the browser's canvas memory.
-->
<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import LoadingSpinner from '$frontend/components/common/feedback/LoadingSpinner.svelte';
	import { loadPdfjs, PDFJS_DOCUMENT_OPTIONS } from '$frontend/utils/pdfjs';
	import { debug } from '$shared/utils/logger';
	import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask, TextLayer } from 'pdfjs-dist';

	interface Props {
		/** The PDF's bytes. */
		data: Blob;
		fileName: string;
		/** Called when the document can't be shown, so the caller can offer the file instead. */
		onFailed?: (message: string) => void;
		/**
		 * Offer the browser's own viewer (search, print) and a download. Off
		 * where the surrounding window already has them.
		 */
		fileActions?: boolean;
	}

	const { data, fileName, onFailed, fileActions = true }: Props = $props();

	function openInNewTab() {
		const url = URL.createObjectURL(data);
		window.open(url, '_blank', 'noopener');
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	}

	function download() {
		const url = URL.createObjectURL(data);
		const link = document.createElement('a');
		link.href = url;
		link.download = fileName;
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	/** Largest canvas drawn for one page — iOS refuses canvases much bigger. */
	const MAX_CANVAS_PIXELS = 16_000_000;
	const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];
	const PAGE_GAP = 12;
	const SIDE_PADDING = 16;

	let scroller = $state<HTMLDivElement>();
	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let errorMessage = $state('');
	let zoom = $state(1);
	let containerWidth = $state(0);
	let currentPage = $state(1);
	// Each page's size at scale 1. Every page starts with the first page's size
	// and is corrected when it is drawn — fetching all of them up front would
	// parse the whole document before showing anything.
	let pageSizes = $state<Array<{ width: number; height: number }>>([]);

	const fitScale = $derived.by(() => {
		const widest = pageSizes[0]?.width ?? 0;
		if (!widest || !containerWidth) return 1;
		return Math.max(0.1, (containerWidth - SIDE_PADDING * 2) / widest);
	});
	const scale = $derived(fitScale * zoom);

	let pdfjs: Awaited<ReturnType<typeof loadPdfjs>> | null = null;
	let doc: PDFDocumentProxy | null = null;
	let loadingTask: PDFDocumentLoadingTask | null = null;
	let generation = 0;

	interface DrawnPage {
		scale: number;
		task: RenderTask | null;
		text: TextLayer | null;
	}
	const drawn = new Map<number, DrawnPage>();
	const slots = new Map<number, HTMLElement>();
	const nearby = new Set<number>();
	let observer: IntersectionObserver | null = null;

	function releasePage(pageNumber: number) {
		const page = drawn.get(pageNumber);
		if (!page) return;
		page.task?.cancel();
		page.text?.cancel();
		drawn.delete(pageNumber);
		const slot = slots.get(pageNumber);
		if (slot) {
			// A zero-size canvas hands its memory back right away (iOS keeps it otherwise).
			for (const canvas of Array.from(slot.querySelectorAll('canvas'))) {
				canvas.width = 0;
				canvas.height = 0;
			}
			slot.replaceChildren();
		}
	}

	function closeDocument() {
		for (const pageNumber of Array.from(drawn.keys())) releasePage(pageNumber);
		nearby.clear();
		void loadingTask?.destroy();
		loadingTask = null;
		doc = null;
	}

	async function open(blob: Blob) {
		const current = ++generation;
		closeDocument();
		status = 'loading';
		pageSizes = [];
		zoom = 1;
		currentPage = 1;
		try {
			pdfjs = await loadPdfjs();
			const bytes = new Uint8Array(await blob.arrayBuffer());
			if (current !== generation) return;
			const task = pdfjs.getDocument({ data: bytes, ...PDFJS_DOCUMENT_OPTIONS });
			loadingTask = task;
			const pdf = await task.promise;
			if (current !== generation) return;
			doc = pdf;
			const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
			if (current !== generation) return;
			pageSizes = Array.from({ length: pdf.numPages }, () => ({ width: first.width, height: first.height }));
			status = 'ready';
		} catch (error) {
			if (current !== generation) return;
			const name = (error as { name?: string } | null)?.name;
			errorMessage = name === 'PasswordException'
				? 'This PDF is password-protected.'
				: 'This PDF could not be read.';
			status = 'error';
			debug.warn('file', `PDF preview of ${fileName} failed:`, error);
			onFailed?.(errorMessage);
		}
	}

	async function drawPage(pageNumber: number) {
		const slot = slots.get(pageNumber);
		const pdf = doc;
		// Nothing is drawn before the width is known, or every page would be
		// drawn twice: once at a guess, once fitted.
		if (!slot || !pdf || !pdfjs || !containerWidth) return;
		const targetScale = scale;
		const existing = drawn.get(pageNumber);
		if (existing && existing.scale === targetScale) return;
		existing?.task?.cancel();
		existing?.text?.cancel();

		const entry: DrawnPage = { scale: targetScale, task: null, text: null };
		drawn.set(pageNumber, entry);
		try {
			const page = await pdf.getPage(pageNumber);
			if (drawn.get(pageNumber) !== entry) return;

			const natural = page.getViewport({ scale: 1 });
			const known = pageSizes[pageNumber - 1];
			if (known && (known.width !== natural.width || known.height !== natural.height)) {
				pageSizes[pageNumber - 1] = { width: natural.width, height: natural.height };
			}

			const viewport = page.getViewport({ scale: targetScale });
			const outputScale = Math.min(
				window.devicePixelRatio || 1,
				Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, viewport.width * viewport.height))
			);
			const canvas = document.createElement('canvas');
			canvas.width = Math.floor(viewport.width * outputScale);
			canvas.height = Math.floor(viewport.height * outputScale);
			canvas.className = 'block w-full h-full';

			const task = page.render({
				canvas,
				viewport,
				transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined
			});
			entry.task = task;
			await task.promise;
			if (drawn.get(pageNumber) !== entry) return;
			entry.task = null;

			const textContainer = document.createElement('div');
			textContainer.className = 'pdf-text-layer';
			slot.style.setProperty('--total-scale-factor', String(targetScale));
			// The old drawing stays up until the new one is ready, so zooming never flashes blank.
			for (const old of Array.from(slot.querySelectorAll('canvas'))) {
				old.width = 0;
				old.height = 0;
			}
			slot.replaceChildren(canvas, textContainer);

			const text = new pdfjs.TextLayer({
				textContentSource: page.streamTextContent(),
				container: textContainer,
				viewport
			});
			entry.text = text;
			await text.render();
		} catch (error) {
			if ((error as { name?: string } | null)?.name === 'RenderingCancelledException') return;
			if (drawn.get(pageNumber) === entry) drawn.delete(pageNumber);
			debug.warn('file', `Drawing page ${pageNumber} of ${fileName} failed:`, error);
		}
	}

	function drawNearby() {
		for (const pageNumber of nearby) void drawPage(pageNumber);
	}

	function updateCurrentPage() {
		const el = scroller;
		if (!el) return;
		const middle = el.scrollTop + el.clientHeight / 2;
		let offset = PAGE_GAP;
		for (let i = 0; i < pageSizes.length; i++) {
			offset += pageSizes[i].height * scale + PAGE_GAP;
			if (offset >= middle) {
				currentPage = i + 1;
				return;
			}
		}
		currentPage = pageSizes.length;
	}

	// One observer per scroller: pages within a screen's height are drawn, the
	// rest are released.
	$effect(() => {
		const el = scroller;
		if (!el) return;
		const next = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const pageNumber = Number((entry.target as HTMLElement).dataset.page);
					if (entry.isIntersecting) {
						nearby.add(pageNumber);
						void drawPage(pageNumber);
					} else {
						nearby.delete(pageNumber);
						releasePage(pageNumber);
					}
				}
			},
			{ root: el, rootMargin: '100% 0px' }
		);
		observer = next;
		for (const slot of slots.values()) next.observe(slot);

		const resize = new ResizeObserver((entries) => {
			containerWidth = entries[0]?.contentRect.width ?? 0;
		});
		resize.observe(el);
		return () => {
			next.disconnect();
			resize.disconnect();
			if (observer === next) observer = null;
		};
	});

	function pageSlot(node: HTMLElement, pageNumber: number) {
		slots.set(pageNumber, node);
		observer?.observe(node);
		return {
			destroy() {
				observer?.unobserve(node);
				if (slots.get(pageNumber) === node) slots.delete(pageNumber);
				releasePage(pageNumber);
			}
		};
	}

	// A new zoom or width redraws what is on screen at the new scale.
	$effect(() => {
		void scale;
		untrack(drawNearby);
	});

	$effect(() => {
		const blob = data;
		untrack(() => void open(blob));
	});

	onDestroy(() => {
		generation++;
		closeDocument();
	});

	function zoomBy(direction: 1 | -1) {
		const index = ZOOM_STEPS.findIndex((step) => step >= zoom - 0.001);
		const at = index === -1 ? ZOOM_STEPS.length - 1 : index;
		const next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, at + direction))];
		zoom = next;
	}
</script>

<div class="relative flex flex-col h-full w-full bg-slate-200 dark:bg-slate-950">
	{#if status === 'loading'}
		<div class="flex flex-1 items-center justify-center">
			<LoadingSpinner size="lg" />
		</div>
	{:else if status === 'error'}
		<div class="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-slate-500">
			<Icon name="lucide:file-x" class="w-8 h-8 opacity-50" />
			<span>{errorMessage}</span>
		</div>
	{:else}
		<div
			bind:this={scroller}
			class="flex-1 min-h-0 overflow-auto overscroll-contain"
			onscroll={updateCurrentPage}
		>
			<div class="flex flex-col items-center" style="padding: {PAGE_GAP}px {SIDE_PADDING}px; gap: {PAGE_GAP}px; min-width: fit-content;">
				{#each pageSizes as size, i (i)}
					<div
						use:pageSlot={i + 1}
						data-page={i + 1}
						class="pdf-page relative shrink-0 bg-white shadow-md"
						style="width: {size.width * scale}px; height: {size.height * scale}px;"
					></div>
				{/each}
			</div>
		</div>

		<!-- Page and zoom controls float over the pages -->
		<div class="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1 px-1.5 py-1 rounded-lg bg-slate-900/85 text-white shadow-lg text-xs tabular-nums">
			<span class="px-2">{currentPage} / {pageSizes.length}</span>
			<span class="w-px h-4 bg-white/20"></span>
			<button type="button" class="inline-flex items-center justify-center w-7 h-7 rounded-md hover:bg-white/15 disabled:opacity-40" onclick={() => zoomBy(-1)} disabled={zoom <= ZOOM_STEPS[0]} title="Zoom out" aria-label="Zoom out">
				<Icon name="lucide:minus" class="w-3.5 h-3.5" />
			</button>
			<button type="button" class="px-1.5 h-7 rounded-md hover:bg-white/15 min-w-12" onclick={() => (zoom = 1)} title="Fit to width">
				{Math.round(zoom * 100)}%
			</button>
			<button type="button" class="inline-flex items-center justify-center w-7 h-7 rounded-md hover:bg-white/15 disabled:opacity-40" onclick={() => zoomBy(1)} disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} title="Zoom in" aria-label="Zoom in">
				<Icon name="lucide:plus" class="w-3.5 h-3.5" />
			</button>
			{#if fileActions}
				<span class="w-px h-4 bg-white/20"></span>
				<button type="button" class="inline-flex items-center justify-center w-7 h-7 rounded-md hover:bg-white/15" onclick={openInNewTab} title="Open in the browser's viewer" aria-label="Open in new tab">
					<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
				</button>
				<button type="button" class="inline-flex items-center justify-center w-7 h-7 rounded-md hover:bg-white/15" onclick={download} title="Download" aria-label="Download">
					<Icon name="lucide:download" class="w-3.5 h-3.5" />
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* The parts of PDF.js's text layer CSS selection needs: invisible text laid
	   exactly over the drawn glyphs. */
	.pdf-page {
		--scale-round-x: 1px;
		--scale-round-y: 1px;
	}

	:global(.pdf-text-layer) {
		position: absolute;
		inset: 0;
		overflow: clip;
		line-height: 1;
		text-align: initial;
		-webkit-text-size-adjust: none;
		text-size-adjust: none;
		forced-color-adjust: none;
		transform-origin: 0 0;
		caret-color: CanvasText;
		z-index: 0;
		--min-font-size: 1;
		--text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
		--min-font-size-inv: calc(1 / var(--min-font-size));
	}

	:global(.pdf-text-layer :is(span, br)) {
		color: transparent;
		position: absolute;
		white-space: pre;
		cursor: text;
		transform-origin: 0% 0%;
		user-select: text;
	}

	:global(.pdf-text-layer > :not(.markedContent)),
	:global(.pdf-text-layer .markedContent span:not(.markedContent)) {
		z-index: 1;
		--font-height: 0;
		font-size: calc(var(--text-scale-factor) * var(--font-height));
		--scale-x: 1;
		--rotate: 0deg;
		transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
	}

	:global(.pdf-text-layer .markedContent) {
		display: contents;
	}

	:global(.pdf-text-layer span[role='img']) {
		user-select: none;
		cursor: default;
	}

	:global(.pdf-text-layer ::selection) {
		background: rgb(124 58 237 / 0.3);
		color: transparent;
	}

	:global(.pdf-text-layer br::selection) {
		background: transparent;
	}
</style>
