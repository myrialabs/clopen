<script lang="ts">
	/**
	 * The browser an agent is using, as a card beside the chat — there only
	 * while an agent has a tab, sized to the page. The agent's cursor and what
	 * it is doing are drawn on it. Click, scroll and type straight onto the
	 * page (click it once, then type — no separate box). "Take over" holds
	 * the tab for the owner so the agent waits; "Hand back" lets it carry on.
	 * The cursor is the Preview Browser's own.
	 * Most of the time none of this is needed: a login or a code is asked for
	 * in the chat. It is for a captcha and the like.
	 */
	import { onDestroy } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import VirtualCursor from '$frontend/components/preview/browser/components/VirtualCursor.svelte';
	import DeviceFrame from '$frontend/components/preview/browser/components/DeviceFrame.svelte';
	import { getFrameLayout, type DeviceSize } from '$shared/constants/preview';
	import { assistantStore, type LiveFrame, type LiveTab } from '$frontend/stores/features/assistant.svelte';

	interface Props {
		tab: LiveTab;
		/** The agent let go of the tab: the last frame stays, marked done. */
		finished?: boolean;
		onCollapse: () => void;
		onClose: () => void;
		/** The card floats: its header moves it. */
		onDragStart?: (event: PointerEvent) => void;
	}

	const { tab, finished = false, onCollapse, onClose, onDragStart }: Props = $props();

	function grab(event: PointerEvent) {
		if (!onDragStart || (event.target as HTMLElement).closest('button')) return;
		onDragStart(event);
	}

	let frame = $state<LiveFrame | null>(null);
	let focused = $state(false);
	let held = $state(false);
	let surface = $state<HTMLElement>();
	let areaWidth = $state(0);
	let areaHeight = $state(0);

	/** Room around the device, as in the Preview Browser. */
	const FIT_PADDING = 32;

	/** The page in the same device mockup the Preview Browser draws, scaled to fit the card. */
	const device = $derived.by(() => {
		if (!frame) return null;
		const viewport = { width: frame.width, height: frame.height };
		const layout = getFrameLayout(frame.deviceSize as DeviceSize, viewport, true, frame.deviceModel);
		const width = Math.max(0, areaWidth - FIT_PADDING);
		const height = Math.max(0, areaHeight - FIT_PADDING);
		const scale = width && height ? Math.min(1, width / layout.footprint.width, height / layout.footprint.height) : 0;
		return { viewport, layout, scale };
	});

	/** The agent's cursor over the page, in the card's pixels — drawn unscaled, like the Preview Browser's. */
	const agentCursor = $derived.by(() => {
		if (!frame?.cursor || held || finished || !device || !device.scale) return { x: 0, y: 0, visible: false };
		const left = (areaWidth - device.layout.footprint.width * device.scale) / 2 + device.layout.screen.x * device.scale;
		const top = (areaHeight - device.layout.footprint.height * device.scale) / 2 + device.layout.screen.y * device.scale;
		return { x: left + frame.cursor.x * device.scale, y: top + frame.cursor.y * device.scale, visible: true };
	});
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;

	$effect(() => {
		held = tab.heldByOwner;
	});

	async function tick() {
		if (stopped) return;
		const next = await assistantStore.liveFrame(tab.projectId, tab.tabId);
		if (next) frame = next;
		// Faster while the owner is working in it, calmer while they just watch.
		if (!stopped && !finished) timer = setTimeout(tick, focused || held ? 400 : 900);
	}

	$effect(() => {
		void tab.tabId;
		frame = null;
		if (timer) clearTimeout(timer);
		void tick();
	});

	onDestroy(() => {
		stopped = true;
		if (timer) clearTimeout(timer);
	});

	/** Page coordinates under a pointer event. */
	function at(event: MouseEvent): { x: number; y: number } | null {
		if (!frame || !surface) return null;
		const box = surface.getBoundingClientRect();
		return { x: ((event.clientX - box.left) / box.width) * frame.width, y: ((event.clientY - box.top) / box.height) * frame.height };
	}

	function click(event: MouseEvent) {
		surface?.focus();
		const point = at(event);
		if (point) void assistantStore.liveInput({ projectId: tab.projectId, tabId: tab.tabId, type: 'click', ...point });
	}

	function wheel(event: WheelEvent) {
		event.preventDefault();
		const point = at(event);
		if (point) void assistantStore.liveInput({ projectId: tab.projectId, tabId: tab.tabId, type: 'scroll', ...point, deltaY: event.deltaY });
	}

	const KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

	async function keydown(event: KeyboardEvent) {
		if (event.isComposing) return;
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') {
			event.preventDefault();
			const text = await navigator.clipboard.readText().catch(() => '');
			if (text) void assistantStore.liveInput({ projectId: tab.projectId, tabId: tab.tabId, type: 'type', text });
			return;
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (KEYS.has(event.key)) {
			event.preventDefault();
			void assistantStore.liveInput({ projectId: tab.projectId, tabId: tab.tabId, type: 'key', key: event.key });
		} else if (event.key.length === 1) {
			event.preventDefault();
			void assistantStore.liveInput({ projectId: tab.projectId, tabId: tab.tabId, type: 'type', text: event.key });
		}
	}

	async function toggleHold() {
		held = !held;
		await assistantStore.liveHold(tab.projectId, tab.tabId, held).catch(() => (held = !held));
	}

	const iconButton = 'flex items-center justify-center w-7 h-7 rounded-md bg-transparent border-none text-slate-500 cursor-pointer hover:bg-violet-500/10';
</script>

<section class="flex flex-col h-full min-h-0 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-lg">
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<header class="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0 {onDragStart ? 'cursor-move select-none touch-none' : ''}" onpointerdown={grab}>
		<span class="w-1.5 h-1.5 rounded-full shrink-0 {finished ? 'bg-slate-400' : held ? 'bg-amber-500' : 'bg-emerald-500 animate-pulse'}"></span>
		<span class="flex-1 min-w-0 text-xs text-slate-600 dark:text-slate-300 truncate" title={frame?.url ?? tab.url}>
			{finished ? 'Done' : held ? 'You have control' : (frame?.activity ?? tab.controlledBy?.title ?? 'Browser')}
		</span>
		{#if !finished}
			<button
				type="button"
				class="px-2 py-1 rounded-md text-2xs font-medium border cursor-pointer {held ? 'border-violet-500 bg-violet-600 text-white' : 'border-slate-200 dark:border-slate-700 bg-transparent text-slate-600 dark:text-slate-300 hover:bg-violet-500/10'}"
				onclick={toggleHold}
				title={held ? 'Let the agent carry on' : 'Pause the agent and use the page yourself'}
			>{held ? 'Hand back' : 'Take over'}</button>
		{/if}
		<button type="button" class={iconButton} onclick={onCollapse} aria-label="Fold"><Icon name="lucide:minimize-2" class="w-3.5 h-3.5" /></button>
		<button type="button" class={iconButton} onclick={onClose} aria-label="Close"><Icon name="lucide:x" class="w-3.5 h-3.5" /></button>
	</header>
	<!-- The same dotted backdrop as the Preview Browser; the device is centred and fitted inside it. -->
	<div
		class="relative flex-1 min-h-0 overflow-hidden bg-slate-50 dark:bg-slate-950 bg-[radial-gradient(circle,_rgb(148_163_184/0.35)_1px,_transparent_1px)] [background-size:20px_20px]"
		bind:clientWidth={areaWidth}
		bind:clientHeight={areaHeight}
	>
		{#if frame && device && device.scale}
			<div class="absolute inset-0 flex items-center justify-center">
				<div class="relative shrink-0" style="width: {device.layout.footprint.width * device.scale}px; height: {device.layout.footprint.height * device.scale}px;">
					<div style="width: {device.layout.footprint.width}px; height: {device.layout.footprint.height}px; transform: scale({device.scale}); transform-origin: top left;">
						<DeviceFrame deviceSize={frame.deviceSize as DeviceSize} viewport={device.viewport} deviceModel={frame.deviceModel}>
							<div
								bind:this={surface}
								class="relative w-full h-full outline-none {finished ? 'cursor-default' : 'cursor-pointer'} {focused ? 'ring-4 ring-inset ring-violet-500/60' : ''}"
								role="application"
								aria-label="The page — click, scroll and type into it"
								tabindex="0"
								onclick={finished ? undefined : click}
								onwheel={finished ? undefined : wheel}
								onkeydown={finished ? undefined : keydown}
								onfocus={() => (focused = true)}
								onblur={() => (focused = false)}
							>
								<img src={frame.image} alt={tab.title} class="block w-full h-full object-fill select-none pointer-events-none {finished ? 'opacity-80' : ''}" draggable="false" />
							</div>
						</DeviceFrame>
					</div>
				</div>
			</div>
			<VirtualCursor cursor={agentCursor} variant="mcp" activity={frame.activity ?? ''} />
		{:else}
			<div class="absolute inset-0 flex items-center justify-center gap-2 text-xs text-slate-500"><Icon name="lucide:loader" class="w-4 h-4 animate-spin" /> Connecting…</div>
		{/if}
	</div>
</section>
