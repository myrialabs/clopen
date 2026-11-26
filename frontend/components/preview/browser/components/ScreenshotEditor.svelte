<script lang="ts">
	/**
	 * Mark up a screenshot before it goes anywhere.
	 *
	 * Boxes, arrows, a pen and text, a crop, and — for a capture of the whole
	 * screen — the device around it. Edits are vector shapes in image pixels,
	 * drawn onto the picture only when it is handed over, so an untouched
	 * capture leaves exactly as the browser rendered it.
	 *
	 * Several images (one per device size) are edited one at a time and
	 * handed over together.
	 */
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import type { PageColors } from '$frontend/utils/preview-constants';
	import { hasOpenChat, type ScreenshotImage } from '$frontend/services/preview/browser/screenshot.service';
	import {
		canFrame,
		encodeCanvas,
		preferences,
		type ScreenshotDelivery,
		type ScreenshotOutput
	} from '../core/screenshot-controller.svelte';
	import { renderInDeviceFrame } from '$shared/utils/device-frame';
	import { untrack } from 'svelte';
	import { debug } from '$shared/utils/logger';

	let {
		images = null as ScreenshotImage[] | null,
		pageColors = null as PageColors | null,
		onDeliver = (_action: ScreenshotDelivery, _outputs: Promise<ScreenshotOutput[]>) => {},
		onClose = () => {}
	} = $props();

	type Tool = 'crop' | 'rect' | 'arrow' | 'pen' | 'text';
	type Point = { x: number; y: number };
	type Rect = { x: number; y: number; width: number; height: number };
	type Shape =
		| { kind: 'rect'; rect: Rect; color: string; size: number }
		| { kind: 'arrow'; from: Point; to: Point; color: string; size: number }
		| { kind: 'pen'; points: Point[]; color: string; size: number }
		| { kind: 'text'; at: Point; text: string; color: string; size: number };

	interface EditState {
		shapes: Shape[];
		crop: Rect | null;
	}

	interface ImageEdits {
		history: EditState[];
		index: number;
	}

	const TOOLS: Array<{ id: Tool; label: string; icon: IconName }> = [
		{ id: 'rect', label: 'Box', icon: 'lucide:square' },
		{ id: 'arrow', label: 'Arrow', icon: 'lucide:move-up-right' },
		{ id: 'pen', label: 'Pen', icon: 'lucide:pencil' },
		{ id: 'text', label: 'Text', icon: 'lucide:type' },
		{ id: 'crop', label: 'Crop', icon: 'lucide:crop' }
	];
	const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#0ea5e9', '#8b5cf6', '#ffffff', '#111827'];
	const SIZES = [
		{ id: 1, label: 'S' },
		{ id: 2, label: 'M' },
		{ id: 3, label: 'L' }
	] as const;

	/** Browsers refuse canvases much past this many pixels (iOS Safari: 16.7M). */
	const MAX_CANVAS_PIXELS = 16_000_000;

	let isOpen = $state(false);
	let selected = $state(0);
	let tool = $state<Tool>('rect');
	let color = $state(COLORS[0]);
	let size = $state<1 | 2 | 3>(2);
	let withFrame = $state(false);
	let edits = $state<ImageEdits[]>([]);
	let bitmaps = $state<(ImageBitmap | null)[]>([]);
	let isWorking = $state(false);

	let canvasElement = $state<HTMLCanvasElement | undefined>();
	let draft = $state<Shape | null>(null);
	let cropDraft = $state<Rect | null>(null);
	let pointerStart: Point | null = null;

	/** Text being typed, in image pixels, with where its box sits on screen. */
	let textDraft = $state<{ at: Point; screen: Point; value: string } | null>(null);
	let textInput = $state<HTMLInputElement | undefined>();

	const current = $derived(images?.[selected] ?? null);
	const currentEdits = $derived(edits[selected] ?? null);
	const edit = $derived<EditState>(currentEdits ? currentEdits.history[currentEdits.index] : { shapes: [], crop: null });
	const canUndo = $derived(!!currentEdits && currentEdits.index > 0);
	const canRedo = $derived(!!currentEdits && currentEdits.index < currentEdits.history.length - 1);
	const frameable = $derived(!!current && canFrame(current.meta) && !edit.crop);
	const multiple = $derived((images?.length ?? 0) > 1);
	const chatOpen = $derived(hasOpenChat());

	/** One stroke unit, scaled to the image so marks read the same on any size. */
	const unit = $derived(current ? Math.max(1, current.width / 600) : 1);

	// Load a fresh set of images.
	let loadedFor: ScreenshotImage[] | null = null;
	$effect(() => {
		const list = images;
		if (list === loadedFor) return;
		loadedFor = list;
		untrack(() => {
			for (const bitmap of bitmaps) bitmap?.close();
		});
		bitmaps = [];
		isOpen = !!list && list.length > 0;
		if (!list) return;

		selected = 0;
		edits = list.map(() => ({ history: [{ shapes: [], crop: null }], index: 0 }));
		withFrame = untrack(() => preferences().deviceFrame);
		void Promise.all(list.map((image) => createImageBitmap(image.blob).catch(() => null))).then((decoded) => {
			if (loadedFor === list) bitmaps = decoded;
			else for (const bitmap of decoded) bitmap?.close();
		});
	});

	function commit(next: EditState) {
		const entry = edits[selected];
		if (!entry) return;
		const history = [...entry.history.slice(0, entry.index + 1), next];
		edits[selected] = { history, index: history.length - 1 };
	}

	function undo() {
		const entry = edits[selected];
		if (entry && entry.index > 0) edits[selected] = { ...entry, index: entry.index - 1 };
	}

	function redo() {
		const entry = edits[selected];
		if (entry && entry.index < entry.history.length - 1) edits[selected] = { ...entry, index: entry.index + 1 };
	}

	function clearAll() {
		if (edit.shapes.length === 0 && !edit.crop) return;
		commit({ shapes: [], crop: null });
	}

	// ── Drawing ──────────────────────────────────────────────────────────

	function normalize(a: Point, b: Point): Rect {
		return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
	}

	function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, u: number) {
		ctx.strokeStyle = shape.color;
		ctx.fillStyle = shape.color;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		const stroke = [2, 4, 7][shape.size - 1] * u;
		ctx.lineWidth = stroke;

		switch (shape.kind) {
			case 'rect': {
				ctx.beginPath();
				ctx.roundRect(shape.rect.x, shape.rect.y, shape.rect.width, shape.rect.height, stroke);
				ctx.stroke();
				return;
			}
			case 'arrow': {
				const { from, to } = shape;
				const angle = Math.atan2(to.y - from.y, to.x - from.x);
				const head = stroke * 4;
				ctx.beginPath();
				ctx.moveTo(from.x, from.y);
				ctx.lineTo(to.x - Math.cos(angle) * head * 0.6, to.y - Math.sin(angle) * head * 0.6);
				ctx.stroke();
				ctx.beginPath();
				ctx.moveTo(to.x, to.y);
				ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 7), to.y - head * Math.sin(angle - Math.PI / 7));
				ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 7), to.y - head * Math.sin(angle + Math.PI / 7));
				ctx.closePath();
				ctx.fill();
				return;
			}
			case 'pen': {
				if (shape.points.length < 2) return;
				ctx.beginPath();
				ctx.moveTo(shape.points[0].x, shape.points[0].y);
				for (const point of shape.points.slice(1)) ctx.lineTo(point.x, point.y);
				ctx.stroke();
				return;
			}
			case 'text': {
				const fontSize = [16, 24, 34][shape.size - 1] * u;
				ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
				ctx.textBaseline = 'top';
				// A halo keeps text legible on any part of the page.
				ctx.lineWidth = fontSize / 5;
				ctx.strokeStyle = shape.color === '#ffffff' ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.85)';
				ctx.strokeText(shape.text, shape.at.x, shape.at.y);
				ctx.fillText(shape.text, shape.at.x, shape.at.y);
				return;
			}
		}
	}

	/** The picture with its marks, full size, before crop and frame. */
	function paint(ctx: CanvasRenderingContext2D, bitmap: ImageBitmap, shapes: Shape[], u: number) {
		ctx.drawImage(bitmap, 0, 0);
		for (const shape of shapes) drawShape(ctx, shape, u);
	}

	/** Display scale for the on-screen canvas — below 1 only for images too big to hold. */
	const displayScale = $derived(
		current ? Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (current.width * current.height))) : 1
	);

	$effect(() => {
		const canvas = canvasElement;
		const bitmap = bitmaps[selected];
		const image = current;
		if (!canvas || !bitmap || !image) return;

		const scale = displayScale;
		canvas.width = Math.round(image.width * scale);
		canvas.height = Math.round(image.height * scale);
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		ctx.save();
		ctx.scale(scale, scale);
		paint(ctx, bitmap, draft ? [...edit.shapes, draft] : edit.shapes, unit);

		const crop = cropDraft ?? edit.crop;
		if (crop) {
			// Dim everything the crop leaves out.
			ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
			ctx.beginPath();
			ctx.rect(0, 0, image.width, image.height);
			ctx.rect(crop.x, crop.y, crop.width, crop.height);
			ctx.fill('evenodd');
			ctx.setLineDash([8 * unit, 6 * unit]);
			ctx.strokeStyle = '#ffffff';
			ctx.lineWidth = 2 * unit;
			ctx.strokeRect(crop.x, crop.y, crop.width, crop.height);
			ctx.setLineDash([]);
		}
		ctx.restore();
	});

	function toImage(event: PointerEvent): Point | null {
		const canvas = canvasElement;
		const image = current;
		if (!canvas || !image) return null;
		const rect = canvas.getBoundingClientRect();
		return {
			x: Math.min(image.width, Math.max(0, ((event.clientX - rect.left) / rect.width) * image.width)),
			y: Math.min(image.height, Math.max(0, ((event.clientY - rect.top) / rect.height) * image.height))
		};
	}

	function commitText() {
		const pending = textDraft;
		textDraft = null;
		if (!pending || !pending.value.trim()) return;
		commit({ ...edit, shapes: [...edit.shapes, { kind: 'text', at: pending.at, text: pending.value.trim(), color, size }] });
	}

	function handlePointerDown(event: PointerEvent) {
		const point = toImage(event);
		if (!point || !canvasElement) return;
		event.preventDefault();

		if (tool === 'text') {
			commitText();
			const rect = canvasElement.getBoundingClientRect();
			const host = canvasElement.parentElement?.getBoundingClientRect() ?? rect;
			textDraft = { at: point, screen: { x: event.clientX - host.left, y: event.clientY - host.top }, value: '' };
			setTimeout(() => textInput?.focus(), 0);
			return;
		}

		canvasElement.setPointerCapture(event.pointerId);
		pointerStart = point;
		if (tool === 'crop') cropDraft = { ...point, width: 0, height: 0 };
		else if (tool === 'pen') draft = { kind: 'pen', points: [point], color, size };
		else if (tool === 'rect') draft = { kind: 'rect', rect: { ...point, width: 0, height: 0 }, color, size };
		else draft = { kind: 'arrow', from: point, to: point, color, size };
	}

	function handlePointerMove(event: PointerEvent) {
		if (!pointerStart) return;
		const point = toImage(event);
		if (!point) return;

		if (tool === 'crop') cropDraft = normalize(pointerStart, point);
		else if (draft?.kind === 'pen') draft = { ...draft, points: [...draft.points, point] };
		else if (draft?.kind === 'rect') draft = { ...draft, rect: normalize(pointerStart, point) };
		else if (draft?.kind === 'arrow') draft = { ...draft, to: point };
	}

	function handlePointerUp() {
		if (!pointerStart) return;
		pointerStart = null;
		const minimum = 4 * unit;

		if (tool === 'crop') {
			const crop = cropDraft;
			cropDraft = null;
			if (crop && crop.width >= minimum && crop.height >= minimum) {
				commit({ ...edit, crop: { x: Math.round(crop.x), y: Math.round(crop.y), width: Math.round(crop.width), height: Math.round(crop.height) } });
			}
			return;
		}

		const shape = draft;
		draft = null;
		if (!shape) return;
		const big =
			shape.kind === 'pen'
				? shape.points.length > 1
				: shape.kind === 'rect'
					? shape.rect.width >= minimum && shape.rect.height >= minimum
					: shape.kind === 'arrow'
						? Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) >= minimum
						: true;
		if (big) commit({ ...edit, shapes: [...edit.shapes, shape] });
	}

	// ── Export ───────────────────────────────────────────────────────────

	/** One image as it will be handed over. */
	async function render(index: number): Promise<ScreenshotOutput> {
		const image = images![index];
		const target = edits[index].history[edits[index].index];
		const frame = withFrame && canFrame(image.meta) && !target.crop;
		const { format, quality } = preferences();
		const untouched = target.shapes.length === 0 && !target.crop && !frame;

		// Nothing was changed: hand over exactly what the browser rendered.
		if (untouched && (format === 'png') === (image.blob.type === 'image/png')) {
			return { blob: image.blob, meta: image.meta };
		}

		const bitmap = bitmaps[index] ?? (await createImageBitmap(image.blob));
		const full = document.createElement('canvas');
		full.width = image.width;
		full.height = image.height;
		const ctx = full.getContext('2d');
		if (!ctx) throw new Error('This image is too large for this browser to edit');
		paint(ctx, bitmap, target.shapes, Math.max(1, image.width / 600));

		let output: HTMLCanvasElement = full;
		const crop = target.crop;
		if (crop) {
			output = document.createElement('canvas');
			output.width = crop.width;
			output.height = crop.height;
			output.getContext('2d')?.drawImage(full, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
		} else if (frame) {
			const framed = renderInDeviceFrame(full, { ...image.meta, pageColors });
			if (!framed) throw new Error('This device has no frame to draw');
			output = framed;
		}

		try {
			return { blob: await encodeCanvas(output, format, quality), meta: image.meta };
		} catch {
			throw new Error('This image is too large for this browser to encode — try a smaller area');
		}
	}

	function deliver(action: ScreenshotDelivery) {
		if (!images) return;
		commitText();
		// Copy takes the image on screen; the clipboard holds one picture.
		const indices = action === 'copy' || !multiple ? [selected] : images.map((_, index) => index);
		isWorking = true;
		const outputs = Promise.all(indices.map((index) => render(index)));
		// Passed on before it settles: a copy has to start inside this click.
		onDeliver(action, outputs);
		outputs
			.then(() => {
				if (action === 'attach' || action === 'save') close();
			})
			.catch((error) => debug.warn('preview', 'Screenshot export failed:', error))
			.finally(() => (isWorking = false));
	}

	function close() {
		textDraft = null;
		isOpen = false;
		for (const bitmap of bitmaps) bitmap?.close();
		bitmaps = [];
		loadedFor = null;
		onClose();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (!isOpen || textDraft) return;
		const mod = event.metaKey || event.ctrlKey;
		if (mod && event.key.toLowerCase() === 'z') {
			event.preventDefault();
			if (event.shiftKey) redo();
			else undo();
		}
	}

	const deviceLabel: Record<string, string> = {
		mobile: 'Phone',
		tablet: 'Tablet',
		laptop: 'Laptop',
		desktop: 'Desktop',
		responsive: 'Responsive'
	};
</script>

<svelte:window onkeydowncapture={handleKeydown} />

<Modal bind:isOpen onClose={close} size="full" mobileFullscreen className="h-[calc(100dvh-2rem)]">
	{#snippet header()}
		<div class="flex items-center justify-between gap-3 px-4 py-3">
			<div class="min-w-0">
				<h2 class="text-base font-bold text-slate-900 dark:text-slate-100">Screenshot</h2>
				{#if current}
					<p class="truncate text-xs text-slate-500">
						{current.meta.title || current.meta.url} · {current.width}×{current.height}
					</p>
				{/if}
			</div>
			<button
				type="button"
				class="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
				onclick={close}
				aria-label="Close"
			>
				<Icon name="lucide:x" class="h-5 w-5" />
			</button>
		</div>
	{/snippet}

	<div class="flex h-full min-h-0 flex-col gap-3">
		<!-- Tools -->
		<div class="flex flex-wrap items-center gap-2">
			<div class="flex overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
				{#each TOOLS as item (item.id)}
					<button
						type="button"
						onclick={() => {
							commitText();
							tool = item.id;
						}}
						class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors {tool === item.id
							? 'bg-violet-500 text-white'
							: 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}"
						title={item.label}
						aria-pressed={tool === item.id}
					>
						<Icon name={item.icon} class="h-3.5 w-3.5" />
						<span class="max-sm:hidden">{item.label}</span>
					</button>
				{/each}
			</div>

			<div class="flex items-center gap-1">
				{#each COLORS as swatch (swatch)}
					<button
						type="button"
						onclick={() => (color = swatch)}
						class="h-5 w-5 rounded-full border border-slate-300 dark:border-slate-600 {color === swatch
							? 'ring-2 ring-violet-500 ring-offset-1 dark:ring-offset-slate-900'
							: ''}"
						style="background: {swatch};"
						title="Colour"
						aria-label="Colour {swatch}"
					></button>
				{/each}
			</div>

			<div class="flex overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
				{#each SIZES as option (option.id)}
					<button
						type="button"
						onclick={() => (size = option.id)}
						class="px-2 py-1 text-xs font-medium transition-colors {size === option.id
							? 'bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900'
							: 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}"
						title="Stroke size"
					>
						{option.label}
					</button>
				{/each}
			</div>

			<div class="flex items-center gap-0.5">
				<button
					type="button"
					onclick={undo}
					disabled={!canUndo}
					class="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-35 dark:hover:bg-slate-800"
					title="Undo"
					aria-label="Undo"
				>
					<Icon name="lucide:undo-2" class="h-4 w-4" />
				</button>
				<button
					type="button"
					onclick={redo}
					disabled={!canRedo}
					class="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-35 dark:hover:bg-slate-800"
					title="Redo"
					aria-label="Redo"
				>
					<Icon name="lucide:redo-2" class="h-4 w-4" />
				</button>
				<button
					type="button"
					onclick={clearAll}
					disabled={edit.shapes.length === 0 && !edit.crop}
					class="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-35 dark:hover:bg-slate-800"
					title="Remove all marks and the crop"
					aria-label="Remove all marks and the crop"
				>
					<Icon name="lucide:trash-2" class="h-4 w-4" />
				</button>
			</div>

			<label
				class="ml-auto flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 {frameable ? '' : 'opacity-50'}"
				title={frameable
					? 'Draw the device around the screenshot'
					: edit.crop
						? 'A cropped image does not fit a device frame'
						: 'Only a capture of the whole screen fits a device frame'}
			>
				<input type="checkbox" class="accent-violet-600" bind:checked={withFrame} disabled={!frameable} />
				Device frame
			</label>
		</div>

		{#if multiple && images}
			<div class="flex gap-2 overflow-x-auto pb-1">
				{#each images as image, index (index)}
					<button
						type="button"
						onclick={() => {
							commitText();
							selected = index;
						}}
						class="flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors {selected === index
							? 'border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300'
							: 'border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'}"
					>
						{deviceLabel[image.meta.deviceSize] ?? image.meta.deviceSize}
						<span class="tabular-nums text-slate-400">{image.meta.viewport.width}×{image.meta.viewport.height}</span>
					</button>
				{/each}
			</div>
		{/if}

		<!-- Stage -->
		<div class="relative flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg bg-slate-100 p-3 dark:bg-slate-950">
			{#if bitmaps[selected]}
				<div class="relative max-h-full max-w-full">
					<canvas
						bind:this={canvasElement}
						class="block max-h-[calc(100dvh-16rem)] max-w-full touch-none object-contain shadow-lg {tool === 'text' ? 'cursor-text' : 'cursor-crosshair'}"
						onpointerdown={handlePointerDown}
						onpointermove={handlePointerMove}
						onpointerup={handlePointerUp}
						onpointercancel={handlePointerUp}
					></canvas>
					{#if textDraft}
						<input
							bind:this={textInput}
							bind:value={textDraft.value}
							class="absolute rounded border border-violet-500 bg-white/90 px-1 py-0.5 text-sm font-semibold outline-none dark:bg-slate-900/90"
							style="left: {textDraft.screen.x}px; top: {textDraft.screen.y}px; color: {color}; min-width: 8rem;"
							placeholder="Type, then Enter"
							onkeydown={(event) => {
								event.stopPropagation();
								if (event.key === 'Enter') commitText();
								else if (event.key === 'Escape') textDraft = null;
							}}
							onblur={() => {
								// Deferred: a click elsewhere on the picture commits this text
								// and starts the next one before the blur arrives, and the
								// blur must not then commit — and close — the new, empty one.
								const blurred = textDraft;
								setTimeout(() => {
									if (textDraft === blurred) commitText();
								}, 0);
							}}
						/>
					{/if}
				</div>
			{:else}
				<Icon name="lucide:loader-circle" class="h-8 w-8 animate-spin text-violet-600" />
			{/if}
		</div>
	</div>

	{#snippet footer()}
		<div class="flex w-full flex-wrap items-center justify-end gap-2">
			{#if multiple}
				<span class="mr-auto text-xs text-slate-500">Download, attach and save apply to all {images?.length} images</span>
			{/if}
			<button
				type="button"
				onclick={() => deliver('copy')}
				disabled={isWorking}
				class="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
			>
				<Icon name="lucide:copy" class="h-4 w-4" />
				Copy
			</button>
			<button
				type="button"
				onclick={() => deliver('download')}
				disabled={isWorking}
				class="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
			>
				<Icon name="lucide:download" class="h-4 w-4" />
				Download
			</button>
			<button
				type="button"
				onclick={() => deliver('save')}
				disabled={isWorking}
				class="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
				title="Into {preferences().folder}/ in the project"
			>
				<Icon name="lucide:folder-down" class="h-4 w-4" />
				Save to project
			</button>
			<button
				type="button"
				onclick={() => deliver('attach')}
				disabled={isWorking || !chatOpen}
				class="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
				title={chatOpen ? 'Add to the open chat’s message box' : 'Open a chat first'}
			>
				<Icon name="lucide:paperclip" class="h-4 w-4" />
				Attach to chat
			</button>
		</div>
	{/snippet}
</Modal>
