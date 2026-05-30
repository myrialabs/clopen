<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { scale as scaleTransition } from 'svelte/transition';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import LoadingSpinner from '$frontend/components/common/feedback/LoadingSpinner.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';
	import { formatFileSize } from '$frontend/utils/format';
	import type { FileNode } from '$shared/types/filesystem';
	import type {
		ImageEditFormat,
		ImageEditRecipe,
		ImageEditRegion,
		ImageEditStroke
	} from '$shared/types/filesystem';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		file: FileNode;
		onClose: () => void;
		onSaved?: (info: { path: string }) => void;
	}

	const { file, onClose, onSaved }: Props = $props();

	// Drive the modal's own open flag so Svelte plays the enter/leave transitions.
	// The parent mounts this component, then we flip `modalOpen` true on mount and
	// defer the real `onClose` (unmount) until the leave animation has finished.
	let modalOpen = $state(false);
	let closeTimer: ReturnType<typeof setTimeout> | null = null;
	function requestClose() {
		if (closeTimer) return;
		modalOpen = false;
		closeTimer = setTimeout(onClose, 200);
	}

	// ── Source ─────────────────────────────────────────────────────────────
	let sourceUrl = $state<string | null>(null);
	let baseImage = $state<HTMLImageElement | null>(null);
	let baseModified = $state<string | undefined>(undefined);
	let originalSize = $state(0);
	let isLoading = $state(true);
	let loadError = $state('');
	let naturalWidth = $state(0);
	let naturalHeight = $state(0);

	// ── Transform ──────────────────────────────────────────────────────────
	let rotate = $state<0 | 90 | 180 | 270>(0);
	let flipH = $state(false);
	let flipV = $state(false);
	const orientedWidth = $derived(rotate === 90 || rotate === 270 ? naturalHeight : naturalWidth);
	const orientedHeight = $derived(rotate === 90 || rotate === 270 ? naturalWidth : naturalHeight);

	// ── Adjust ─────────────────────────────────────────────────────────────
	let brightness = $state(1);
	let contrast = $state(1);
	let saturation = $state(1);
	let hue = $state(0);
	let blurAmt = $state(0);
	let grayscale = $state(false);
	let sepia = $state(false);
	let invert = $state(false);

	// ── Resize ─────────────────────────────────────────────────────────────
	let resizeWidth = $state(0);
	let resizeHeight = $state(0);
	let lockAspect = $state(true);

	// ── Output / compression ─────────────────────────────────────────────────
	let format = $state<ImageEditFormat>('png');
	let compress = $state(false);
	let quality = $state(80);
	let lossless = $state(false);
	let bgColor = $state('#ffffff');

	const originalFormat = $derived(extToFormat(file.name));
	const losslessCapable = $derived(format === 'png' || format === 'webp');
	const hasQuality = $derived(
		compress &&
			(format === 'jpeg' ||
				format === 'avif' ||
				((format === 'png' || format === 'webp') && !lossless))
	);
	const canOverwrite = $derived(format === originalFormat);

	const QUALITY_PRESETS: { label: string; value: number }[] = [
		{ label: 'Best', value: 92 },
		{ label: 'Recommended', value: 80 },
		{ label: 'Smallest', value: 60 }
	];

	function applyPreset(value: number) {
		if (losslessCapable) lossless = false;
		quality = value;
	}

	let lastFormatForLossless = '';
	$effect(() => {
		if (format !== lastFormatForLossless) {
			lastFormatForLossless = format;
			lossless = format === 'png';
		}
	});

	// ── Shared style tokens (light + dark) ────────────────────────────────────
	const BTN =
		'bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-slate-200';
	const INPUT =
		'bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 text-slate-900 dark:text-slate-100';
	const HEADING = 'text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400';
	const LABEL_ROW = 'flex justify-between text-slate-500 dark:text-slate-400';
	const LINK = 'text-violet-600 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300';
	const ACTIVE = 'bg-violet-600 text-white';

	// ── Panels / active tool ─────────────────────────────────────────────────
	type Panel = 'crop' | 'adjust' | 'draw' | 'mask' | 'resize' | 'export';
	const PANELS: { id: Panel; icon: IconName; label: string }[] = [
		{ id: 'crop', icon: 'lucide:crop', label: 'Crop' },
		{ id: 'adjust', icon: 'lucide:sliders-horizontal', label: 'Adjust' },
		{ id: 'draw', icon: 'lucide:pencil', label: 'Draw' },
		{ id: 'mask', icon: 'lucide:scan-eye', label: 'Blur' },
		{ id: 'resize', icon: 'lucide:scaling', label: 'Resize' },
		{ id: 'export', icon: 'lucide:settings-2', label: 'Export' }
	];
	let activePanel = $state<Panel>('crop');
	const tool = $derived(
		activePanel === 'draw'
			? 'draw'
			: activePanel === 'mask'
				? 'mask'
				: activePanel === 'crop'
					? 'crop'
					: 'none'
	);

	// ── Crop (stored in oriented source pixels — resize-independent) ──────────
	let cropBox = $state<{ x: number; y: number; w: number; h: number } | null>(null);
	let cropAspect = $state<number | null>(null);
	const ASPECTS: { label: string; value: number | null }[] = [
		{ label: 'Free', value: null },
		{ label: '1:1', value: 1 },
		{ label: '4:3', value: 4 / 3 },
		{ label: '3:2', value: 3 / 2 },
		{ label: '16:9', value: 16 / 9 },
		{ label: '3:4', value: 3 / 4 },
		{ label: '2:3', value: 2 / 3 },
		{ label: '9:16', value: 9 / 16 }
	];

	type CropMode = 'new' | 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
	const CROP_HANDLES: { mode: CropMode; pos: string; size: string; cursor: string }[] = [
		{ mode: 'nw', pos: 'top-0 left-0 -translate-x-1/2 -translate-y-1/2', size: 'w-3 h-3', cursor: 'nwse-resize' },
		{ mode: 'ne', pos: 'top-0 right-0 translate-x-1/2 -translate-y-1/2', size: 'w-3 h-3', cursor: 'nesw-resize' },
		{ mode: 'sw', pos: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2', size: 'w-3 h-3', cursor: 'nesw-resize' },
		{ mode: 'se', pos: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2', size: 'w-3 h-3', cursor: 'nwse-resize' },
		{ mode: 'n', pos: 'top-0 left-1/2 -translate-x-1/2 -translate-y-1/2', size: 'w-4 h-2', cursor: 'ns-resize' },
		{ mode: 's', pos: 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2', size: 'w-4 h-2', cursor: 'ns-resize' },
		{ mode: 'w', pos: 'top-1/2 left-0 -translate-x-1/2 -translate-y-1/2', size: 'w-2 h-4', cursor: 'ew-resize' },
		{ mode: 'e', pos: 'top-1/2 right-0 translate-x-1/2 -translate-y-1/2', size: 'w-2 h-4', cursor: 'ew-resize' }
	];

	// ── Draw (points in oriented source pixels) ───────────────────────────────
	type Stroke = { color: string; size: number; opacity: number; points: { x: number; y: number }[] };
	let strokes = $state<Stroke[]>([]);
	let currentStroke = $state<Stroke | null>(null);
	let penColor = $state('#ef4444');
	let penSize = $state(8);
	let penOpacity = $state(1);
	const SWATCHES = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ffffff', '#000000'];

	type DrawShape = 'free' | 'line' | 'rect' | 'ellipse' | 'arrow';
	let drawShape = $state<DrawShape>('free');
	const DRAW_SHAPES: { id: DrawShape; icon: IconName; label: string }[] = [
		{ id: 'free', icon: 'lucide:pencil', label: 'Free' },
		{ id: 'line', icon: 'lucide:minus', label: 'Line' },
		{ id: 'rect', icon: 'lucide:square', label: 'Box' },
		{ id: 'ellipse', icon: 'lucide:circle', label: 'Ellipse' },
		{ id: 'arrow', icon: 'lucide:arrow-up-right', label: 'Arrow' }
	];
	let shapeStart: { x: number; y: number } | null = null;

	// Build the polyline points for a geometric shape between two corners. All
	// shapes are emitted as plain polylines so the backend renderer is unchanged.
	function shapePoints(a: { x: number; y: number }, b: { x: number; y: number }, shape: DrawShape, size: number) {
		if (shape === 'line') return [a, b];
		if (shape === 'rect') {
			return [
				{ x: a.x, y: a.y },
				{ x: b.x, y: a.y },
				{ x: b.x, y: b.y },
				{ x: a.x, y: b.y },
				{ x: a.x, y: a.y }
			];
		}
		if (shape === 'ellipse') {
			const cx = (a.x + b.x) / 2;
			const cy = (a.y + b.y) / 2;
			const rx = Math.abs(b.x - a.x) / 2;
			const ry = Math.abs(b.y - a.y) / 2;
			const pts: { x: number; y: number }[] = [];
			const N = 48;
			for (let i = 0; i <= N; i++) {
				const t = (i / N) * Math.PI * 2;
				pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
			}
			return pts;
		}
		if (shape === 'arrow') {
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const len = Math.hypot(dx, dy) || 1;
			const ux = dx / len;
			const uy = dy / len;
			const head = Math.max(size * 3, len * 0.18);
			const cos = Math.cos(0.5);
			const sin = Math.sin(0.5);
			const left = { x: b.x - head * (ux * cos - uy * sin), y: b.y - head * (uy * cos + ux * sin) };
			const right = { x: b.x - head * (ux * cos + uy * sin), y: b.y - head * (uy * cos - ux * sin) };
			return [a, b, left, b, right];
		}
		return [a, b];
	}

	// ── Mask (blur / mosaic, in oriented source pixels) ───────────────────────
	type Region = { type: 'blur' | 'pixelate'; x: number; y: number; w: number; h: number; strength: number };
	let regions = $state<Region[]>([]);
	let draftRegion = $state<Region | null>(null);
	let maskType = $state<'blur' | 'pixelate'>('blur');
	let maskStrength = $state(40);
	const RESIZE_WIDTHS = [1920, 1280, 1024, 640];

	// ── Stage sizing ─────────────────────────────────────────────────────────
	let stageWidth = $state(0);
	let stageHeight = $state(0);

	// Pre-resize dimensions (after crop, before the resize step) in source px.
	const preWidth = $derived(cropBox && cropBox.w > 1 ? Math.max(1, Math.round(cropBox.w)) : orientedWidth);
	const preHeight = $derived(cropBox && cropBox.h > 1 ? Math.max(1, Math.round(cropBox.h)) : orientedHeight);

	// True only when the crop frame is meaningfully smaller than the full image.
	const cropIsActive = $derived(
		!!cropBox &&
			cropBox.w > 1 &&
			cropBox.h > 1 &&
			(cropBox.x > 0.5 ||
				cropBox.y > 0.5 ||
				cropBox.w < orientedWidth - 0.5 ||
				cropBox.h < orientedHeight - 0.5)
	);

	// On the Crop tab the full frame is shown (with the adjustable overlay); every
	// other tab shows the image already cropped to the frame.
	const showCropped = $derived(activePanel !== 'crop' && cropIsActive && !!cropBox);
	const viewX = $derived(showCropped && cropBox ? cropBox.x : 0);
	const viewY = $derived(showCropped && cropBox ? cropBox.y : 0);
	const viewW = $derived(showCropped && cropBox ? cropBox.w : orientedWidth);
	const viewH = $derived(showCropped && cropBox ? cropBox.h : orientedHeight);

	// A resize that changes the aspect ratio stretches the live stage so the main
	// preview shows the output proportions (applied only off the Crop tab).
	const previewStretchX = $derived(
		activePanel !== 'crop' && preWidth > 0 ? Math.max(0.05, Math.round(resizeWidth) / preWidth) : 1
	);
	const previewStretchY = $derived(
		activePanel !== 'crop' && preHeight > 0 ? Math.max(0.05, Math.round(resizeHeight) / preHeight) : 1
	);
	// Uniform fit component (brush size / outline widths); scaleX/scaleY add the
	// per-axis resize stretch and drive positions + pointer mapping.
	const fitScale = $derived(
		viewW > 0 && viewH > 0 && stageWidth > 0 && stageHeight > 0
			? Math.min(stageWidth / (viewW * previewStretchX), stageHeight / (viewH * previewStretchY), 1)
			: 1
	);
	const scaleX = $derived(fitScale * previewStretchX);
	const scaleY = $derived(fitScale * previewStretchY);
	// Full image size in display px, and the visible (cropped) viewport size.
	const fullDisplayW = $derived(orientedWidth * scaleX);
	const fullDisplayH = $derived(orientedHeight * scaleY);
	const viewDisplayW = $derived(viewW * scaleX);
	const viewDisplayH = $derived(viewH * scaleY);
	const cssFilter = $derived(
		`brightness(${brightness}) contrast(${contrast}) saturate(${grayscale ? 0 : saturation}) hue-rotate(${hue}deg) blur(${blurAmt}px) grayscale(${grayscale ? 1 : 0}) sepia(${sepia ? 1 : 0}) invert(${invert ? 1 : 0})`
	);

	// ── Result-size estimate ─────────────────────────────────────────────────
	let resultSize = $state<number | null>(null);
	let resultEstimating = $state(false);
	const savingsPct = $derived(
		resultSize != null && originalSize > 0 ? Math.round((1 - resultSize / originalSize) * 100) : null
	);

	let previewCanvas = $state<HTMLCanvasElement | null>(null);
	let overlayCanvas = $state<HTMLCanvasElement | null>(null);

	const RESIZE_SCALES = [0.25, 0.5, 1, 2];
	const resizeScalePct = $derived(preWidth > 0 ? Math.round((resizeWidth / preWidth) * 100) : 100);

	let isSaving = $state(false);
	let saveError = $state('');
	let saveMode = $state<'idle' | 'copy'>('idle');
	let copyName = $state('');

	// ── Undo / redo history (snapshots of the editable document) ──────────────
	type Snapshot = {
		rotate: 0 | 90 | 180 | 270;
		flipH: boolean;
		flipV: boolean;
		cropBox: { x: number; y: number; w: number; h: number } | null;
		cropAspect: number | null;
		brightness: number;
		contrast: number;
		saturation: number;
		hue: number;
		blurAmt: number;
		grayscale: boolean;
		sepia: boolean;
		invert: boolean;
		bgColor: string;
		strokes: Stroke[];
		regions: Region[];
		resizeWidth: number;
		resizeHeight: number;
		lockAspect: boolean;
		format: ImageEditFormat;
		compress: boolean;
		quality: number;
		lossless: boolean;
	};
	let history = $state<Snapshot[]>([]);
	let histIndex = $state(-1);
	let applyingHistory = false;
	let histTimer: ReturnType<typeof setTimeout> | null = null;
	const canUndo = $derived(histIndex > 0);
	const canRedo = $derived(histIndex < history.length - 1);

	const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

	function extToFormat(name: string): ImageEditFormat {
		const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
		if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
		if (ext === 'webp') return 'webp';
		if (ext === 'gif') return 'gif';
		if (ext === 'avif') return 'avif';
		return 'png';
	}
	const formatToExt = (fmt: ImageEditFormat) => (fmt === 'jpeg' ? 'jpg' : fmt);
	const baseName = (name: string) => (name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : name);
	function dirOf(path: string) {
		const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
		return idx >= 0 ? path.slice(0, idx) : '';
	}
	function joinPath(dir: string, name: string) {
		const sep = dir.includes('\\') ? '\\' : '/';
		return dir ? `${dir}${sep}${name}` : name;
	}

	// ── Load source ──────────────────────────────────────────────────────────
	onMount(async () => {
		modalOpen = true;
		try {
			const res = await ws.http('files:read-content', { path: file.path });
			baseModified = res.modified;
			originalSize = res.size ?? 0;
			const binary = atob(res.content);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
			const blob = new Blob([bytes], { type: res.contentType || 'application/octet-stream' });
			sourceUrl = URL.createObjectURL(blob);

			const img = new Image();
			img.onload = () => {
				naturalWidth = img.naturalWidth;
				naturalHeight = img.naturalHeight;
				resizeWidth = img.naturalWidth;
				resizeHeight = img.naturalHeight;
				format = extToFormat(file.name);
				baseImage = img;
				isLoading = false;
			};
			img.onerror = () => {
				loadError = 'Failed to decode image';
				isLoading = false;
			};
			img.src = sourceUrl;
		} catch (err) {
			loadError = err instanceof Error ? err.message : 'Failed to load image';
			isLoading = false;
		}
	});

	onDestroy(() => {
		if (sourceUrl) URL.revokeObjectURL(sourceUrl);
		if (estimateTimer) clearTimeout(estimateTimer);
		if (closeTimer) clearTimeout(closeTimer);
		if (histTimer) clearTimeout(histTimer);
		document.body.style.overflow = '';
	});

	// Render the oriented base image into the preview canvas. This effect ONLY
	// renders — it has no reactive side effects, so drawing/cropping state is
	// never wiped behind the user's back. Orientation changes clear annotations
	// explicitly in their handlers instead.
	$effect(() => {
		const canvas = previewCanvas;
		const img = baseImage;
		const r = rotate;
		const fh = flipH;
		const fv = flipV;
		if (!canvas || !img) return;
		const quarter = r === 90 || r === 270;
		const w = quarter ? img.naturalHeight : img.naturalWidth;
		const h = quarter ? img.naturalWidth : img.naturalHeight;
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.clearRect(0, 0, w, h);
		ctx.save();
		ctx.translate(w / 2, h / 2);
		ctx.rotate((r * Math.PI) / 180);
		ctx.scale(fh ? -1 : 1, fv ? -1 : 1);
		ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
		ctx.restore();
	});

	// Re-render the annotation/mask overlay whenever its inputs change. Depends on
	// baseImage + orientation so it re-syncs to the (re-sized) preview canvas.
	$effect(() => {
		void [strokes, regions, draftRegion, currentStroke, maskType, fitScale];
		void [baseImage, rotate, flipH, flipV];
		renderOverlay();
	});

	function renderOverlay() {
		const oc = overlayCanvas;
		const pv = previewCanvas;
		if (!oc || !pv || pv.width === 0) return;
		if (oc.width !== pv.width || oc.height !== pv.height) {
			oc.width = pv.width;
			oc.height = pv.height;
		}
		const ctx = oc.getContext('2d');
		if (!ctx) return;
		ctx.clearRect(0, 0, oc.width, oc.height);

		for (const r of regions) drawRegion(ctx, pv, r);
		if (draftRegion) drawRegion(ctx, pv, draftRegion);

		for (const s of strokes) drawStroke(ctx, s);
		if (currentStroke) drawStroke(ctx, currentStroke);
	}

	function drawRegion(ctx: CanvasRenderingContext2D, pv: HTMLCanvasElement, r: Region) {
		const w = Math.max(1, r.w);
		const h = Math.max(1, r.h);
		ctx.save();
		ctx.beginPath();
		ctx.rect(r.x, r.y, w, h);
		ctx.clip();
		if (r.type === 'blur') {
			ctx.filter = `blur(${Math.max(1, r.strength / 3)}px)`;
			ctx.drawImage(pv, 0, 0);
			ctx.filter = 'none';
		} else {
			const factor = Math.max(2, Math.round(r.strength / 3));
			const tw = Math.max(1, Math.round(w / factor));
			const th = Math.max(1, Math.round(h / factor));
			const tmp = document.createElement('canvas');
			tmp.width = tw;
			tmp.height = th;
			const tctx = tmp.getContext('2d');
			if (tctx) {
				tctx.imageSmoothingEnabled = false;
				tctx.drawImage(pv, r.x, r.y, w, h, 0, 0, tw, th);
				ctx.imageSmoothingEnabled = false;
				ctx.drawImage(tmp, 0, 0, tw, th, r.x, r.y, w, h);
				ctx.imageSmoothingEnabled = true;
			}
		}
		ctx.restore();
		// Outline
		ctx.save();
		ctx.strokeStyle = '#a855f7';
		ctx.lineWidth = Math.max(1, 2 / fitScale);
		ctx.setLineDash([6 / fitScale, 4 / fitScale]);
		ctx.strokeRect(r.x, r.y, w, h);
		ctx.restore();
	}

	function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
		if (s.points.length === 0) return;
		ctx.save();
		ctx.strokeStyle = s.color;
		ctx.globalAlpha = s.opacity;
		ctx.lineWidth = s.size;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.beginPath();
		ctx.moveTo(s.points[0].x, s.points[0].y);
		for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
		if (s.points.length === 1) ctx.lineTo(s.points[0].x + 0.01, s.points[0].y + 0.01);
		ctx.stroke();
		ctx.restore();
	}

	// Snap resize fields to the pre-resize dimensions on load/rotate/crop.
	let lastPreKey = '';
	$effect(() => {
		const key = `${preWidth}x${preHeight}`;
		if (preWidth > 0 && key !== lastPreKey) {
			lastPreKey = key;
			resizeWidth = preWidth;
			resizeHeight = preHeight;
		}
	});

	// Initialize the crop frame to the full image when entering the Crop panel so
	// the user adjusts handles inward (rather than rubber-banding a new box).
	$effect(() => {
		if (activePanel === 'crop' && !cropBox && orientedWidth > 0 && orientedHeight > 0) {
			cropBox = { x: 0, y: 0, w: orientedWidth, h: orientedHeight };
		}
	});

	// Result-size estimate (debounced, exact via server dry-run).
	let estimateTimer: ReturnType<typeof setTimeout> | null = null;
	let estimateSeq = 0;
	$effect(() => {
		void [cropBox, resizeWidth, resizeHeight, rotate, flipH, flipV];
		void [brightness, contrast, saturation, hue, blurAmt, grayscale, sepia, invert];
		void [format, compress, quality, lossless, bgColor, strokes, regions];
		if (isLoading || loadError || !baseImage) return;
		if (estimateTimer) clearTimeout(estimateTimer);
		estimateTimer = setTimeout(runEstimate, 350);
	});

	async function runEstimate() {
		if (isLoading || loadError || !baseImage) return;
		const seq = ++estimateSeq;
		resultEstimating = true;
		try {
			const res = await ws.http('files:estimate-image', { sourcePath: file.path, recipe: buildRecipe() });
			if (seq === estimateSeq) resultSize = res.size;
		} catch (err) {
			if (seq === estimateSeq) resultSize = null;
			debug.error('file', 'Image estimate failed:', err);
		} finally {
			if (seq === estimateSeq) resultEstimating = false;
		}
	}

	function onResizeWidthInput(value: number) {
		resizeWidth = value;
		if (lockAspect && preWidth > 0) resizeHeight = Math.max(1, Math.round((value / preWidth) * preHeight));
	}
	function onResizeHeightInput(value: number) {
		resizeHeight = value;
		if (lockAspect && preHeight > 0) resizeWidth = Math.max(1, Math.round((value / preHeight) * preWidth));
	}
	function applyScale(f: number) {
		resizeWidth = Math.max(1, Math.round(preWidth * f));
		resizeHeight = Math.max(1, Math.round(preHeight * f));
	}
	const resetResize = () => applyScale(1);

	// Capture the current editable document as a plain (serializable) snapshot.
	function snapshot(): Snapshot {
		return {
			rotate,
			flipH,
			flipV,
			cropBox: cropBox ? { ...cropBox } : null,
			cropAspect,
			brightness,
			contrast,
			saturation,
			hue,
			blurAmt,
			grayscale,
			sepia,
			invert,
			bgColor,
			strokes: strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) })),
			regions: regions.map((r) => ({ ...r })),
			resizeWidth,
			resizeHeight,
			lockAspect,
			format,
			compress,
			quality,
			lossless
		};
	}

	function commitHistory() {
		if (applyingHistory) return;
		const snap = snapshot();
		if (histIndex >= 0 && JSON.stringify(history[histIndex]) === JSON.stringify(snap)) return;
		history = [...history.slice(0, histIndex + 1), snap];
		histIndex = history.length - 1;
	}

	// Record a new history entry shortly after the document settles. Guarded so
	// replaying a snapshot (undo/redo) never records itself.
	$effect(() => {
		void [rotate, flipH, flipV, cropBox, cropAspect, brightness, contrast, saturation, hue, blurAmt];
		void [grayscale, sepia, invert, bgColor, strokes, regions, resizeWidth, resizeHeight, lockAspect];
		void [format, compress, quality, lossless];
		if (isLoading || loadError || !baseImage) return;
		if (applyingHistory) return;
		if (histTimer) clearTimeout(histTimer);
		histTimer = setTimeout(commitHistory, 250);
	});

	function applySnapshot(s: Snapshot) {
		applyingHistory = true;
		rotate = s.rotate;
		flipH = s.flipH;
		flipV = s.flipV;
		cropBox = s.cropBox ? { ...s.cropBox } : null;
		cropAspect = s.cropAspect;
		brightness = s.brightness;
		contrast = s.contrast;
		saturation = s.saturation;
		hue = s.hue;
		blurAmt = s.blurAmt;
		grayscale = s.grayscale;
		sepia = s.sepia;
		invert = s.invert;
		bgColor = s.bgColor;
		strokes = s.strokes.map((st) => ({ ...st, points: st.points.map((p) => ({ ...p })) }));
		regions = s.regions.map((r) => ({ ...r }));
		resizeWidth = s.resizeWidth;
		resizeHeight = s.resizeHeight;
		lockAspect = s.lockAspect;
		format = s.format;
		compress = s.compress;
		quality = s.quality;
		lossless = s.lossless;
		currentStroke = null;
		draftRegion = null;
		// Pin the auto-sync effects' keys to the restored values so they don't
		// immediately clobber the format/resize fields after a replay.
		lastFormatForLossless = s.format;
		const ow = s.rotate === 90 || s.rotate === 270 ? naturalHeight : naturalWidth;
		const oh = s.rotate === 90 || s.rotate === 270 ? naturalWidth : naturalHeight;
		const pw = s.cropBox && s.cropBox.w > 1 ? Math.max(1, Math.round(s.cropBox.w)) : ow;
		const ph = s.cropBox && s.cropBox.h > 1 ? Math.max(1, Math.round(s.cropBox.h)) : oh;
		lastPreKey = `${pw}x${ph}`;
		if (histTimer) {
			clearTimeout(histTimer);
			histTimer = null;
		}
		setTimeout(() => {
			applyingHistory = false;
		}, 0);
	}

	function undo() {
		if (histIndex > 0) {
			histIndex -= 1;
			applySnapshot(history[histIndex]);
		}
	}
	function redo() {
		if (histIndex < history.length - 1) {
			histIndex += 1;
			applySnapshot(history[histIndex]);
		}
	}

	// Orientation changes invalidate annotation/crop coordinates (they live in
	// oriented space), so clear them when rotating or flipping.
	function clearOrientedEdits() {
		cropBox = null;
		strokes = [];
		currentStroke = null;
		regions = [];
		draftRegion = null;
	}
	function rotateBy(delta: 90 | -90) {
		rotate = (((rotate + delta + 360) % 360) as 0 | 90 | 180 | 270);
		clearOrientedEdits();
	}
	function toggleFlipH() {
		flipH = !flipH;
		clearOrientedEdits();
	}
	function toggleFlipV() {
		flipV = !flipV;
		clearOrientedEdits();
	}

	function resetAdjustments() {
		brightness = 1;
		contrast = 1;
		saturation = 1;
		hue = 0;
		blurAmt = 0;
		grayscale = false;
		sepia = false;
		invert = false;
	}

	function resetAll() {
		rotate = 0;
		flipH = false;
		flipV = false;
		cropBox = orientedWidth > 0 ? { x: 0, y: 0, w: orientedWidth, h: orientedHeight } : null;
		cropAspect = null;
		resetAdjustments();
		strokes = [];
		currentStroke = null;
		regions = [];
		draftRegion = null;
		resizeWidth = orientedWidth || naturalWidth;
		resizeHeight = orientedHeight || naturalHeight;
		lockAspect = true;
		format = originalFormat;
		compress = false;
		quality = 80;
		lossless = originalFormat === 'png';
		bgColor = '#ffffff';
	}

	// ── Stage pointer handling (dispatch by active tool) ──────────────────────
	// Returns the pointer position in oriented source pixels.
	function orientedPoint(e: PointerEvent, el: HTMLElement) {
		const rect = el.getBoundingClientRect();
		const sx = scaleX > 0 ? scaleX : 1;
		const sy = scaleY > 0 ? scaleY : 1;
		return {
			x: clamp((e.clientX - rect.left) / sx, 0, orientedWidth),
			y: clamp((e.clientY - rect.top) / sy, 0, orientedHeight)
		};
	}

	let cropDrag: { mode: CropMode; start: { x: number; y: number }; orig: { x: number; y: number; w: number; h: number } } | null = null;
	let strokeActive = false;
	let regionStart: { x: number; y: number } | null = null;

	function onStagePointerDown(e: PointerEvent) {
		if (tool === 'crop') {
			// With an always-present frame, the stage only sees empty space when
			// there is no box yet — fall back to rubber-banding a fresh one.
			if (!cropBox) startCrop(e, 'new');
		} else if (tool === 'draw') {
			startStroke(e);
		} else if (tool === 'mask') {
			startRegion(e);
		}
	}
	function onStagePointerMove(e: PointerEvent) {
		if (cropDrag) moveCrop(e);
		else if (strokeActive) extendStroke(e);
		else if (regionStart) extendRegion(e);
	}
	function onStagePointerUp() {
		if (cropDrag) endCrop();
		else if (strokeActive) endStroke();
		else if (regionStart) endRegion();
	}

	// ── Crop ───────────────────────────────────────────────────────────────
	function startCrop(e: PointerEvent, mode: CropMode) {
		e.preventDefault();
		e.stopPropagation();
		const layer = (e.currentTarget as HTMLElement).closest('.stage-layer') as HTMLElement | null;
		if (!layer) return;
		layer.setPointerCapture?.(e.pointerId);
		const p = orientedPoint(e, layer);
		cropDrag = { mode, start: p, orig: cropBox ? { ...cropBox } : { x: p.x, y: p.y, w: 0, h: 0 } };
		if (mode === 'new') cropBox = { x: p.x, y: p.y, w: 0, h: 0 };
	}

	// Constrain a freeform box (top-left anchored) to the chosen aspect ratio,
	// growing downward and clamping to the image height.
	function applyAspectNew(box: { x: number; y: number; w: number; h: number }) {
		if (!cropAspect) return box;
		let w = box.w;
		let h = w / cropAspect;
		if (box.y + h > orientedHeight) {
			h = orientedHeight - box.y;
			w = h * cropAspect;
		}
		return { x: box.x, y: box.y, w, h };
	}

	// Re-fit a resized box to the aspect ratio, anchored to the side/corner
	// opposite the handle being dragged.
	function applyAspectResize(
		box: { x: number; y: number; w: number; h: number },
		mode: CropMode,
		o: { x: number; y: number; w: number; h: number }
	) {
		if (!cropAspect) return box;
		let w = box.w;
		let h = box.h;
		if (mode === 'n' || mode === 's') w = h * cropAspect;
		else h = w / cropAspect;

		let x: number;
		if (mode.includes('w')) x = o.x + o.w - w; // east edge fixed
		else if (mode.includes('e')) x = o.x; // west edge fixed
		else x = o.x + (o.w - w) / 2; // centered for n/s

		let y: number;
		if (mode.includes('n')) y = o.y + o.h - h; // south edge fixed
		else if (mode.includes('s')) y = o.y; // north edge fixed
		else y = o.y + (o.h - h) / 2; // centered for e/w

		return { x, y, w, h };
	}

	function clampBox(box: { x: number; y: number; w: number; h: number }) {
		let { x, y, w, h } = box;
		if (x < 0) {
			w += x;
			x = 0;
		}
		if (y < 0) {
			h += y;
			y = 0;
		}
		if (x + w > orientedWidth) w = orientedWidth - x;
		if (y + h > orientedHeight) h = orientedHeight - y;
		return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
	}

	// Clamp a resized box to the image bounds WITHOUT breaking its aspect ratio.
	// Instead of trimming a single axis (which clampBox does), scale the whole box
	// down around its anchor — the edge/corner opposite the handle being dragged —
	// so it always fits while staying exactly on ratio.
	function clampAspect(box: { x: number; y: number; w: number; h: number }, mode: CropMode) {
		const { x, y, w, h } = box;
		if (w <= 0 || h <= 0) return clampBox(box);

		// Anchor: 'l'/'r'/'c' horizontally, 't'/'b'/'c' vertically.
		const ax = mode.includes('e') ? 'l' : mode.includes('w') ? 'r' : 'c';
		const ay = mode.includes('s') ? 't' : mode.includes('n') ? 'b' : 'c';

		const cx = x + w / 2;
		const cy = y + h / 2;
		const availW = ax === 'l' ? orientedWidth - x : ax === 'r' ? x + w : 2 * Math.min(cx, orientedWidth - cx);
		const availH = ay === 't' ? orientedHeight - y : ay === 'b' ? y + h : 2 * Math.min(cy, orientedHeight - cy);

		const scale = Math.max(0, Math.min(availW / w, availH / h, 1));
		const nw = w * scale;
		const nh = h * scale;
		const nx = ax === 'l' ? x : ax === 'r' ? x + w - nw : cx - nw / 2;
		const ny = ay === 't' ? y : ay === 'b' ? y + h - nh : cy - nh / 2;
		return { x: nx, y: ny, w: nw, h: nh };
	}

	function moveCrop(e: PointerEvent) {
		if (!cropDrag) return;
		const layer = e.currentTarget as HTMLElement;
		const p = orientedPoint(e, layer);
		const dx = p.x - cropDrag.start.x;
		const dy = p.y - cropDrag.start.y;
		const o = cropDrag.orig;

		if (cropDrag.mode === 'new') {
			const box = { x: Math.min(cropDrag.start.x, p.x), y: Math.min(cropDrag.start.y, p.y), w: Math.abs(dx), h: Math.abs(dy) };
			cropBox = clampBox(applyAspectNew(box));
			return;
		}
		if (cropDrag.mode === 'move') {
			cropBox = {
				x: clamp(o.x + dx, 0, orientedWidth - o.w),
				y: clamp(o.y + dy, 0, orientedHeight - o.h),
				w: o.w,
				h: o.h
			};
			return;
		}

		// Edge / corner resize.
		const m = cropDrag.mode;
		let x = o.x;
		let y = o.y;
		let w = o.w;
		let h = o.h;
		if (m.includes('w')) {
			x = o.x + dx;
			w = o.w - dx;
		}
		if (m.includes('e')) w = o.w + dx;
		if (m.includes('n')) {
			y = o.y + dy;
			h = o.h - dy;
		}
		if (m.includes('s')) h = o.h + dy;
		if (w < 0) {
			x += w;
			w = -w;
		}
		if (h < 0) {
			y += h;
			h = -h;
		}
		const aspected = applyAspectResize({ x, y, w, h }, m, o);
		cropBox = cropAspect ? clampAspect(aspected, m) : clampBox(aspected);
	}

	function endCrop() {
		// A frame dragged down to nothing reverts to the full image.
		if (cropBox && (cropBox.w < 4 || cropBox.h < 4)) {
			cropBox = orientedWidth > 0 ? { x: 0, y: 0, w: orientedWidth, h: orientedHeight } : null;
		}
		cropDrag = null;
	}

	const resetCrop = () => {
		cropBox = orientedWidth > 0 ? { x: 0, y: 0, w: orientedWidth, h: orientedHeight } : null;
	};

	// Force the crop frame to the chosen aspect: the largest box of that ratio
	// that fits inside the current frame, centered (shrinks the long axis).
	function setAspect(value: number | null) {
		cropAspect = value;
		if (value == null) return;
		const b = cropBox ?? { x: 0, y: 0, w: orientedWidth, h: orientedHeight };
		if (b.w < 1 || b.h < 1) return;
		let w = b.w;
		let h = w / value;
		if (h > b.h) {
			h = b.h;
			w = h * value;
		}
		cropBox = clampBox({ x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h });
	}

	// Reset only the orientation; like rotate/flip, this clears oriented-space edits.
	function resetTransform() {
		if (rotate === 0 && !flipH && !flipV) return;
		rotate = 0;
		flipH = false;
		flipV = false;
		clearOrientedEdits();
	}

	// ── Draw ───────────────────────────────────────────────────────────────
	function startStroke(e: PointerEvent) {
		e.preventDefault();
		const layer = (e.currentTarget as HTMLElement).closest('.stage-layer') as HTMLElement | null;
		if (!layer) return;
		layer.setPointerCapture?.(e.pointerId);
		strokeActive = true;
		const o = orientedPoint(e, layer);
		shapeStart = o;
		currentStroke = { color: penColor, size: Math.max(1, penSize / fitScale), opacity: penOpacity, points: [o] };
	}
	function extendStroke(e: PointerEvent) {
		if (!currentStroke) return;
		const layer = e.currentTarget as HTMLElement;
		const o = orientedPoint(e, layer);
		if (drawShape === 'free' || !shapeStart) {
			currentStroke.points.push(o);
			currentStroke = { ...currentStroke };
		} else {
			currentStroke = { ...currentStroke, points: shapePoints(shapeStart, o, drawShape, currentStroke.size) };
		}
	}
	function endStroke() {
		strokeActive = false;
		shapeStart = null;
		if (currentStroke && currentStroke.points.length > 0) strokes = [...strokes, currentStroke];
		currentStroke = null;
	}
	const clearStrokes = () => (strokes = []);

	// ── Mask ───────────────────────────────────────────────────────────────
	function startRegion(e: PointerEvent) {
		e.preventDefault();
		const layer = (e.currentTarget as HTMLElement).closest('.stage-layer') as HTMLElement | null;
		if (!layer) return;
		layer.setPointerCapture?.(e.pointerId);
		const o = orientedPoint(e, layer);
		regionStart = o;
		draftRegion = { type: maskType, x: o.x, y: o.y, w: 0, h: 0, strength: maskStrength };
	}
	function extendRegion(e: PointerEvent) {
		if (!regionStart) return;
		const layer = e.currentTarget as HTMLElement;
		const o = orientedPoint(e, layer);
		draftRegion = {
			type: maskType,
			x: Math.min(regionStart.x, o.x),
			y: Math.min(regionStart.y, o.y),
			w: Math.abs(o.x - regionStart.x),
			h: Math.abs(o.y - regionStart.y),
			strength: maskStrength
		};
	}
	function endRegion() {
		if (draftRegion && draftRegion.w > 4 && draftRegion.h > 4) regions = [...regions, draftRegion];
		draftRegion = null;
		regionStart = null;
	}
	const clearRegions = () => (regions = []);

	function buildRecipe(): ImageEditRecipe {
		const recipe: ImageEditRecipe = { output: { format } };

		if (cropIsActive && cropBox) {
			recipe.crop = {
				left: Math.round(cropBox.x),
				top: Math.round(cropBox.y),
				width: Math.round(cropBox.w),
				height: Math.round(cropBox.h)
			};
		}
		const rw = Math.round(resizeWidth);
		const rh = Math.round(resizeHeight);
		if (rw > 0 && rh > 0 && (rw !== preWidth || rh !== preHeight)) recipe.resize = { width: rw, height: rh };
		if (rotate) recipe.rotate = rotate;
		if (flipH) recipe.flipH = true;
		if (flipV) recipe.flipV = true;
		if (brightness !== 1) recipe.brightness = brightness;
		if (saturation !== 1) recipe.saturation = saturation;
		if (contrast !== 1) recipe.contrast = contrast;
		if (hue !== 0) recipe.hue = hue;
		if (blurAmt > 0) recipe.blur = blurAmt;
		if (grayscale) recipe.grayscale = true;
		if (sepia) recipe.sepia = true;
		if (invert) recipe.invert = true;
		// JPEG has no alpha — flatten transparency onto the chosen background.
		if (format === 'jpeg') recipe.background = bgColor;

		if (regions.length > 0) {
			recipe.regions = regions.map(
				(r): ImageEditRegion => ({
					type: r.type,
					left: Math.round(r.x),
					top: Math.round(r.y),
					width: Math.round(r.w),
					height: Math.round(r.h),
					strength: r.strength
				})
			);
		}
		if (strokes.length > 0) {
			recipe.annotations = strokes.map(
				(s): ImageEditStroke => ({
					color: s.color,
					size: Math.round(s.size),
					opacity: s.opacity,
					points: s.points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
				})
			);
		}

		if (compress) {
			recipe.output.compress = true;
			if (hasQuality) recipe.output.quality = quality;
			if (losslessCapable && lossless) recipe.output.lossless = true;
		}
		return recipe;
	}

	function beginSaveAsCopy() {
		saveError = '';
		copyName = `${baseName(file.name)}-edited.${formatToExt(format)}`;
		saveMode = 'copy';
	}

	async function doSave(targetPath: string, overwrite: boolean) {
		isSaving = true;
		saveError = '';
		try {
			const res = await ws.http('files:edit-image', {
				sourcePath: file.path,
				targetPath,
				overwrite,
				recipe: buildRecipe(),
				baseModified: overwrite ? baseModified : undefined
			});
			onSaved?.({ path: res.path });
			requestClose();
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Failed to save image';
			saveError = msg.startsWith('FILE_CONFLICT')
				? 'The file changed on disk since it was opened. Close the editor and reopen it.'
				: msg.replace(/^Error:\s*/, '');
			debug.error('file', 'Image save failed:', err);
		} finally {
			isSaving = false;
		}
	}
	const confirmOverwrite = () => void doSave(file.path, true);
	function confirmCopy() {
		const name = copyName.trim();
		if (!name) {
			saveError = 'Enter a file name';
			return;
		}
		void doSave(joinPath(dirOf(file.path), name), false);
	}

	const cursorClass = $derived(
		tool === 'draw' || tool === 'mask' ? 'cursor-crosshair' : 'cursor-default'
	);
</script>

<Modal
	isOpen={modalOpen}
	onClose={requestClose}
	bare
	mobileFullscreen
	ariaLabelledBy="image-editor-title"
	className="flex flex-col w-full max-w-[1150px] xl:max-w-[1280px] h-[90dvh] max-h-[880px] bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-700 rounded-2xl overflow-hidden shadow-2xl"
>
	{#snippet children()}
		<!-- Header -->
		<div class="flex-shrink-0 flex items-center justify-between gap-2 px-3 sm:px-4 py-2.5 border-b border-slate-200 dark:border-slate-700">
			<div class="flex items-center gap-2 min-w-0">
				<Icon name="lucide:image" class="w-5 h-5 text-violet-500 dark:text-violet-400 shrink-0" />
				<span id="image-editor-title" class="text-sm font-semibold truncate">{file.name}</span>
			</div>
			<div class="flex items-center gap-1 shrink-0">
				<button onclick={undo} disabled={!canUndo} class="flex p-2 rounded-lg text-slate-500 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-700/70 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent" title="Undo" aria-label="Undo">
					<Icon name="lucide:undo-2" class="w-4 h-4" />
				</button>
				<button onclick={redo} disabled={!canRedo} class="flex p-2 rounded-lg text-slate-500 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-700/70 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent" title="Redo" aria-label="Redo">
					<Icon name="lucide:redo-2" class="w-4 h-4" />
				</button>
				<div class="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5"></div>
				<button onclick={resetAll} class="flex p-2 rounded-lg text-slate-500 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-700/70 transition-colors" title="Reset all changes" aria-label="Reset all changes">
					<Icon name="lucide:rotate-ccw" class="w-4 h-4" />
				</button>
				<button onclick={requestClose} class="flex p-2 rounded-lg text-slate-500 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-700/70 transition-colors" aria-label="Close editor">
					<Icon name="lucide:x" class="w-5 h-5" />
				</button>
			</div>
		</div>

		<div class="flex-1 flex flex-col lg:flex-row min-h-0">
			<!-- Stage -->
			<div class="relative flex-1 min-w-0 min-h-0 overflow-hidden checkerboard-bg">
				<div class="absolute inset-3 sm:inset-5 flex items-center justify-center" bind:clientWidth={stageWidth} bind:clientHeight={stageHeight}>
				{#if isLoading}
					<LoadingSpinner size="lg" />
				{:else if loadError}
					<div class="flex flex-col items-center gap-2 text-slate-600 dark:text-slate-300 text-sm">
						<Icon name="lucide:image-off" class="w-10 h-10 opacity-50" />
						<span>{loadError}</span>
					</div>
				{:else}
					<div class="relative overflow-hidden" style="width: {viewDisplayW}px; height: {viewDisplayH}px;">
						<canvas bind:this={previewCanvas} class="absolute pointer-events-none" style="left: {-viewX * scaleX}px; top: {-viewY * scaleY}px; width: {fullDisplayW}px; height: {fullDisplayH}px; filter: {cssFilter};"></canvas>
						<canvas bind:this={overlayCanvas} class="absolute pointer-events-none" style="left: {-viewX * scaleX}px; top: {-viewY * scaleY}px; width: {fullDisplayW}px; height: {fullDisplayH}px;"></canvas>

						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="stage-layer absolute {cursorClass}"
							style="left: {-viewX * scaleX}px; top: {-viewY * scaleY}px; width: {fullDisplayW}px; height: {fullDisplayH}px; touch-action: none;"
							onpointerdown={onStagePointerDown}
							onpointermove={onStagePointerMove}
							onpointerup={onStagePointerUp}
							onpointercancel={onStagePointerUp}
						>
							{#if tool === 'crop' && cropBox && cropBox.w > 1 && cropBox.h > 1}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									class="absolute border border-violet-400 cursor-move"
									style="left: {cropBox.x * scaleX}px; top: {cropBox.y * scaleY}px; width: {cropBox.w * scaleX}px; height: {cropBox.h * scaleY}px; box-shadow: 0 0 0 9999px rgba(15,23,42,0.45);"
									onpointerdown={(e) => startCrop(e, 'move')}
								>
									<!-- Rule-of-thirds guides -->
									<div class="pointer-events-none absolute inset-0">
										<div class="absolute top-0 bottom-0 left-1/3 w-px bg-white/30"></div>
										<div class="absolute top-0 bottom-0 left-2/3 w-px bg-white/30"></div>
										<div class="absolute left-0 right-0 top-1/3 h-px bg-white/30"></div>
										<div class="absolute left-0 right-0 top-2/3 h-px bg-white/30"></div>
									</div>
									{#each CROP_HANDLES as hd (hd.mode)}
										<!-- svelte-ignore a11y_no_static_element_interactions -->
										<div
											class="absolute {hd.pos} {hd.size} bg-violet-500 border border-white rounded-[2px] shadow"
											style="cursor: {hd.cursor};"
											onpointerdown={(e) => startCrop(e, hd.mode)}
										></div>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				{/if}
				</div>
			</div>

			<!-- Controls -->
			<div class="flex-shrink-0 w-full lg:w-80 border-t lg:border-t-0 lg:border-l border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 flex flex-col max-h-[46dvh] lg:max-h-none">
				<!-- Tab bar -->
				<div class="flex-shrink-0 flex overflow-x-auto border-b border-slate-200 dark:border-slate-700">
					{#each PANELS as p (p.id)}
						<button
							class="flex-1 min-w-[58px] flex flex-col items-center gap-0.5 px-2 py-2 text-xs transition-colors {activePanel === p.id ? 'text-violet-600 dark:text-violet-300 border-b-2 border-violet-500 bg-violet-50 dark:bg-slate-700/40' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 border-b-2 border-transparent'}"
							onclick={() => (activePanel = p.id)}
						>
							<Icon name={p.icon} class="w-4 h-4" />
							{p.label}
						</button>
					{/each}
				</div>

				<div class="flex-1 overflow-y-auto p-4 space-y-4">
					{#if activePanel === 'crop'}
						<section class="space-y-2">
							<div class="flex items-center justify-between"><h4 class={HEADING}>Transform</h4><button class="text-xs {LINK}" onclick={resetTransform}>Reset</button></div>
							<div class="grid grid-cols-2 gap-1.5">
								<button class="flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded-lg {BTN}" onclick={() => rotateBy(-90)} title="Rotate left"><Icon name="lucide:rotate-ccw" class="w-4 h-4" /> Left</button>
								<button class="flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded-lg {BTN}" onclick={() => rotateBy(90)} title="Rotate right"><Icon name="lucide:rotate-cw" class="w-4 h-4" /> Right</button>
								<button class="flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded-lg {flipH ? ACTIVE : BTN}" onclick={toggleFlipH}><Icon name="lucide:flip-horizontal" class="w-4 h-4" /> Flip H</button>
								<button class="flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded-lg {flipV ? ACTIVE : BTN}" onclick={toggleFlipV}><Icon name="lucide:flip-vertical" class="w-4 h-4" /> Flip V</button>
							</div>
						</section>
						<section class="space-y-2">
							<div class="flex items-center justify-between"><h4 class={HEADING}>Crop ratio</h4><button class="text-xs {LINK}" onclick={resetCrop}>Reset</button></div>
							<div class="flex flex-wrap gap-1.5">
								{#each ASPECTS as a (a.label)}
									<button class="px-2.5 py-1 text-xs rounded-lg transition-colors {cropAspect === a.value ? ACTIVE : BTN}" onclick={() => setAspect(a.value)}>{a.label}</button>
								{/each}
							</div>
							<div class="text-xs text-slate-500 dark:text-slate-400">
								{#if cropBox && cropIsActive}{Math.round(cropBox.w)}×{Math.round(cropBox.h)}px{:else}Full image — drag a handle to crop{/if}
							</div>
						</section>
					{:else if activePanel === 'adjust'}
						<section class="space-y-2.5">
							<div class="flex items-center justify-between">
								<h4 class={HEADING}>Adjust</h4>
								<button class="text-xs {LINK}" onclick={resetAdjustments}>Reset</button>
							</div>
							<label class="block text-xs"><span class={LABEL_ROW}><span>Brightness</span><span>{brightness.toFixed(2)}</span></span><input type="range" min="0" max="2" step="0.01" bind:value={brightness} class="w-full accent-violet-500" /></label>
							<label class="block text-xs"><span class={LABEL_ROW}><span>Contrast</span><span>{contrast.toFixed(2)}</span></span><input type="range" min="0" max="2" step="0.01" bind:value={contrast} class="w-full accent-violet-500" /></label>
							<label class="block text-xs"><span class={LABEL_ROW}><span>Saturation</span><span>{saturation.toFixed(2)}</span></span><input type="range" min="0" max="2" step="0.01" bind:value={saturation} class="w-full accent-violet-500" disabled={grayscale} /></label>
							<label class="block text-xs"><span class={LABEL_ROW}><span>Hue</span><span>{hue}°</span></span><input type="range" min="-180" max="180" step="1" bind:value={hue} class="w-full accent-violet-500" disabled={grayscale} /></label>
							<label class="block text-xs"><span class={LABEL_ROW}><span>Blur</span><span>{blurAmt}px</span></span><input type="range" min="0" max="20" step="0.5" bind:value={blurAmt} class="w-full accent-violet-500" /></label>
							<div class="flex flex-wrap gap-1.5 pt-1">
								<button class="px-2.5 py-1 text-xs rounded-lg transition-colors {grayscale ? ACTIVE : BTN}" onclick={() => (grayscale = !grayscale)}>Grayscale</button>
								<button class="px-2.5 py-1 text-xs rounded-lg transition-colors {sepia ? ACTIVE : BTN}" onclick={() => (sepia = !sepia)}>Sepia</button>
								<button class="px-2.5 py-1 text-xs rounded-lg transition-colors {invert ? ACTIVE : BTN}" onclick={() => (invert = !invert)}>Invert</button>
							</div>
						</section>
					{:else if activePanel === 'draw'}
						<section class="space-y-3">
							<div class="flex items-center justify-between"><h4 class={HEADING}>Draw</h4><button class="text-xs {LINK}" onclick={clearStrokes}>Reset</button></div>
							<div class="grid grid-cols-5 gap-1">
								{#each DRAW_SHAPES as sh (sh.id)}
									<button class="flex items-center justify-center py-2 rounded-lg transition-colors {drawShape === sh.id ? ACTIVE : BTN}" onclick={() => (drawShape = sh.id)} title={sh.label} aria-label={sh.label}>
										<Icon name={sh.icon} class="w-4 h-4" />
									</button>
								{/each}
							</div>
							<div class="flex items-center gap-1.5 flex-wrap">
								{#each SWATCHES as c (c)}
									<button class="w-6 h-6 rounded-full border-2 transition-transform {penColor === c ? 'border-slate-900 dark:border-white scale-110' : 'border-slate-300 dark:border-slate-600'}" style="background: {c};" onclick={() => (penColor = c)} aria-label="Color {c}"></button>
								{/each}
								<input type="color" bind:value={penColor} class="w-6 h-6 rounded bg-transparent border border-slate-300 dark:border-slate-600 p-0" aria-label="Custom color" />
							</div>
							<label class="block text-xs"><span class={LABEL_ROW}><span>Brush size</span><span>{penSize}px</span></span><input type="range" min="2" max="48" step="1" bind:value={penSize} class="w-full accent-violet-500" /></label>
							<label class="block text-xs"><span class={LABEL_ROW}><span>Opacity</span><span>{Math.round(penOpacity * 100)}%</span></span><input type="range" min="0.1" max="1" step="0.05" bind:value={penOpacity} class="w-full accent-violet-500" /></label>
						</section>
					{:else if activePanel === 'mask'}
						<section class="space-y-3">
							<div class="flex items-center justify-between"><h4 class={HEADING}>Blur / Mosaic</h4><button class="text-xs {LINK}" onclick={clearRegions}>Reset</button></div>
							<div class="flex gap-1.5">
								<button class="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded-lg {maskType === 'blur' ? ACTIVE : BTN}" onclick={() => (maskType = 'blur')}><Icon name="lucide:droplet" class="w-4 h-4" /> Blur</button>
								<button class="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded-lg {maskType === 'pixelate' ? ACTIVE : BTN}" onclick={() => (maskType = 'pixelate')}><Icon name="lucide:grid-2x2" class="w-4 h-4" /> Mosaic</button>
							</div>
							<label class="block text-xs"><span class={LABEL_ROW}><span>Strength</span><span>{maskStrength}</span></span><input type="range" min="5" max="100" step="1" bind:value={maskStrength} class="w-full accent-violet-500" /></label>
						</section>
					{:else if activePanel === 'resize'}
						<section class="space-y-3">
							<div class="flex items-center justify-between"><h4 class={HEADING}>Resize</h4><button class="text-xs {LINK}" onclick={resetResize}>Reset</button></div>
							<div class="flex items-end gap-2">
								<label class="flex-1 text-xs text-slate-500 dark:text-slate-400">Width
									<input type="number" min="1" value={resizeWidth} oninput={(e) => onResizeWidthInput(Number((e.target as HTMLInputElement).value))} class="mt-1 w-full px-2 py-1.5 text-xs rounded {INPUT}" />
								</label>
								<span class="text-slate-400 text-xs pb-2">×</span>
								<label class="flex-1 text-xs text-slate-500 dark:text-slate-400">Height
									<input type="number" min="1" value={resizeHeight} oninput={(e) => onResizeHeightInput(Number((e.target as HTMLInputElement).value))} class="mt-1 w-full px-2 py-1.5 text-xs rounded {INPUT}" />
								</label>
							</div>
							<div class="flex gap-1.5">
								{#each RESIZE_SCALES as s (s)}
									<button class="flex-1 px-2 py-1 text-xs rounded-lg {BTN}" onclick={() => applyScale(s)}>{Math.round(s * 100)}%</button>
								{/each}
							</div>
							<div class="flex gap-1.5">
								{#each RESIZE_WIDTHS as wpx (wpx)}
									<button class="flex-1 px-1.5 py-1 text-xs rounded-lg {BTN}" onclick={() => onResizeWidthInput(wpx)} title="Set width to {wpx}px">{wpx}</button>
								{/each}
							</div>
							<label class="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300"><input type="checkbox" bind:checked={lockAspect} class="accent-violet-500" /> Lock aspect ratio</label>
							<div class="text-xs text-slate-500 dark:text-slate-400">{resizeScalePct}% of {preWidth}×{preHeight}</div>
							{#if Math.round(resizeWidth) > preWidth || Math.round(resizeHeight) > preHeight}
								<p class="text-xs text-amber-600 dark:text-amber-400">Upscaling beyond the original size may reduce sharpness.</p>
							{/if}
						</section>
					{:else if activePanel === 'export'}
						<section class="space-y-2">
							<h4 class={HEADING}>Output</h4>
							<select bind:value={format} class="w-full px-2 py-1.5 text-xs rounded {INPUT}">
								<option value="png">PNG</option>
								<option value="jpeg">JPEG</option>
								<option value="webp">WebP</option>
								<option value="gif">GIF</option>
								<option value="avif">AVIF</option>
							</select>
							{#if format === 'jpeg'}
								<label class="flex items-center justify-between gap-2 text-xs text-slate-700 dark:text-slate-300">
									<span>Background fill (transparency)</span>
									<input type="color" bind:value={bgColor} class="w-8 h-6 rounded bg-transparent border border-slate-300 dark:border-slate-600 p-0" aria-label="Background fill color" />
								</label>
							{/if}
						</section>
						<section class="space-y-2">
							<h4 class={HEADING}>Compression</h4>
							<label class="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200 font-medium"><input type="checkbox" bind:checked={compress} class="accent-violet-500" /> Compress (reduce file size)</label>
							{#if compress}
								{#if format === 'png'}
									<label class="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300"><input type="checkbox" checked={!lossless} onchange={(e) => (lossless = !(e.target as HTMLInputElement).checked)} class="accent-violet-500" /> Reduce colors for a smaller file (lossy)</label>
								{:else if format === 'webp'}
									<label class="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300"><input type="checkbox" bind:checked={lossless} class="accent-violet-500" /> Lossless (pixel-perfect)</label>
								{/if}
								{#if hasQuality}
									<div class="flex gap-1.5">
										{#each QUALITY_PRESETS as preset (preset.value)}
											<button class="flex-1 px-2 py-1 text-xs rounded-lg transition-colors {!lossless && quality === preset.value ? ACTIVE : BTN}" onclick={() => applyPreset(preset.value)}>{preset.label}</button>
										{/each}
									</div>
									<label class="block text-xs"><span class={LABEL_ROW}><span>Quality</span><span>{quality}</span></span><input type="range" min="1" max="100" step="1" bind:value={quality} class="w-full accent-violet-500" /></label>
									<p class="text-xs text-slate-500">Smaller file at the same visual quality — format and dimensions stay the same.</p>
								{:else if format === 'png'}
									<p class="text-xs text-slate-500">PNG → PNG, re-encoded losslessly: identical quality, smaller when the original was saved inefficiently.</p>
								{:else if format === 'gif'}
									<p class="text-xs text-slate-500">GIF is compressed automatically via palette reduction.</p>
								{:else}
									<p class="text-xs text-slate-500">Lossless — pixels are untouched, only file size is reduced.</p>
								{/if}
							{:else}
								<p class="text-xs text-slate-500">Off — the image is saved at its original quality (no size reduction).</p>
							{/if}
						</section>
					{/if}
				</div>
			</div>
		</div>

		<!-- Footer -->
		<div class="flex-shrink-0 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 px-3 sm:px-4 py-3">
			{#if saveError}<p class="text-sm text-red-500 dark:text-red-400 mb-2">{saveError}</p>{/if}
			{#if saveMode === 'copy'}
				<div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2" transition:scaleTransition={{ duration: 120, start: 0.98 }}>
					<input bind:value={copyName} class="flex-1 px-3 py-2 text-sm rounded-lg {INPUT}" placeholder="new-file-name.png" onkeydown={(e) => e.key === 'Enter' && confirmCopy()} />
					<div class="flex gap-2">
						<button class="px-3 py-2 text-sm rounded-lg {BTN}" onclick={() => (saveMode = 'idle')} disabled={isSaving}>Cancel</button>
						<button class="px-4 py-2 text-sm rounded-lg bg-violet-600 hover:bg-violet-700 text-white flex items-center gap-2" onclick={confirmCopy} disabled={isSaving}>
							{#if isSaving}<div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>{/if}
							Save copy
						</button>
					</div>
				</div>
			{:else}
				<div class="flex items-center justify-between gap-3 flex-wrap">
					<div class="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 min-w-0">
						<span class="font-medium text-slate-600 dark:text-slate-300">{Math.round(resizeWidth)}×{Math.round(resizeHeight)}px</span>
						<span class="text-slate-300 dark:text-slate-600">·</span>
						<span>{originalSize > 0 ? formatFileSize(originalSize) : '—'}</span>
						<Icon name="lucide:arrow-right" class="w-3 h-3 opacity-60" />
						<span>{#if resultEstimating}…{:else if resultSize != null}≈ {formatFileSize(resultSize)}{:else}—{/if}</span>
						{#if savingsPct != null && resultSize != null}<span class={savingsPct >= 0 ? 'text-emerald-500 dark:text-emerald-400' : 'text-amber-500 dark:text-amber-400'}>({savingsPct >= 0 ? '−' : '+'}{Math.abs(savingsPct)}%)</span>{/if}
					</div>
					<div class="flex items-center gap-2">
						<button class="px-3 sm:px-4 py-2 text-sm rounded-lg {BTN} flex items-center gap-2" onclick={beginSaveAsCopy} disabled={isLoading || isSaving || !!loadError}>
							<Icon name="lucide:copy-plus" class="w-4 h-4" /> Save as copy…
						</button>
						<button class="px-3 sm:px-4 py-2 text-sm rounded-lg bg-violet-600 hover:bg-violet-700 text-white flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed" onclick={confirmOverwrite} disabled={isLoading || isSaving || !!loadError || !canOverwrite} title={canOverwrite ? 'Overwrite the original file' : 'Output format differs — use “Save as copy” instead'}>
							{#if isSaving}<div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>{:else}<Icon name="lucide:save" class="w-4 h-4" />{/if}
							Overwrite original
						</button>
					</div>
				</div>
			{/if}
		</div>
	{/snippet}
</Modal>

<style>
	/* Light checkerboard for transparency; dark variant under the .dark theme. */
	.checkerboard-bg {
		background-image: url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2220%22%20height%3D%2220%22%3E%3Crect%20width%3D%2220%22%20height%3D%2220%22%20fill%3D%22%23f1f5f9%22%2F%3E%3Crect%20width%3D%2210%22%20height%3D%2210%22%20fill%3D%22%23e2e8f0%22%2F%3E%3Crect%20x%3D%2210%22%20y%3D%2210%22%20width%3D%2210%22%20height%3D%2210%22%20fill%3D%22%23e2e8f0%22%2F%3E%3C%2Fsvg%3E');
	}
	:global(.dark) .checkerboard-bg {
		background-image: url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2220%22%20height%3D%2220%22%3E%3Crect%20width%3D%2220%22%20height%3D%2220%22%20fill%3D%22%23181818%22%2F%3E%3Crect%20width%3D%2210%22%20height%3D%2210%22%20fill%3D%22%23222222%22%2F%3E%3Crect%20x%3D%2210%22%20y%3D%2210%22%20width%3D%2210%22%20height%3D%2210%22%20fill%3D%22%23222222%22%2F%3E%3C%2Fsvg%3E');
	}
</style>
