<script lang="ts">
	import { onDestroy } from 'svelte';

	/**
	 * Overlay pointer.
	 *
	 * Positioned **absolutely inside the preview container**, not fixed. Fixed
	 * only agrees with viewport coordinates while nothing up the tree establishes
	 * a containing block — a single `transform`, `filter` or `backdrop-filter` on
	 * an ancestor panel silently re-bases it, which lands the cursor a whole panel
	 * offset away and outside the panel's `overflow: hidden` box. Anchoring to the
	 * container the frame is painted in cannot drift that way.
	 *
	 * `variant` is what tells them apart on screen: the agent's cursor stays
	 * amber, the local one is sky blue, and the touch trackpad's is white.
	 * Drawn in the same colour, there was no way to tell whether the browser
	 * was moving on its own.
	 *
	 * White for touch because that pointer is the one the finger is steering:
	 * it has to read against a page of any colour, and the blue was too close
	 * to the links and controls it spends its time hovering.
	 *
	 * `pressed` renders the button as held — the only visible difference
	 * between moving and dragging.
	 */
	let {
		cursor = $bindable<{ x: number; y: number; visible: boolean; clicking?: boolean; pressed?: boolean }>({
			x: 0,
			y: 0,
			visible: false,
			clicking: false
		}),
		variant = 'user' as 'user' | 'mcp' | 'touch',
		/** What the agent is doing right now, e.g. "Typing". Only the agent gets
		 *  a caption — an unattended run should read as "something else is
		 *  driving this", not as a stray cursor. "Agent" itself is static; this
		 *  is just the part appended after it. */
		activity = '' as string
	} = $props();

	const palette = $derived.by(() => {
		if (variant === 'mcp') {
			return { idle: '#FFD700', active: '#FFA500', highlight: '#FFF59D', activeHighlight: '#FFE5B4', ring: 'border-orange-500' };
		}
		if (variant === 'touch') {
			// The dark outline is what keeps a white pointer visible on a white
			// page; the "active" shade only dims it, so a press still reads.
			return { idle: '#FFFFFF', active: '#D4D4D8', highlight: '#F4F4F5', activeHighlight: '#E4E4E7', ring: 'border-white' };
		}
		return { idle: '#38BDF8', active: '#0284C7', highlight: '#BAE6FD', activeHighlight: '#E0F2FE', ring: 'border-sky-500' };
	});

	const engaged = $derived(!!cursor.clicking || !!cursor.pressed);

	/**
	 * Movement feel, agent cursor only. A real pointer (user/touch) already
	 * looks right snapping straight to input — easing it would just add lag
	 * a finger or mouse never has. The agent is different: idle here means
	 * "holding still", not "no event arrived" — it can sit through a long
	 * `wait_for` or `screenshot` with nothing to say, and a frozen pointer
	 * next to a page that keeps changing on its own reads as broken. Floating
	 * it gently is what says "still here" instead.
	 */
	const IDLE_DELAY_MS = 220;
	let isIdle = $state(true);
	let lastX = cursor.x;
	let lastY = cursor.y;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		const x = cursor.x;
		const y = cursor.y;
		if (variant !== 'mcp') return;
		if (x === lastX && y === lastY) return;
		lastX = x;
		lastY = y;
		isIdle = false;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			isIdle = true;
		}, IDLE_DELAY_MS);
	});

	const floating = $derived(variant === 'mcp' && isIdle);

	/**
	 * Typewriter for the caption — types in, holds, backspaces out.
	 *
	 * Three problems, three timers:
	 *  - Activities arrive one per tool call, and some (a `wait` that resolves
	 *    in 200ms) are gone before they'd be readable. `commitTimer` only
	 *    accepts a new target once it has survived COMMIT_DELAY_MS unchanged,
	 *    so those never get typed at all.
	 *  - A caption that *does* get typed still needs a minimum time on screen
	 *    once fully shown, or "brief but not too brief" activities flash and
	 *    vanish just as unreadably. `holdTimer` blocks an erase from starting
	 *    until MIN_HOLD_MS after typing finished, even if the target already
	 *    moved on underneath it.
	 *  - Disappearing (or switching to a different activity) is never an
	 *    instant cut: `currentSuffix` only ever grows or shrinks one
	 *    character at a time toward whatever `desiredSuffix` currently is,
	 *    erasing back to their common prefix before typing the rest forward.
	 *    "Agent" itself is outside this loop entirely — it renders statically.
	 */
	const COMMIT_DELAY_MS = 180;
	const MIN_HOLD_MS = 900;
	const TYPE_MS_PER_CHAR = 12;
	const ERASE_MS_PER_CHAR = 8;

	let renderedSuffix = $state('');
	let currentSuffix = '';
	let desiredSuffix = '';
	let phase: 'idle' | 'typing' | 'holding' | 'erasing' = 'idle';
	let holdUntil = 0;
	let commitTimer: ReturnType<typeof setTimeout> | undefined;
	let stepTimer: ReturnType<typeof setTimeout> | undefined;
	let holdTimer: ReturnType<typeof setTimeout> | undefined;

	function suffixFor(a: string): string {
		return a ? ` · ${a}` : '';
	}

	function advance() {
		if (stepTimer) return;
		const target = desiredSuffix;

		if (currentSuffix === target) {
			if (target) {
				phase = 'holding';
				holdUntil = Date.now() + MIN_HOLD_MS;
				if (holdTimer) clearTimeout(holdTimer);
				holdTimer = setTimeout(advance, MIN_HOLD_MS);
			} else {
				phase = 'idle';
			}
			return;
		}

		if (phase === 'holding') {
			const remaining = holdUntil - Date.now();
			if (remaining > 0) {
				if (holdTimer) clearTimeout(holdTimer);
				holdTimer = setTimeout(advance, remaining);
				return;
			}
		}

		const growing = target.startsWith(currentSuffix);
		phase = growing ? 'typing' : 'erasing';
		stepTimer = setTimeout(
			() => {
				stepTimer = undefined;
				currentSuffix = growing ? target.slice(0, currentSuffix.length + 1) : currentSuffix.slice(0, -1);
				renderedSuffix = currentSuffix;
				advance();
			},
			growing ? TYPE_MS_PER_CHAR : ERASE_MS_PER_CHAR
		);
	}

	$effect(() => {
		const next = suffixFor(activity);
		if (commitTimer) clearTimeout(commitTimer);
		commitTimer = setTimeout(() => {
			desiredSuffix = next;
			advance();
		}, COMMIT_DELAY_MS);
	});

	onDestroy(() => {
		if (idleTimer) clearTimeout(idleTimer);
		if (commitTimer) clearTimeout(commitTimer);
		if (stepTimer) clearTimeout(stepTimer);
		if (holdTimer) clearTimeout(holdTimer);
	});
</script>

{#if cursor.visible}
	<div
		class="absolute pointer-events-none z-50 transition-all duration-100 ease-out"
		style="left: {cursor.x}px; top: {cursor.y}px; margin-left: -4.167px; margin-top: -2.5px;"
	>
		<div class={floating ? 'vc-float' : ''}>
			<!-- Cursor body with fixed size -->
			<svg
				width="20"
				height="20"
				viewBox="0 0 24 24"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
				class="vc-svg transition-transform duration-150 {engaged ? 'scale-90' : ''}"
			>
				<!-- Cursor arrow -->
				<path
					d="M5 3L19 12L12 13L8 21L5 3Z"
					fill={engaged ? palette.active : palette.idle}
					stroke="#333"
					stroke-width="1.5"
					stroke-linejoin="round"
				/>
				<!-- Inner highlight -->
				<path
					d="M7 6L15 11.5L11 12.5L8.5 17L7 6Z"
					fill={engaged ? palette.activeHighlight : palette.highlight}
					opacity="0.7"
				/>
			</svg>

			{#if variant === 'mcp'}
				<span
					class="absolute left-4 top-4 whitespace-nowrap rounded-full bg-amber-500 px-1.5 py-px text-[10px] font-semibold leading-4 text-slate-900 shadow-md"
				>
					Agent{renderedSuffix}
				</span>
			{/if}

			<!-- Click ripple effect - only show when clicking -->
			{#if cursor.clicking}
				<div class="absolute -z-20">
					<div
						class="vc-ring-contrast absolute w-6 h-6 border-2 {palette.ring} rounded-full animate-ping opacity-75"
						style="left: -8px; top: -28px; animation-duration: 0.5s;"
					></div>
				</div>
			{/if}

			<!-- Button held: a steady ring, so a drag reads as one sustained gesture
			     rather than a burst of clicks. -->
			{#if cursor.pressed && !cursor.clicking}
				<div class="absolute -z-20">
					<div
						class="vc-ring-contrast absolute w-5 h-5 border-2 {palette.ring} rounded-full opacity-90"
						style="left: -7px; top: -27px;"
					></div>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	/*
	 * Soft double halo — a faint white edge close to the shape, a fainter
	 * blurred dark glow beyond it — so contrast holds against both a white
	 * page and a dark one without reading as a hard black outline.
	 */
	.vc-svg {
		filter:
			drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.2))
			drop-shadow(0 0 1.5px rgba(255, 255, 255, 0.8))
			drop-shadow(0 0 3px rgba(0, 0, 0, 0.3));
	}

	.vc-ring-contrast {
		box-shadow:
			0 0 0 1px rgba(255, 255, 255, 0.75),
			0 0 4px 0.5px rgba(0, 0, 0, 0.3);
	}

	.vc-float {
		animation: vc-float 2.4s ease-in-out infinite;
	}

	@keyframes vc-float {
		0%,
		100% {
			transform: translateY(0);
		}
		50% {
			transform: translateY(-3px);
		}
	}
</style>
