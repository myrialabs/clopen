<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		cornersToCss,
		getFrameLayout,
		type DeviceSize,
		type PageColors,
		type Rect,
		type ViewportSize
	} from '$frontend/utils/preview-constants';
	import { foregroundFor } from '../core/page-colors';

	interface Props {
		deviceSize: DeviceSize;
		/**
		 * The page's exact size. Taken from the parent rather than recomputed
		 * from the class: the canvas sizes its bitmap from the same value, and
		 * because the canvas is `object-contain`, a frame that disagreed with it
		 * by even a few frames letterboxed the picture — which is exactly the
		 * offset that once made clicks land up and to the left of the pointer.
		 */
		viewport: ViewportSize;
		/** The model to draw; the class default when null. */
		deviceModel?: string | null;
		showFrame?: boolean;
		/**
		 * The colours the page asks to be framed in — its theme-color and its
		 * background, read from the DOM. The system bands beside the page are
		 * painted in them, which is how Safari and Chrome frame a page that has
		 * not opted into running under the status bar. White, the default
		 * canvas, until the page has said otherwise.
		 */
		pageColors?: PageColors | null;
		children: Snippet;
	}

	const { deviceSize, viewport, deviceModel = null, showFrame = true, pageColors = null, children }: Props = $props();

	const layout = $derived(getFrameLayout(deviceSize, viewport, showFrame, deviceModel));
	const framed = $derived(layout.kind !== 'none');

	const statusBarColour = $derived(pageColors?.statusBar ?? '#ffffff');
	const backgroundColour = $derived(pageColors?.background ?? '#ffffff');

	/** A band in one of the page's colours, with ink that reads on it. */
	function band(colour: string): string {
		return `--band-bg: ${colour}; --band-fg: ${foregroundFor(colour)};`;
	}

	/** Absolute placement, optionally relative to an enclosing rect. */
	function place(rect: Rect, origin?: Rect): string {
		const x = rect.x - (origin?.x ?? 0);
		const y = rect.y - (origin?.y ?? 0);
		return `left: ${x}px; top: ${y}px; width: ${rect.width}px; height: ${rect.height}px;`;
	}

	// Realtime clock — uses user's browser locale & timezone
	let now = $state(new Date());
	$effect(() => {
		if (!framed) return;
		const interval = setInterval(() => {
			now = new Date();
		}, 1000);
		return () => clearInterval(interval);
	});
	// iOS-style: locale time without AM/PM suffix (e.g. "9:41" / "21:41")
	const shortTime = $derived(
		now
			.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
			.replace(/\s?(AM|PM|am|pm)/, '')
			.trim()
	);
	const fullTime = $derived(now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
	const shortDate = $derived(
		now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
	);
	const numericDate = $derived(now.toLocaleDateString());

	/** Phone status items sit in the two "ears" either side of the island. */
	const earWidth = $derived(
		layout.island && layout.statusBar ? (layout.statusBar.width - layout.island.width) / 2 : 0
	);
	const islandBand = $derived(
		layout.island ? layout.island.y - layout.display.y + layout.island.height : 0
	);
	const isPhone = $derived(layout.kind === 'phone');
</script>

{#snippet signalIcon(width: number)}
	<svg {width} height={width * 0.65} viewBox="0 0 17 11" fill="currentColor" aria-hidden="true">
		<rect x="0" y="7" width="3" height="4" rx="0.7" />
		<rect x="4.6" y="5" width="3" height="6" rx="0.7" />
		<rect x="9.2" y="2.6" width="3" height="8.4" rx="0.7" />
		<rect x="13.8" y="0" width="3" height="11" rx="0.7" />
	</svg>
{/snippet}

{#snippet androidSignalIcon(size: number)}
	<svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
		<path d="M12 0v12H0z" />
	</svg>
{/snippet}

{#snippet wifiIcon(width: number)}
	<svg {width} height={width * 0.75} viewBox="0 0 16 12" fill="currentColor" aria-hidden="true">
		<path d="M8 11.2a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z" />
		<path d="M4.4 7.2A5.1 5.1 0 0 1 8 5.7c1.4 0 2.6.5 3.6 1.5l-1.1 1.1A3.6 3.6 0 0 0 8 7.2c-.9 0-1.8.4-2.5 1.1L4.4 7.2z" />
		<path d="M1.6 4.4A9 9 0 0 1 8 1.8c2.4 0 4.7.9 6.4 2.6l-1.1 1.1A7.5 7.5 0 0 0 8 3.3c-2 0-3.9.8-5.3 2.2L1.6 4.4z" />
	</svg>
{/snippet}

{#snippet batteryIcon(width: number)}
	<span class="battery" style="width: {width}px; height: {width * 0.48}px;" aria-hidden="true">
		<span class="battery-level"></span>
	</span>
{/snippet}

{#snippet androidBatteryIcon(height: number)}
	<span class="battery-android" style="width: {height * 0.55}px; height: {height}px;" aria-hidden="true"></span>
{/snippet}

{#snippet appleLogo(size: number)}
	<svg width={size * 0.86} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="flex-shrink: 0;">
		<path
			d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"
		/>
	</svg>
{/snippet}

{#snippet windowsLogo(size: number)}
	<svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
		<rect x="0" y="0" width="7.5" height="7.5" fill="#0a84ff" />
		<rect x="8.5" y="0" width="7.5" height="7.5" fill="#0a84ff" />
		<rect x="0" y="8.5" width="7.5" height="7.5" fill="#0a84ff" />
		<rect x="8.5" y="8.5" width="7.5" height="7.5" fill="#0a84ff" />
	</svg>
{/snippet}

{#snippet systemBar(bar: Rect)}
		{#if layout.os === 'ios' && layout.island}
			<!-- iOS with a Dynamic Island: time and icons in the ears either side. -->
			<div class="absolute status-bar status-bar-ios flex" style="{place(bar, layout.display)} {band(statusBarColour)}">
				<div
					class="flex items-center justify-center status-time-phone"
					style="width: {earWidth}px; padding-top: {layout.island.y - layout.display.y}px; height: {islandBand}px; padding-left: 10px;"
				>
					{shortTime}
				</div>
				<div style="width: {layout.island.width}px;"></div>
				<div
					class="flex items-center justify-center"
					style="width: {earWidth}px; gap: 6px; padding-top: {layout.island.y - layout.display.y}px; height: {islandBand}px; padding-right: 10px;"
				>
					{@render signalIcon(17)}
					{@render wifiIcon(16)}
					{@render batteryIcon(25)}
				</div>
			</div>
		{:else if layout.os === 'ios'}
			<!-- iOS on a home-button iPhone: signal left, time centred, battery right. -->
			<div
				class="absolute status-bar status-bar-ios status-bar-classic grid items-center"
				style="{place(bar, layout.display)} {band(statusBarColour)} padding: 0 6px;"
			>
				<span class="flex items-center" style="gap: 4px;">
					{@render signalIcon(14)}
					{@render wifiIcon(13)}
				</span>
				<span class="text-center">{shortTime}</span>
				<span class="flex items-center justify-end" style="gap: 4px;">
					<span>100%</span>
					{@render batteryIcon(21)}
				</span>
			</div>
		{:else if layout.os === 'ipados'}
			<div
				class="absolute status-bar status-bar-ios status-bar-tablet flex items-center justify-between"
				style="{place(bar, layout.display)} {band(statusBarColour)} padding: 0 22px;"
			>
				<span class="flex items-center" style="gap: 8px;">
					<span>{shortTime}</span>
					<span class="status-dim">{shortDate}</span>
				</span>
				<span class="flex items-center" style="gap: 6px;">
					{@render wifiIcon(14)}
					<span class="status-dim">100%</span>
					{@render batteryIcon(22)}
				</span>
			</div>
		{:else if layout.os === 'android'}
			<!-- Android: time on the left, system icons on the right, the camera hole between. -->
			<div
				class="absolute status-bar status-bar-android flex items-center justify-between"
				class:status-bar-android-phone={isPhone}
				style="{place(bar, layout.display)} {band(statusBarColour)} padding: 0 {isPhone ? 18 : 22}px;"
			>
				<span>{shortTime}</span>
				<span class="flex items-center" style="gap: 5px;">
					{@render wifiIcon(isPhone ? 15 : 14)}
					{@render androidSignalIcon(isPhone ? 13 : 12)}
					{@render androidBatteryIcon(isPhone ? 14 : 13)}
				</span>
			</div>
		{:else if layout.os === 'macos'}
			<div
				class="absolute status-bar menubar flex items-center justify-between"
				class:menubar-laptop={layout.kind === 'laptop'}
				style="{place(bar, layout.display)} padding: 0 {layout.kind === 'laptop' ? 16 : 12}px;"
			>
				<span class="flex items-center menubar-items" style="gap: 18px;">
					{@render appleLogo(layout.kind === 'laptop' ? 15 : 14)}
					<span class="menubar-app">Safari</span>
					<span>File</span>
					<span>Edit</span>
					<span>View</span>
					<span>History</span>
					<span>Bookmarks</span>
					<span>Window</span>
					<span>Help</span>
				</span>
				<span class="flex items-center menubar-items" style="gap: 14px;">
					{#if layout.kind === 'laptop'}
						{@render batteryIcon(24)}
					{/if}
					{@render wifiIcon(16)}
					<span class="menubar-clock">{shortDate}&nbsp;&nbsp;{fullTime}</span>
				</span>
			</div>
		{/if}
{/snippet}

<div
	class="device-frame device-{layout.kind} relative"
	data-device={deviceSize}
	data-model={layout.model}
	data-finish={layout.finish}
	data-os={layout.os}
	data-orientation={layout.orientation}
	style="width: {layout.footprint.width}px; height: {layout.footprint.height}px;"
>
	{#if framed}
		<!-- Stand and deck sit behind the body, the way they meet it on the real thing. -->
		{#if layout.neck}
			<div class="absolute stand-neck stand-neck-{layout.standStyle}" style={place(layout.neck)}></div>
		{/if}
		{#if layout.foot}
			<div class="absolute stand-foot stand-foot-{layout.standStyle}" style={place(layout.foot)}></div>
		{/if}
		{#each layout.feet as foot, index (index)}
			<div class="absolute device-foot" style={place(foot)}></div>
		{/each}
		{#if layout.base}
			<div
				class="absolute laptop-base laptop-base-{layout.baseStyle}"
				style="{place(layout.base)} border-radius: 2px 2px {layout.base.height}px {layout.base.height}px / 2px 2px {layout.base.height * 0.8}px {layout.base.height * 0.8}px;"
			></div>
		{/if}
		{#if layout.scoop}
			<div class="absolute laptop-scoop" style="{place(layout.scoop)} border-radius: 0 0 {layout.scoop.height}px {layout.scoop.height}px;"></div>
		{/if}

		{#each layout.buttons as button, index (index)}
			<div
				class="absolute side-button side-button-{button.edge}"
				style="{place(button)} border-radius: {button.edge === 'left' || button.edge === 'top' ? '3px 1px 1px 3px' : '1px 3px 3px 1px'};"
			></div>
		{/each}

		<div class="absolute device-body" style="{place(layout.body)} border-radius: {cornersToCss(layout.bodyRadius)};"></div>
		<div class="absolute device-glass" style="{place(layout.glass)} border-radius: {cornersToCss(layout.glassRadius)};"></div>
	{/if}

	<!--
		The lit display. Always rendered, framed or not, and always in the same
		place in the tree: the canvas lives inside it, and moving it — even by
		wrapping it in a different {#if} branch — would remount the canvas and
		tear the stream down every time the frame was toggled.
	-->
	<div
		class="absolute overflow-hidden device-display"
		class:device-display-framed={framed}
		style="{place(layout.display)} border-radius: {cornersToCss(layout.displayRadius)}; {framed ? band(backgroundColour) : ''}"
	>
		<!--
			Whatever of the display the page does not cover — the sides of a
			landscape phone, the home-indicator strip — shows the display's own
			background, which is the page's background colour.
		-->
		{#if framed && layout.statusBar}
			{@render systemBar(layout.statusBar)}
		{/if}

		<!--
			The page itself, beside the system bands and never under them, so
			no content is hidden behind the status bar or a camera cutout.
		-->
		<div class="absolute overflow-hidden device-screen" style={place(layout.screen, layout.display)}>
			{@render children()}
		</div>

		{#if framed && layout.bottomBar}
			{#if layout.os === 'windows'}
				<!-- Windows 11 taskbar: centred apps, tray and clock on the right. -->
				<div class="absolute taskbar flex items-center" style={place(layout.bottomBar, layout.display)}>
					<div class="flex flex-1 items-center justify-center" style="gap: 10px;">
						{@render windowsLogo(20)}
						<span class="taskbar-search"></span>
						<span class="taskbar-app taskbar-app-explorer"></span>
						<span class="taskbar-app taskbar-app-browser"></span>
						<span class="taskbar-app taskbar-app-store"></span>
					</div>
					<div class="taskbar-tray flex items-center" style="gap: 10px; padding-right: 12px;">
						{@render wifiIcon(15)}
						{#if layout.kind === 'laptop'}
							{@render batteryIcon(22)}
						{/if}
						<span class="flex flex-col items-end leading-tight">
							<span>{fullTime}</span>
							<span>{numericDate}</span>
						</span>
					</div>
				</div>
			{/if}
		{/if}

		{#if framed && layout.homeIndicator}
			<div
				class="absolute home-indicator"
				style="{place(layout.homeIndicator, layout.display)} {band(backgroundColour)}"
			></div>
		{/if}

		<!--
			Android three-button navigation. Back, home, recents from left to
			right; on a phone turned on its side the bar runs down the right edge
			and the same order reads bottom to top, with each icon kept upright.
		-->
		{#if framed && layout.navBar}
			<div
				class="absolute nav-bar flex items-center justify-evenly"
				class:flex-col-reverse={layout.navBar.direction === 'vertical'}
				style="{place(layout.navBar, layout.display)} {band(backgroundColour)}"
			>
				<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
					<path d="M13 3.5v11L4.5 9z" />
				</svg>
				<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
					<circle cx="9" cy="9" r="6" />
				</svg>
				<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
					<rect x="3.5" y="3.5" width="11" height="11" rx="1.5" />
				</svg>
			</div>
		{/if}

		{#if framed && layout.island}
			<div class="absolute dynamic-island" style={place(layout.island, layout.display)}></div>
		{/if}

		{#if framed && layout.punchHole}
			<div class="absolute camera-lens punch-hole rounded-full" style={place(layout.punchHole, layout.display)}></div>
		{/if}

		{#if framed && layout.notch}
			<div class="absolute camera-notch" style={place(layout.notch, layout.display)}></div>
		{/if}

		{#if framed && layout.camera && (layout.island || layout.notch)}
			<div
				class="absolute camera-lens rounded-full"
				style="left: {layout.camera.x - layout.display.x - layout.camera.size / 2}px; top: {layout.camera.y - layout.display.y - layout.camera.size / 2}px; width: {layout.camera.size}px; height: {layout.camera.size}px;"
			></div>
		{/if}
	</div>

	<!-- Lenses, the earpiece and the home button live in the bezel, outside the display. -->
	{#if framed && layout.camera && !layout.island && !layout.notch}
		<div
			class="absolute camera-lens rounded-full"
			style="left: {layout.camera.x - layout.camera.size / 2}px; top: {layout.camera.y - layout.camera.size / 2}px; width: {layout.camera.size}px; height: {layout.camera.size}px;"
		></div>
	{/if}
	{#if framed && layout.earpiece}
		<div class="absolute earpiece" style={place(layout.earpiece)}></div>
	{/if}
	{#if framed && layout.homeButton}
		<div class="absolute home-button rounded-full" style={place(layout.homeButton)}></div>
	{/if}
</div>

<style>
	/*
	 * Each model has its own finish, picked to stand out from the app around
	 * it: a dark device on the light theme, a light one on the dark theme —
	 * space grey or silver, black or natural titanium, black or white plastic.
	 * A device the colour of its backdrop disappears into it.
	 */
	.device-frame {
		--metal-hi: #6b6b70;
		--metal-mid: #48484d;
		--metal-lo: #2a2a2e;
		--metal-edge: rgba(0, 0, 0, 0.45);
		--metal-shine: rgba(255, 255, 255, 0.28);
		--outline: rgba(0, 0, 0, 0.35);
		--ui-bg: #f5f5f7;
		--ui-fg: #111113;
		--taskbar-bg: rgba(238, 240, 244, 0.96);
		font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif;
	}

	:global(.dark) .device-frame {
		--metal-hi: #f4f4f5;
		--metal-mid: #d4d4d8;
		--metal-lo: #a1a1aa;
		--metal-edge: rgba(0, 0, 0, 0.2);
		--metal-shine: rgba(255, 255, 255, 0.9);
		--outline: rgba(255, 255, 255, 0.28);
		--ui-bg: #1c1c1e;
		--ui-fg: #fff;
		--taskbar-bg: rgba(32, 32, 34, 0.96);
	}

	.device-frame[data-finish='titanium'] {
		--metal-hi: #5e5d5b;
		--metal-mid: #3e3d3b;
		--metal-lo: #222221;
	}

	:global(.dark) .device-frame[data-finish='titanium'] {
		--metal-hi: #ece8e1;
		--metal-mid: #c9c4bb;
		--metal-lo: #948f87;
	}

	.device-frame[data-finish='space-black'] {
		--metal-hi: #4a4a4f;
		--metal-mid: #2e2e32;
		--metal-lo: #18181b;
	}

	.device-frame[data-finish='plastic'] {
		--metal-hi: #2f2f33;
		--metal-mid: #232326;
		--metal-lo: #161618;
		--metal-shine: rgba(255, 255, 255, 0.1);
	}

	:global(.dark) .device-frame[data-finish='plastic'] {
		--metal-hi: #ececef;
		--metal-mid: #d6d6da;
		--metal-lo: #b4b4ba;
		--metal-shine: rgba(255, 255, 255, 0.7);
	}

	.device-frame[data-os='android'],
	.status-bar-android,
	.taskbar {
		font-family: Roboto, 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
	}

	.device-body {
		background: linear-gradient(155deg, var(--metal-hi) 0%, var(--metal-mid) 40%, var(--metal-lo) 100%);
		box-shadow:
			inset 0 1px 0 var(--metal-shine),
			inset 0 0 0 1px var(--metal-edge),
			0 0 0 1px var(--outline),
			0 24px 48px -18px rgba(0, 0, 0, 0.45);
	}

	.device-frame[data-finish='plastic'] .device-body {
		background: linear-gradient(180deg, var(--metal-hi) 0%, var(--metal-mid) 100%);
	}

	.device-glass {
		background: linear-gradient(180deg, #0d0d10 0%, #050506 100%);
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.05);
	}

	.device-display {
		background: transparent;
	}

	.device-display-framed {
		background: var(--band-bg, #fff);
		transition: background-color 300ms ease;
	}

	.device-screen {
		background: #000;
	}

	.device-frame.device-none .device-screen {
		box-shadow: 0 0 0 1px rgba(148, 163, 184, 0.35);
	}

	/* Painted in the page's status-bar colour, with ink that reads on it. */
	.status-bar {
		background: var(--band-bg, #fff);
		color: var(--band-fg, #111113);
		white-space: nowrap;
		overflow: hidden;
		transition:
			background-color 300ms ease,
			color 300ms ease;
	}

	.status-bar-ios {
		font-weight: 600;
		font-feature-settings: 'tnum';
		letter-spacing: -0.01em;
	}

	.status-time-phone {
		font-size: 16px;
	}

	.status-bar-classic {
		font-size: 12px;
		grid-template-columns: 1fr auto 1fr;
	}

	.status-bar-tablet {
		font-size: 12px;
	}

	.status-bar-android {
		font-size: 12px;
		font-weight: 500;
		font-feature-settings: 'tnum';
	}

	.status-bar-android-phone {
		font-size: 14px;
	}

	.status-dim {
		opacity: 0.6;
		font-weight: 500;
	}

	/* The menu bar belongs to the system, not the page, so it keeps the theme. */
	.menubar {
		font-size: 12px;
		font-weight: 500;
		background: color-mix(in srgb, var(--ui-bg) 92%, transparent);
		color: var(--ui-fg);
	}

	.menubar-laptop {
		font-size: 13px;
	}

	.menubar-app {
		font-weight: 700;
	}

	.menubar-clock {
		font-feature-settings: 'tnum';
	}

	.taskbar {
		background: var(--taskbar-bg);
		color: var(--ui-fg);
		font-size: 11px;
		border-top: 1px solid var(--metal-edge);
		white-space: nowrap;
		overflow: hidden;
	}

	.taskbar-search {
		width: 120px;
		height: 24px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--ui-fg) 9%, transparent);
	}

	.taskbar-app {
		width: 22px;
		height: 22px;
		border-radius: 5px;
	}

	.taskbar-app-explorer {
		background: linear-gradient(160deg, #ffd65c, #f2a900);
	}

	.taskbar-app-browser {
		background: linear-gradient(160deg, #3ddc97, #0a84ff);
		border-radius: 999px;
	}

	.taskbar-app-store {
		background: linear-gradient(160deg, #6e8bff, #3247c9);
	}

	.taskbar-tray {
		font-feature-settings: 'tnum';
	}

	.battery {
		position: relative;
		display: inline-flex;
		border: 1px solid color-mix(in srgb, currentColor 55%, transparent);
		border-radius: 3.5px;
		padding: 1.5px;
		margin-right: 2px;
	}

	.battery::after {
		content: '';
		position: absolute;
		right: -3.5px;
		top: 50%;
		transform: translateY(-50%);
		width: 1.5px;
		height: 35%;
		background: color-mix(in srgb, currentColor 55%, transparent);
		border-radius: 0 1px 1px 0;
	}

	.battery-level {
		flex: 1;
		background: currentColor;
		border-radius: 1.5px;
	}

	.battery-android {
		display: inline-block;
		background: currentColor;
		border-radius: 2px;
		position: relative;
	}

	.battery-android::before {
		content: '';
		position: absolute;
		top: -2px;
		left: 25%;
		width: 50%;
		height: 2px;
		background: currentColor;
		border-radius: 1px 1px 0 0;
	}

	.home-indicator {
		background: var(--band-fg, #111113);
		opacity: 0.85;
		border-radius: 999px;
		pointer-events: none;
		transition: background-color 300ms ease;
	}

	/* Same colour as the band it sits in; the buttons are just ink on it. */
	.nav-bar {
		color: var(--band-fg, #111113);
		background: var(--band-bg, #fff);
		opacity: 0.9;
		padding: 0 18%;
		transition:
			background-color 300ms ease,
			color 300ms ease;
	}

	/* Down the side: grouped around the middle, as Android stacks them. */
	.nav-bar.flex-col-reverse {
		padding: 0;
		justify-content: center;
		row-gap: 18%;
	}

	.dynamic-island {
		background: #000;
		border-radius: 999px;
		pointer-events: none;
	}

	.camera-notch {
		pointer-events: none;
		background: #050506;
		border-radius: 0 0 9px 9px;
	}

	.camera-lens {
		pointer-events: none;
		background: radial-gradient(circle at 35% 35%, #3b3b52 0%, #12121a 45%, #000 75%);
		box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.07);
	}

	.punch-hole {
		pointer-events: none;
		background: radial-gradient(circle at 40% 40%, #2a2a38 0%, #09090c 55%, #000 80%);
		box-shadow: 0 0 0 1.5px #000;
	}

	.earpiece {
		background: linear-gradient(180deg, #1d1d22, #0b0b0e);
		border-radius: 999px;
		box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.8);
	}

	.home-button {
		background: radial-gradient(circle at 50% 40%, #121215 0%, #050506 100%);
		box-shadow:
			inset 0 0 0 2px var(--metal-mid),
			inset 0 0 0 3px rgba(0, 0, 0, 0.6);
	}

	.side-button-left,
	.side-button-right {
		background: linear-gradient(to bottom, var(--metal-lo), var(--metal-hi) 18%, var(--metal-mid) 82%, var(--metal-lo));
	}

	.side-button-top,
	.side-button-bottom {
		background: linear-gradient(to right, var(--metal-lo), var(--metal-hi) 18%, var(--metal-mid) 82%, var(--metal-lo));
	}

	.laptop-base {
		background: linear-gradient(180deg, var(--metal-hi) 0%, var(--metal-mid) 45%, var(--metal-lo) 100%);
		box-shadow:
			inset 0 1px 0 var(--metal-shine),
			0 14px 24px -10px rgba(0, 0, 0, 0.45);
	}

	/* A plastic notebook shows its hinge as a dark band along the top of the deck. */
	.laptop-base-notebook {
		background: linear-gradient(180deg, #0c0c0e 0%, #0c0c0e 22%, var(--metal-mid) 24%, var(--metal-lo) 100%);
	}

	.laptop-scoop {
		background: linear-gradient(180deg, var(--metal-lo) 0%, var(--metal-mid) 100%);
		box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.25);
	}

	.device-foot {
		background: #0e0e10;
		border-radius: 0 0 3px 3px;
	}

	.stand-neck-studio {
		background: linear-gradient(180deg, var(--metal-lo) 0%, var(--metal-mid) 22%, var(--metal-hi) 100%);
		box-shadow: inset 1px 0 0 var(--metal-edge), inset -1px 0 0 var(--metal-edge);
	}

	.stand-foot-studio {
		background: linear-gradient(180deg, var(--metal-hi) 0%, var(--metal-mid) 55%, var(--metal-lo) 100%);
		border-radius: 3px 3px 999px 999px / 3px 3px 100% 100%;
		box-shadow: 0 10px 18px -8px rgba(0, 0, 0, 0.45);
	}

	/* A round post on an oval base: the stand every office monitor ships with. */
	.stand-neck-pedestal {
		background: linear-gradient(90deg, var(--metal-lo) 0%, var(--metal-hi) 45%, var(--metal-mid) 70%, var(--metal-lo) 100%);
		border-radius: 0 0 6px 6px;
	}

	.stand-foot-pedestal {
		background: linear-gradient(180deg, var(--metal-hi) 0%, var(--metal-mid) 50%, var(--metal-lo) 100%);
		border-radius: 50%;
		box-shadow: 0 10px 18px -8px rgba(0, 0, 0, 0.45);
	}
</style>
