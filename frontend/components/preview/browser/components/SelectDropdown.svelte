<script lang="ts">
	/**
	 * Native `<select>` replacement for the preview canvas.
	 *
	 * Headless Chrome renders a select's popup outside the page, so it never
	 * appears in the captured frame. The backend reports the options instead and
	 * this draws them over the canvas, matched to the preview's scale and to the
	 * real element's box so it lands where the popup would have.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { BrowserSelectInfo, BrowserSelectOption } from '$frontend/utils/native-ui';

	let {
		selectInfo = null as BrowserSelectInfo | null,
		scale = 1,
		bounds = null as DOMRect | null,
		onSelect = (_index: number) => {},
		onClose = () => {}
	} = $props();

	let dropdownElement = $state<HTMLDivElement | undefined>();
	let highlightedIndex = $state(-1);
	let naturalHeight = $state(0);

	const EDGE_PADDING = 6;

	const selectedIndex = $derived(selectInfo?.selectedIndex ?? -1);

	function viewportRect(): DOMRect {
		return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
	}

	/**
	 * Anchor below the field, flipping above it when there is no room — the same
	 * choice the platform popup makes.
	 */
	const position = $derived.by(() => {
		if (!selectInfo) return { left: 0, top: 0, width: 200 };

		const area = bounds ?? viewportRect();
		const box = selectInfo.boundingBox;
		const height = naturalHeight * scale;

		// The reported box is already in display pixels; keep the popup at least
		// as wide as the field so it reads as belonging to it.
		const width = Math.max(box.width / Math.max(scale, 0.05), 180);

		let top = box.y + box.height;
		if (height > 0 && top + height > area.bottom - EDGE_PADDING) {
			const above = box.y - height;
			top = above >= area.top + EDGE_PADDING ? above : Math.max(area.top + EDGE_PADDING, area.bottom - height - EDGE_PADDING);
		}

		const left = Math.max(
			area.left + EDGE_PADDING,
			Math.min(box.x, area.right - width * scale - EDGE_PADDING)
		);

		return { left, top, width };
	});

	const maxHeight = $derived.by(() => {
		const area = bounds ?? viewportRect();
		return Math.max(120, (area.height * 0.6) / Math.max(scale, 0.05));
	});

	function measure() {
		if (dropdownElement) naturalHeight = dropdownElement.offsetHeight;
	}

	function handleOptionClick(option: BrowserSelectOption) {
		if (option.disabled) return;
		onSelect(option.index);
		onClose();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (!selectInfo) return;
		const options = selectInfo.options;

		const step = (direction: 1 | -1) => {
			let next = highlightedIndex + direction;
			while (next >= 0 && next < options.length && options[next].disabled) next += direction;
			if (next >= 0 && next < options.length) highlightedIndex = next;
		};

		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				step(1);
				break;
			case 'ArrowUp':
				event.preventDefault();
				step(-1);
				break;
			case 'Home':
				event.preventDefault();
				highlightedIndex = options.findIndex((option) => !option.disabled);
				break;
			case 'End':
				event.preventDefault();
				highlightedIndex = options.length - 1;
				break;
			case 'Enter':
			case ' ':
				event.preventDefault();
				if (highlightedIndex >= 0 && !options[highlightedIndex]?.disabled) {
					handleOptionClick(options[highlightedIndex]);
				}
				break;
			case 'Escape':
				event.preventDefault();
				onClose();
				break;
		}
	}

	$effect(() => {
		if (!selectInfo) return;

		highlightedIndex = selectInfo.selectedIndex;

		queueMicrotask(() => {
			measure();
			dropdownElement?.focus();
			dropdownElement?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
		});

		const dismissOutside = (event: Event) => {
			if (dropdownElement && !dropdownElement.contains(event.target as Node)) onClose();
		};
		const dismiss = () => onClose();

		const attach = requestAnimationFrame(() => {
			document.addEventListener('pointerdown', dismissOutside, true);
			window.addEventListener('resize', dismiss);
			window.addEventListener('blur', dismiss);
		});

		return () => {
			cancelAnimationFrame(attach);
			document.removeEventListener('pointerdown', dismissOutside, true);
			window.removeEventListener('resize', dismiss);
			window.removeEventListener('blur', dismiss);
		};
	});
</script>

{#if selectInfo}
	<div
		bind:this={dropdownElement}
		class="select-popup fixed z-[999999] py-1 rounded-lg overflow-y-auto outline-none origin-top-left
			bg-white/95 dark:bg-slate-800/95 backdrop-blur-sm
			border border-slate-200 dark:border-slate-700
			shadow-xl shadow-slate-900/20 dark:shadow-black/50"
		style="left: {position.left}px; top: {position.top}px; width: {position.width}px; max-height: {maxHeight}px; transform: scale({scale});"
		tabindex="-1"
		onkeydown={handleKeydown}
		role="listbox"
		aria-label="Select options"
	>
		{#each selectInfo.options as option, listIndex (option.index)}
			{@const group = option.group}
			{@const startsGroup = !!group && group !== selectInfo.options[listIndex - 1]?.group}
			{#if startsGroup}
				<!-- `<optgroup>` labels are part of the control's meaning, not decoration:
				     flattening them loses the only thing distinguishing same-named
				     options across groups. -->
				<div
					class="mt-1 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide first:mt-0
						{option.groupDisabled
						? 'text-slate-300 dark:text-slate-600'
						: 'text-slate-400 dark:text-slate-500'}"
					role="presentation"
				>
					{group}
				</div>
			{/if}
			<div
				class="flex items-center gap-2 mx-1 px-2.5 py-1.5 rounded-[3px] cursor-default select-none text-[13px] leading-5
					{option.group ? 'pl-5' : ''}
					{option.disabled
					? 'text-slate-400 dark:text-slate-600 cursor-not-allowed'
					: highlightedIndex === option.index
						? 'bg-violet-600 text-white'
						: 'text-slate-700 dark:text-slate-200'}"
				role="option"
				tabindex={option.disabled ? -1 : 0}
				aria-selected={option.index === selectedIndex}
				aria-disabled={option.disabled}
				data-selected={option.index === selectedIndex}
				onclick={() => handleOptionClick(option)}
				onkeydown={(event) => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						handleOptionClick(option);
					}
				}}
				onmouseenter={() => {
					if (!option.disabled) highlightedIndex = option.index;
				}}
			>
				<span class="flex w-3.5 shrink-0 items-center justify-center">
					{#if option.index === selectedIndex}
						<Icon name="lucide:check" class="w-3.5 h-3.5" />
					{/if}
				</span>
				<span class="flex-1 truncate">{option.text}</span>
			</div>
		{/each}
	</div>
{/if}

<style>
	.select-popup {
		animation: select-popup-in 90ms ease-out;
	}

	@keyframes select-popup-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
</style>
