/**
 * Device mockup, drawn into a canvas around a screenshot.
 *
 * Reads the same `FrameLayout` the live frame is built from, so a framed
 * screenshot puts the page exactly where the preview shows it — beside the
 * status bar and the home indicator, never under them. The finish is the
 * dark one the light theme shows: it reads on any background the image ends
 * up on, which a light device on a light document would not.
 *
 * One renderer for both sides. The viewer calls it directly; the server has
 * no canvas, so it runs the very same function inside a page of the preview
 * browser — which is why `drawDeviceFrame` must stay self-contained: it is
 * shipped as source text, and anything it reached outside its own body would
 * not be there.
 */

import {
	getFrameLayout,
	type DeviceSize,
	type FrameLayout,
	type PageColors,
	type ViewportSize
} from '$shared/constants/preview';
import { foregroundFor } from './page-colors';

export interface FrameSpec {
	deviceSize: DeviceSize;
	viewport: ViewportSize;
	deviceModel: string | null;
	pageColors?: PageColors | null;
}

/** Everything the drawing needs, already resolved — plain data, so it can cross into a page. */
export interface FrameDrawInput {
	layout: FrameLayout;
	viewportWidth: number;
	statusBar: string;
	statusInk: string;
	background: string;
	backgroundInk: string;
}

/** Whether a screenshot of this device would get a mockup at all. */
export function hasDeviceFrame(spec: Pick<FrameSpec, 'deviceSize' | 'viewport' | 'deviceModel'>): boolean {
	return getFrameLayout(spec.deviceSize, spec.viewport, true, spec.deviceModel).kind !== 'none';
}

/** The drawing input for a device, or null when it has no mockup. */
export function frameDrawInput(spec: FrameSpec): FrameDrawInput | null {
	const layout = getFrameLayout(spec.deviceSize, spec.viewport, true, spec.deviceModel);
	if (layout.kind === 'none') return null;
	const statusBar = spec.pageColors?.statusBar ?? '#ffffff';
	const background = spec.pageColors?.background ?? '#ffffff';
	return {
		layout,
		viewportWidth: spec.viewport.width,
		statusBar,
		statusInk: foregroundFor(statusBar),
		background,
		backgroundInk: foregroundFor(background)
	};
}

/**
 * The image inside its device, on a transparent background.
 *
 * SELF-CONTAINED: no reference to anything outside this function body.
 */
export function drawDeviceFrame(
	image: CanvasImageSource & { width: number; height: number },
	input: FrameDrawInput
): HTMLCanvasElement | null {
	type Rect = { x: number; y: number; width: number; height: number };
	type Corners = [number, number, number, number];
	type Finish = { hi: string; mid: string; lo: string };

	const FINISH: Record<string, Finish> = {
		default: { hi: '#6b6b70', mid: '#48484d', lo: '#2a2a2e' },
		aluminum: { hi: '#6b6b70', mid: '#48484d', lo: '#2a2a2e' },
		titanium: { hi: '#5e5d5b', mid: '#3e3d3b', lo: '#222221' },
		'space-black': { hi: '#4a4a4f', mid: '#2e2e32', lo: '#18181b' },
		plastic: { hi: '#2f2f33', mid: '#232326', lo: '#161618' }
	};
	const SYSTEM_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif";
	const ANDROID_FONT = "Roboto, 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif";

	const { layout } = input;
	const scale = image.width / input.viewportWidth;
	const canvas = document.createElement('canvas');
	canvas.width = Math.round(layout.footprint.width * scale);
	canvas.height = Math.round(layout.footprint.height * scale);
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	ctx.scale(scale, scale);

	const roundedRect = (rect: Rect, radius: Corners | number = 0) => {
		ctx.beginPath();
		ctx.roundRect(rect.x, rect.y, rect.width, rect.height, Array.isArray(radius) ? radius : [radius]);
	};
	const fill = (rect: Rect, style: string | CanvasGradient, radius: Corners | number = 0) => {
		roundedRect(rect, radius);
		ctx.fillStyle = style;
		ctx.fill();
	};
	const metal = (rect: Rect, finish: Finish) => {
		const gradient = ctx.createLinearGradient(rect.x, rect.y, rect.x + rect.width * 0.45, rect.y + rect.height);
		gradient.addColorStop(0, finish.hi);
		gradient.addColorStop(0.4, finish.mid);
		gradient.addColorStop(1, finish.lo);
		return gradient;
	};
	const lens = (cx: number, cy: number, size: number) => {
		const gradient = ctx.createRadialGradient(cx - size * 0.15, cy - size * 0.15, 0, cx, cy, size / 2);
		gradient.addColorStop(0, '#2b3a4d');
		gradient.addColorStop(0.6, '#0b0f15');
		gradient.addColorStop(1, '#000');
		ctx.beginPath();
		ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
		ctx.fillStyle = gradient;
		ctx.fill();
	};

	const now = new Date();
	const shortTime = now
		.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
		.replace(/\s?(AM|PM|am|pm)/, '')
		.trim();
	const fullTime = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

	/** Signal bars, wifi and battery, right-aligned to `right`, centred on `cy`. */
	const statusGlyphs = (right: number, cy: number, unit: number, colour: string) => {
		ctx.fillStyle = colour;
		ctx.strokeStyle = colour;

		const batteryW = unit * 2.1;
		const batteryH = unit;
		const batteryX = right - batteryW;
		ctx.lineWidth = Math.max(1, unit * 0.09);
		roundedRect({ x: batteryX, y: cy - batteryH / 2, width: batteryW - unit * 0.18, height: batteryH }, unit * 0.25);
		ctx.stroke();
		fill({ x: batteryX + unit * 0.16, y: cy - batteryH / 2 + unit * 0.16, width: batteryW - unit * 0.5, height: batteryH - unit * 0.32 }, colour, unit * 0.12);
		fill({ x: right - unit * 0.12, y: cy - unit * 0.2, width: unit * 0.12, height: unit * 0.4 }, colour, unit * 0.05);

		const wifiCx = batteryX - unit * 1.1;
		ctx.lineWidth = unit * 0.2;
		ctx.lineCap = 'round';
		for (const r of [0.35, 0.7, 1.05]) {
			ctx.beginPath();
			ctx.arc(wifiCx, cy + unit * 0.55, unit * r, Math.PI * 1.25, Math.PI * 1.75);
			ctx.stroke();
		}

		const barsRight = wifiCx - unit * 1.1;
		for (let index = 0; index < 4; index++) {
			const height = unit * (0.35 + index * 0.22);
			fill({ x: barsRight - (3 - index) * unit * 0.32 - unit * 0.22, y: cy + unit * 0.5 - height, width: unit * 0.22, height }, colour, unit * 0.05);
		}
	};

	const drawStatusBar = (bar: Rect) => {
		ctx.textBaseline = 'middle';
		if (layout.os === 'macos') {
			fill(bar, 'rgba(245, 245, 247, 0.96)');
			const size = layout.kind === 'laptop' ? 13 : 12;
			const cy = bar.y + bar.height / 2;
			ctx.fillStyle = '#111113';
			// The apple, as a plain dot of ink — a logo is not worth a path here.
			ctx.beginPath();
			ctx.arc(bar.x + 22, cy, size * 0.42, 0, Math.PI * 2);
			ctx.fill();
			ctx.font = `700 ${size}px ${SYSTEM_FONT}`;
			ctx.fillText('Safari', bar.x + 40, cy);
			let x = bar.x + 40 + ctx.measureText('Safari').width + 18;
			ctx.font = `500 ${size}px ${SYSTEM_FONT}`;
			for (const item of ['File', 'Edit', 'View', 'History', 'Bookmarks', 'Window', 'Help']) {
				ctx.fillText(item, x, cy);
				x += ctx.measureText(item).width + 18;
			}
			const clock = `${now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}  ${fullTime}`;
			ctx.textAlign = 'right';
			ctx.fillText(clock, bar.x + bar.width - 16, cy);
			ctx.textAlign = 'left';
			return;
		}

		fill(bar, input.statusBar);
		const android = layout.os === 'android';
		const phone = layout.kind === 'phone';
		const size = phone ? (android ? 14 : 16) : 12;
		ctx.fillStyle = input.statusInk;
		ctx.font = `${android ? 500 : 600} ${size}px ${android ? ANDROID_FONT : SYSTEM_FONT}`;

		// Phones with an island centre their items on the island's band, not the bar.
		const cy = layout.island ? layout.island.y + layout.island.height / 2 : bar.y + bar.height / 2;
		const inset = phone ? (layout.island ? Math.max(24, (bar.width - layout.island.width) / 4 - 20) : 18) : 22;
		ctx.textAlign = 'left';
		ctx.fillText(shortTime, bar.x + inset, cy);
		statusGlyphs(bar.x + bar.width - inset, cy, phone ? 11 : 9, input.statusInk);
	};

	const drawTaskbar = (bar: Rect) => {
		fill(bar, 'rgba(238, 240, 244, 0.96)');
		const cy = bar.y + bar.height / 2;
		const logo = 18;
		const cx = bar.x + bar.width / 2 - 60;
		const half = logo / 2 - 0.5;
		for (const [dx, dy] of [[0, 0], [half + 1, 0], [0, half + 1], [half + 1, half + 1]]) {
			fill({ x: cx + dx, y: cy - logo / 2 + dy, width: half, height: half }, '#0a84ff');
		}
		['#f2b600', '#1f6feb', '#7c3aed'].forEach((colour, index) => {
			fill({ x: cx + 40 + index * 34, y: cy - 11, width: 22, height: 22 }, colour, 5);
		});
		ctx.fillStyle = '#111113';
		ctx.font = `12px ${ANDROID_FONT}`;
		ctx.textAlign = 'right';
		ctx.textBaseline = 'middle';
		ctx.fillText(fullTime, bar.x + bar.width - 14, cy - 7);
		ctx.fillText(now.toLocaleDateString(), bar.x + bar.width - 14, cy + 8);
		ctx.textAlign = 'left';
	};

	const drawNavBar = (bar: Rect & { direction: 'horizontal' | 'vertical' }) => {
		fill(bar, input.background);
		ctx.strokeStyle = input.backgroundInk;
		ctx.lineWidth = 1.8;
		ctx.lineJoin = 'round';

		// Back, home, recents — left to right, or bottom to top when turned.
		const vertical = bar.direction === 'vertical';
		const length = vertical ? bar.height : bar.width;
		const [back, home, recents] = [0.25, 0.5, 0.75].map((fraction) =>
			vertical
				? { x: bar.x + bar.width / 2, y: bar.y + length * (1 - fraction) }
				: { x: bar.x + length * fraction, y: bar.y + bar.height / 2 }
		);

		ctx.beginPath();
		ctx.moveTo(back.x + 4, back.y - 5.5);
		ctx.lineTo(back.x + 4, back.y + 5.5);
		ctx.lineTo(back.x - 4.5, back.y);
		ctx.closePath();
		ctx.stroke();

		ctx.beginPath();
		ctx.arc(home.x, home.y, 6, 0, Math.PI * 2);
		ctx.stroke();

		roundedRect({ x: recents.x - 5.5, y: recents.y - 5.5, width: 11, height: 11 }, 1.5);
		ctx.stroke();
	};

	const finish = FINISH[layout.finish ?? 'default'] ?? FINISH.default;

	// Stand and deck sit behind the body.
	if (layout.neck) fill(layout.neck, metal(layout.neck, finish));
	if (layout.foot) fill(layout.foot, metal(layout.foot, finish), layout.foot.height / 2);
	for (const foot of layout.feet) fill(foot, finish.lo, 2);
	if (layout.base) fill(layout.base, metal(layout.base, finish), [2, 2, layout.base.height, layout.base.height]);
	if (layout.scoop) fill(layout.scoop, finish.lo, [0, 0, layout.scoop.height, layout.scoop.height]);

	for (const button of layout.buttons) {
		const leading = button.edge === 'left' || button.edge === 'top';
		fill(button, finish.mid, leading ? [3, 1, 1, 3] : [1, 3, 3, 1]);
	}

	fill(layout.body, metal(layout.body, finish), layout.bodyRadius);
	const glass = ctx.createLinearGradient(0, layout.glass.y, 0, layout.glass.y + layout.glass.height);
	glass.addColorStop(0, '#0d0d10');
	glass.addColorStop(1, '#050506');
	fill(layout.glass, glass, layout.glassRadius);

	// Everything on the display is clipped to its rounded corners.
	ctx.save();
	roundedRect(layout.display, layout.displayRadius);
	ctx.clip();
	fill(layout.display, input.background);

	if (layout.statusBar) drawStatusBar(layout.statusBar);

	ctx.save();
	roundedRect(layout.screen, layout.screenRadius);
	ctx.clip();
	ctx.drawImage(image, layout.screen.x, layout.screen.y, layout.screen.width, layout.screen.height);
	ctx.restore();

	if (layout.bottomBar && layout.os === 'windows') drawTaskbar(layout.bottomBar);
	if (layout.homeIndicator) fill(layout.homeIndicator, input.backgroundInk, layout.homeIndicator.height / 2);
	if (layout.navBar) drawNavBar(layout.navBar);
	if (layout.island) fill(layout.island, '#000', layout.island.height / 2);
	if (layout.notch) fill(layout.notch, '#000', [0, 0, layout.notch.height * 0.6, layout.notch.height * 0.6]);
	if (layout.punchHole) {
		const hole = layout.punchHole;
		lens(hole.x + hole.width / 2, hole.y + hole.height / 2, hole.width);
	}
	if (layout.camera && (layout.island || layout.notch)) lens(layout.camera.x, layout.camera.y, layout.camera.size);
	ctx.restore();

	// Lenses, the earpiece and the home button live in the bezel.
	if (layout.camera && !layout.island && !layout.notch) lens(layout.camera.x, layout.camera.y, layout.camera.size);
	if (layout.earpiece) fill(layout.earpiece, '#1a1a1d', layout.earpiece.height / 2);
	if (layout.homeButton) {
		const button = layout.homeButton;
		ctx.beginPath();
		ctx.arc(button.x + button.width / 2, button.y + button.height / 2, button.width / 2, 0, Math.PI * 2);
		ctx.strokeStyle = finish.hi;
		ctx.lineWidth = 2;
		ctx.stroke();
	}

	return canvas;
}

/** The image inside its device, or null when the device has no mockup. In a browser context. */
export function renderInDeviceFrame(
	image: CanvasImageSource & { width: number; height: number },
	spec: FrameSpec
): HTMLCanvasElement | null {
	const input = frameDrawInput(spec);
	return input ? drawDeviceFrame(image, input) : null;
}
