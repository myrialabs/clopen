<script lang="ts">
	import type { Snippet } from 'svelte';
	import { getFrameMetrics, type DeviceSize, type Rotation } from '$frontend/utils/preview-constants';

	interface Props {
		deviceSize: DeviceSize;
		rotation: Rotation;
		canvasWidth: number;
		canvasHeight: number;
		children: Snippet;
	}

	const { deviceSize, rotation, canvasWidth, canvasHeight, children }: Props = $props();

	const metrics = $derived(getFrameMetrics(deviceSize, rotation));
	const bodyWidth = $derived(canvasWidth + metrics.left + metrics.right);
	const bodyHeight = $derived(canvasHeight + metrics.top + metrics.bottom + metrics.statusBarHeight);

	const isMobileOrTablet = $derived(deviceSize === 'mobile' || deviceSize === 'tablet');

	// Realtime clock — uses user's browser locale & timezone
	let now = $state(new Date());
	$effect(() => {
		const interval = setInterval(() => {
			now = new Date();
		}, 1000);
		return () => clearInterval(interval);
	});
	// iOS-style: locale time without AM/PM suffix (e.g. "9:41" / "21:41")
	const iosTime = $derived(
		now
			.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
			.replace(/\s?(AM|PM|am|pm)/, '')
			.trim()
	);
	// macOS-style: full locale time (e.g. "9:41 AM" / "21:41")
	const macTime = $derived(
		now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
	);

	// Side-button placement for mobile — slim action bar + volume rocker
	const mobileButtons = $derived(
		deviceSize === 'mobile'
			? rotation === 'portrait'
				? {
						power: { side: 'right' as const, offset: bodyHeight * 0.26, length: 96 },
						action: { side: 'left' as const, offset: bodyHeight * 0.14, length: 32 },
						volumeUp: { side: 'left' as const, offset: bodyHeight * 0.22, length: 58 },
						volumeDown: { side: 'left' as const, offset: bodyHeight * 0.22 + 70, length: 58 }
					}
				: {
						power: { side: 'top' as const, offset: bodyWidth * 0.26, length: 96 },
						action: { side: 'bottom' as const, offset: bodyWidth * 0.14, length: 32 },
						volumeUp: { side: 'bottom' as const, offset: bodyWidth * 0.22, length: 58 },
						volumeDown: { side: 'bottom' as const, offset: bodyWidth * 0.22 + 70, length: 58 }
					}
			: null
	);
</script>

<div
	class="device-body device-{deviceSize} relative"
	data-device={deviceSize}
	data-rotation={rotation}
	style="
		width: {bodyWidth}px;
		height: {bodyHeight}px;
		padding: {metrics.top + metrics.statusBarHeight}px {metrics.right}px {metrics.bottom}px {metrics.left}px;
		border-radius: {metrics.bodyRadius}px;
	"
>
	<!-- Solid status bar — sits between the top bezel and the screen -->
	<div
		class="status-bar absolute"
		style="
			top: {metrics.top}px;
			left: {metrics.left}px;
			width: {canvasWidth}px;
			height: {metrics.statusBarHeight}px;
			border-radius: {metrics.screenRadius}px {metrics.screenRadius}px 0 0;
		"
	>
		{#if isMobileOrTablet}
			<div
				class="ios-status-bar flex items-center justify-between h-full"
				style="padding: 0 {Math.max(14, canvasWidth * 0.045)}px;"
			>
				<span class="ios-time">{iosTime}</span>
				<div class="ios-icons flex items-center" style="gap: 5px;">
					<svg width="15" height="10" viewBox="0 0 17 10" fill="currentColor">
						<rect x="0" y="7" width="2.5" height="3" rx="0.4" />
						<rect x="4" y="5" width="2.5" height="5" rx="0.4" />
						<rect x="8" y="3" width="2.5" height="7" rx="0.4" />
						<rect x="12" y="1" width="2.5" height="9" rx="0.4" />
					</svg>
					<svg width="14" height="10" viewBox="0 0 16 12" fill="currentColor">
						<path d="M8 10.5a1.1 1.1 0 100-2.2 1.1 1.1 0 000 2.2z" />
						<path d="M4.6 7.1c.9-.9 2.1-1.4 3.4-1.4s2.5.5 3.4 1.4l-1 1c-.7-.6-1.5-1-2.4-1s-1.7.4-2.4 1l-1-1z" />
						<path d="M1.7 4.2c1.7-1.7 4-2.7 6.3-2.7s4.6 1 6.3 2.7l-1 1c-1.4-1.4-3.3-2.2-5.3-2.2s-3.9.8-5.3 2.2l-1-1z" />
					</svg>
					<div class="ios-battery">
						<div class="ios-battery-fill"></div>
					</div>
				</div>
			</div>
		{:else}
			<div
				class="mac-menubar flex items-center justify-between h-full"
				style="padding: 0 10px;"
			>
				<div class="menu-left flex items-center" style="gap: 14px;">
					<svg
						width="12"
						height="14"
						viewBox="0 0 24 24"
						fill="currentColor"
						style="flex-shrink: 0;"
						aria-hidden="true"
					>
						<path
							d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"
						/>
					</svg>
					<span class="menu-item menu-bold">Browser</span>
					<span class="menu-item">File</span>
					<span class="menu-item">Edit</span>
					<span class="menu-item">View</span>
					<span class="menu-item">Window</span>
					<span class="menu-item">Help</span>
				</div>
				<div class="menu-right flex items-center" style="gap: 10px;">
					<svg width="22" height="11" viewBox="0 0 26 12" fill="none">
						<rect x="0.5" y="0.5" width="21" height="11" rx="2" stroke="currentColor" stroke-opacity="0.5" />
						<rect x="2" y="2" width="18" height="8" rx="0.8" fill="currentColor" />
						<rect x="22.5" y="4" width="1.3" height="4" rx="0.4" fill="currentColor" fill-opacity="0.5" />
					</svg>
					<svg width="14" height="10" viewBox="0 0 16 12" fill="currentColor">
						<path d="M8 10.5a1.1 1.1 0 100-2.2 1.1 1.1 0 000 2.2z" />
						<path d="M4.6 7.1c.9-.9 2.1-1.4 3.4-1.4s2.5.5 3.4 1.4l-1 1c-.7-.6-1.5-1-2.4-1s-1.7.4-2.4 1l-1-1z" />
						<path d="M1.7 4.2c1.7-1.7 4-2.7 6.3-2.7s4.6 1 6.3 2.7l-1 1c-1.4-1.4-3.3-2.2-5.3-2.2s-3.9.8-5.3 2.2l-1-1z" />
					</svg>
					<span class="menu-time">{macTime}</span>
				</div>
			</div>
		{/if}
	</div>

	<!-- Screen slot — sits below the status bar, flat top (status bar already rounds it) -->
	<div
		class="device-screen relative overflow-hidden"
		style="
			width: {canvasWidth}px;
			height: {canvasHeight}px;
			border-radius: 0 0 {metrics.screenRadius}px {metrics.screenRadius}px;
		"
	>
		{@render children()}
	</div>

	<!-- Mobile camera — simple lens dot in the top bezel -->
	{#if metrics.notch === 'top' && deviceSize === 'mobile'}
		<div
			class="absolute left-1/2 -translate-x-1/2 camera-lens rounded-full"
			style="top: {Math.max(3, metrics.top / 2 - 5)}px; width: 10px; height: 10px;"
		>
			<div class="camera-iris absolute inset-[2.5px] rounded-full"></div>
		</div>
	{:else if metrics.notch === 'left' && deviceSize === 'mobile'}
		<div
			class="absolute top-1/2 -translate-y-1/2 camera-lens rounded-full"
			style="left: {Math.max(3, metrics.left / 2 - 5)}px; width: 10px; height: 10px;"
		>
			<div class="camera-iris absolute inset-[2.5px] rounded-full"></div>
		</div>
	{/if}

	<!-- Mobile side buttons (power + action + volume rocker) -->
	{#if mobileButtons}
		{#if mobileButtons.power.side === 'right'}
			<div
				class="absolute side-button"
				style="right: -2px; top: {mobileButtons.power.offset}px; width: 3px; height: {mobileButtons.power.length}px; border-radius: 0 3px 3px 0;"
			></div>
			<div
				class="absolute side-button"
				style="left: -2px; top: {mobileButtons.action.offset}px; width: 3px; height: {mobileButtons.action.length}px; border-radius: 3px 0 0 3px;"
			></div>
			<div
				class="absolute side-button"
				style="left: -2px; top: {mobileButtons.volumeUp.offset}px; width: 3px; height: {mobileButtons.volumeUp.length}px; border-radius: 3px 0 0 3px;"
			></div>
			<div
				class="absolute side-button"
				style="left: -2px; top: {mobileButtons.volumeDown.offset}px; width: 3px; height: {mobileButtons.volumeDown.length}px; border-radius: 3px 0 0 3px;"
			></div>
		{:else if mobileButtons.power.side === 'top'}
			<div
				class="absolute side-button"
				style="top: -2px; left: {mobileButtons.power.offset}px; height: 3px; width: {mobileButtons.power.length}px; border-radius: 3px 3px 0 0;"
			></div>
			<div
				class="absolute side-button"
				style="bottom: -2px; left: {mobileButtons.action.offset}px; height: 3px; width: {mobileButtons.action.length}px; border-radius: 0 0 3px 3px;"
			></div>
			<div
				class="absolute side-button"
				style="bottom: -2px; left: {mobileButtons.volumeUp.offset}px; height: 3px; width: {mobileButtons.volumeUp.length}px; border-radius: 0 0 3px 3px;"
			></div>
			<div
				class="absolute side-button"
				style="bottom: -2px; left: {mobileButtons.volumeDown.offset}px; height: 3px; width: {mobileButtons.volumeDown.length}px; border-radius: 0 0 3px 3px;"
			></div>
		{/if}
	{/if}

	<!-- Tablet front camera -->
	{#if metrics.cameraDot === 'top'}
		<div
			class="absolute left-1/2 -translate-x-1/2 camera-lens rounded-full"
			style="top: {Math.max(4, metrics.top / 2 - 4)}px; width: 8px; height: 8px;"
		>
			<div class="camera-iris absolute inset-[2px] rounded-full"></div>
		</div>
	{:else if metrics.cameraDot === 'left'}
		<div
			class="absolute top-1/2 -translate-y-1/2 camera-lens rounded-full"
			style="left: {Math.max(4, metrics.left / 2 - 4)}px; width: 8px; height: 8px;"
		>
			<div class="camera-iris absolute inset-[2px] rounded-full"></div>
		</div>
	{/if}

	<!-- Desktop monitor stand — thin arm + pill base -->
	{#if metrics.stand}
		<div
			class="absolute left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none"
			style="top: 100%;"
		>
			<div class="stand-neck" style="width: 14px; height: 28px;"></div>
			<div class="stand-base" style="width: {Math.min(bodyWidth * 0.22, 260)}px; height: 10px;"></div>
		</div>
	{/if}
</div>

<style>
	/* Unified titanium-gray body — same in light & dark mode, visible on both */
	.device-body {
		background: linear-gradient(145deg, #71717a 0%, #52525b 45%, #3f3f46 100%);
		border: 1px solid rgba(255, 255, 255, 0.1);
		outline: 1px solid rgba(0, 0, 0, 0.35);
		outline-offset: -1px;
	}

	/* Screen — deep black, seamless with the status bar above */
	.device-screen {
		background: #000;
	}

	/* Solid status bar — merges seamlessly with the screen below */
	.status-bar {
		background: #000;
		color: #fff;
	}

	/* iOS-style status bar (mobile / tablet) */
	.ios-status-bar {
		font-size: 11px;
		font-weight: 600;
		font-feature-settings: 'tnum';
		letter-spacing: 0.01em;
	}

	.ios-battery {
		position: relative;
		width: 22px;
		height: 10px;
		border: 1px solid rgba(255, 255, 255, 0.55);
		border-radius: 2.5px;
		padding: 1px;
	}

	.ios-battery::after {
		content: '';
		position: absolute;
		right: -3px;
		top: 3px;
		width: 1.5px;
		height: 4px;
		background: rgba(255, 255, 255, 0.55);
		border-radius: 0 1px 1px 0;
	}

	.ios-battery-fill {
		width: 100%;
		height: 100%;
		background: currentColor;
		border-radius: 1px;
	}

	/* macOS-style menubar (laptop / desktop) */
	.mac-menubar {
		font-size: 11px;
		font-weight: 500;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
	}

	.menu-bold {
		font-weight: 700;
	}

	.menu-time {
		font-feature-settings: 'tnum';
	}

	/* Camera lens (mobile + tablet) */
	.camera-lens {
		background: #0a0a0c;
		border: 1px solid rgba(255, 255, 255, 0.12);
	}

	.camera-iris {
		background: radial-gradient(circle at 35% 35%, #52525b 0%, #18181b 55%, #000 100%);
	}

	/* Side buttons — polished aluminum stripe */
	.side-button {
		background: linear-gradient(to right, #3f3f46 0%, #a1a1aa 50%, #3f3f46 100%);
	}

	/* Desktop stand — thin neck + pill base, matches device body */
	.stand-neck {
		background: linear-gradient(to right, #3f3f46 0%, #a1a1aa 50%, #3f3f46 100%);
		border-radius: 0 0 3px 3px;
	}

	.stand-base {
		background: linear-gradient(180deg, #71717a 0%, #3f3f46 100%);
		border-radius: 999px;
	}
</style>
