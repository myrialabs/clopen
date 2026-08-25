<script lang="ts">
	/**
	 * Stand-in for the pickers Chrome draws outside the page.
	 *
	 * A colour swatch or a date field opens a popup rendered by the *browser
	 * process*, not the renderer — so it never appears in the captured frame, and
	 * the page looks unresponsive to a click that did in fact land.
	 *
	 * Colour is drawn here rather than delegated to the viewer's own control.
	 * `showPicker()` needs transient activation, which a WebSocket event does not
	 * carry, so the invisible native input only opened on a *second* click — and
	 * on macOS what it opens is the system colour panel: a window that ignores
	 * the page's layout and stays up until it is dismissed on its own terms.
	 * Neither is what a browser does. Date and time keep the native control,
	 * whose popup anchors to the element and closes on an outside click.
	 */
	import type { BrowserNativePickerInfo } from '$frontend/utils/native-ui';

	let {
		picker = null as BrowserNativePickerInfo | null,
		onCommit = (_value: string) => {},
		onClose = () => {}
	} = $props();

	let inputElement = $state<HTMLInputElement | undefined>();
	let panelElement = $state<HTMLDivElement | undefined>();
	let value = $state('');

	const isColor = $derived(picker?.inputType === 'color');

	/**
	 * Sized to the element's real on-screen box, which already carries the
	 * preview's fit-scale — so no separate scaling is applied.
	 */
	const box = $derived(picker?.boundingBox ?? { x: 0, y: 0, width: 0, height: 0 });

	function commit(next: string) {
		if (!next || next === value) return;
		value = next;
		onCommit(next);
	}

	// ── Colour model ──────────────────────────────────────────────────────────
	//
	// HSV, because that is what a saturation/value square plus a hue strip maps
	// onto directly; the page only ever sees the hex it produces.

	let hue = $state(0);
	let saturation = $state(0);
	let brightness = $state(0);

	const PANEL_WIDTH = 208;
	const SV_HEIGHT = 132;

	function clamp01(n: number): number {
		return Math.max(0, Math.min(1, n));
	}

	function hexToHsv(hex: string): { h: number; s: number; v: number } {
		const clean = hex.replace('#', '').trim();
		const full =
			clean.length === 3
				? clean
						.split('')
						.map((c) => c + c)
						.join('')
				: clean.padEnd(6, '0').slice(0, 6);

		const r = parseInt(full.slice(0, 2), 16) / 255;
		const g = parseInt(full.slice(2, 4), 16) / 255;
		const b = parseInt(full.slice(4, 6), 16) / 255;
		if (![r, g, b].every((n) => Number.isFinite(n))) return { h: 0, s: 0, v: 0 };

		const max = Math.max(r, g, b);
		const min = Math.min(r, g, b);
		const delta = max - min;

		let h = 0;
		if (delta > 0) {
			if (max === r) h = ((g - b) / delta) % 6;
			else if (max === g) h = (b - r) / delta + 2;
			else h = (r - g) / delta + 4;
			h *= 60;
			if (h < 0) h += 360;
		}

		return { h, s: max === 0 ? 0 : delta / max, v: max };
	}

	function hsvToHex(h: number, s: number, v: number): string {
		const c = v * s;
		const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
		const m = v - c;

		const [r, g, b] =
			h < 60
				? [c, x, 0]
				: h < 120
					? [x, c, 0]
					: h < 180
						? [0, c, x]
						: h < 240
							? [0, x, c]
							: h < 300
								? [x, 0, c]
								: [c, 0, x];

		const channel = (n: number) =>
			Math.round((n + m) * 255)
				.toString(16)
				.padStart(2, '0');

		return `#${channel(r)}${channel(g)}${channel(b)}`;
	}

	function pushColor() {
		commit(hsvToHex(hue, saturation, brightness));
	}

	/** Follow the pointer for the whole gesture, including outside the element. */
	function track(event: PointerEvent, apply: (rect: DOMRect, e: PointerEvent) => void) {
		const target = event.currentTarget as HTMLElement;
		const rect = target.getBoundingClientRect();

		apply(rect, event);
		pushColor();
		target.setPointerCapture(event.pointerId);

		const move = (moveEvent: PointerEvent) => {
			apply(rect, moveEvent);
			pushColor();
		};
		const up = () => {
			target.removeEventListener('pointermove', move);
			target.removeEventListener('pointerup', up);
			target.removeEventListener('pointercancel', up);
		};

		target.addEventListener('pointermove', move);
		target.addEventListener('pointerup', up);
		target.addEventListener('pointercancel', up);
	}

	function onSaturationPointer(event: PointerEvent) {
		event.preventDefault();
		track(event, (rect, e) => {
			saturation = clamp01((e.clientX - rect.left) / rect.width);
			brightness = 1 - clamp01((e.clientY - rect.top) / rect.height);
		});
	}

	function onHuePointer(event: PointerEvent) {
		event.preventDefault();
		track(event, (rect, e) => {
			hue = clamp01((e.clientX - rect.left) / rect.width) * 360;
		});
	}

	function onHexInput(event: Event) {
		const raw = (event.currentTarget as HTMLInputElement).value.trim();
		if (!/^#?[0-9a-fA-F]{6}$/.test(raw)) return;

		const hex = raw.startsWith('#') ? raw : `#${raw}`;
		const hsv = hexToHsv(hex);
		hue = hsv.h;
		saturation = hsv.s;
		brightness = hsv.v;
		commit(hex);
	}

	/**
	 * Anchor below the swatch, flipping above when there is no room — the same
	 * choice the platform popup makes.
	 */
	const panelPosition = $derived.by(() => {
		if (!picker) return { left: 0, top: 0 };

		const height = SV_HEIGHT + 92;
		const left = Math.max(6, Math.min(box.x, window.innerWidth - PANEL_WIDTH - 6));
		const below = box.y + box.height + 4;
		const top =
			below + height > window.innerHeight - 6 && box.y - height - 4 >= 6
				? box.y - height - 4
				: Math.min(below, Math.max(6, window.innerHeight - height - 6));

		return { left, top };
	});

	$effect(() => {
		if (!picker) return;

		value = picker.value;

		if (picker.inputType === 'color') {
			const hsv = hexToHsv(picker.value || '#000000');
			hue = hsv.h;
			saturation = hsv.s;
			brightness = hsv.v;
		} else {
			queueMicrotask(() => {
				inputElement?.focus({ preventScroll: true });
				try {
					// Opening it immediately is the point: the user already clicked the
					// field in the page, and a second click on an invisible input would
					// be a step they cannot see.
					(inputElement as HTMLInputElement & { showPicker?: () => void })?.showPicker?.();
				} catch {
					// Needs transient activation in some browsers; the input still works.
				}
			});
		}

		const dismissOutside = (event: Event) => {
			const target = event.target as Node | null;
			if (panelElement && target && panelElement.contains(target)) return;
			if (target === inputElement) return;
			onClose();
		};

		const dismiss = () => onClose();

		const attach = requestAnimationFrame(() => {
			document.addEventListener('pointerdown', dismissOutside, true);
			window.addEventListener('resize', dismiss);
		});

		return () => {
			cancelAnimationFrame(attach);
			document.removeEventListener('pointerdown', dismissOutside, true);
			window.removeEventListener('resize', dismiss);
		};
	});

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
		}
	}
</script>

{#if picker && isColor}
	<!-- Drawn here, so it opens on the click that reached the page and closes
	     when the user clicks anywhere else — like a browser's own. -->
	<div
		bind:this={panelElement}
		role="dialog"
		aria-label="Colour picker"
		tabindex="-1"
		onkeydown={onKeydown}
		class="fixed z-[999999] rounded-lg border border-slate-200 bg-white p-2 shadow-xl outline-none dark:border-slate-700 dark:bg-slate-800"
		style="left: {panelPosition.left}px; top: {panelPosition.top}px; width: {PANEL_WIDTH}px;"
	>
		<div
			role="slider"
			tabindex="-1"
			aria-label="Saturation and brightness"
			aria-valuenow={Math.round(saturation * 100)}
			onpointerdown={onSaturationPointer}
			class="relative cursor-crosshair rounded-md"
			style="height: {SV_HEIGHT}px; background:
				linear-gradient(to top, #000, rgba(0,0,0,0)),
				linear-gradient(to right, #fff, rgba(255,255,255,0)),
				hsl({hue}, 100%, 50%);"
		>
			<span
				class="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
				style="left: {saturation * 100}%; top: {(1 - brightness) * 100}%;"
			></span>
		</div>

		<div
			role="slider"
			tabindex="-1"
			aria-label="Hue"
			aria-valuenow={Math.round(hue)}
			onpointerdown={onHuePointer}
			class="relative mt-2 h-3 cursor-pointer rounded-full"
			style="background: linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%);"
		>
			<span
				class="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
				style="left: {(hue / 360) * 100}%; background: hsl({hue}, 100%, 50%);"
			></span>
		</div>

		<div class="mt-2 flex items-center gap-2">
			<span
				class="h-6 w-6 shrink-0 rounded border border-slate-300 dark:border-slate-600"
				style="background: {value};"
			></span>
			<input
				type="text"
				value={value}
				spellcheck="false"
				aria-label="Hex colour"
				oninput={onHexInput}
				class="min-w-0 flex-1 rounded border border-slate-200 bg-white px-1.5 py-1 font-mono text-xs uppercase text-slate-800 outline-none focus:border-violet-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
			/>
		</div>
	</div>
{:else if picker}
	<!--
		Date and time: the control is laid directly over the real element at its
		on-screen size and kept invisible, because the page's own field is already
		painted underneath in the video. The viewer's native popup then anchors to
		the right place, and values are written back as they change — a picker
		with a confirm button is not what any browser does.
	-->
	<input
		bind:this={inputElement}
		type={picker.inputType}
		{value}
		min={picker.min || undefined}
		max={picker.max || undefined}
		step={picker.step || undefined}
		aria-label="Value picker"
		class="fixed z-[999999] cursor-pointer border-0 bg-transparent p-0 opacity-0 outline-none"
		style="left: {box.x}px; top: {box.y}px; width: {Math.max(box.width, 8)}px; height: {Math.max(box.height, 8)}px;"
		oninput={(event) => {
			commit((event.currentTarget as HTMLInputElement).value);
		}}
		onchange={(event) => {
			commit((event.currentTarget as HTMLInputElement).value);
			// `change` means the popup closed, so the overlay's job is done.
			onClose();
		}}
		onkeydown={onKeydown}
		onblur={() => onClose()}
	/>
{/if}
