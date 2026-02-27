<script lang="ts">
	import type { BrowserSelectInfo, BrowserSelectOption } from '$frontend/lib/types/native-ui';
	import { onMount } from 'svelte';

	let {
		selectInfo = $bindable<BrowserSelectInfo | null>(null),
		onSelect = $bindable<(selectedIndex: number) => void>(() => {}),
		onClose = $bindable<() => void>(() => {})
	} = $props();

	let dropdownElement = $state<HTMLDivElement | undefined>(undefined);
	let selectedIndex = $state(-1);
	let highlightedIndex = $state(-1);

	// Position the dropdown overlay
	function getDropdownPosition() {
		if (!selectInfo) return { top: '0px', left: '0px', width: '200px' };

		const { boundingBox } = selectInfo;
		return {
			top: `${boundingBox.y + boundingBox.height}px`,
			left: `${boundingBox.x}px`,
			width: `${Math.max(boundingBox.width, 200)}px`
		};
	}

	// Handle option click
	function handleOptionClick(option: BrowserSelectOption) {
		if (option.disabled) return;
		onSelect(option.index);
		onClose();
	}

	// Handle keyboard navigation
	function handleKeydown(event: KeyboardEvent) {
		if (!selectInfo) return;

		const options = selectInfo.options;

		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				// Move to next enabled option
				let nextIndex = highlightedIndex + 1;
				while (nextIndex < options.length && options[nextIndex].disabled) {
					nextIndex++;
				}
				if (nextIndex < options.length) {
					highlightedIndex = nextIndex;
				}
				break;

			case 'ArrowUp':
				event.preventDefault();
				// Move to previous enabled option
				let prevIndex = highlightedIndex - 1;
				while (prevIndex >= 0 && options[prevIndex].disabled) {
					prevIndex--;
				}
				if (prevIndex >= 0) {
					highlightedIndex = prevIndex;
				}
				break;

			case 'Enter':
				event.preventDefault();
				if (highlightedIndex >= 0 && !options[highlightedIndex].disabled) {
					handleOptionClick(options[highlightedIndex]);
				}
				break;

			case 'Escape':
				event.preventDefault();
				onClose();
				break;
		}
	}

	// Handle click outside to close
	function handleClickOutside(event: MouseEvent) {
		if (dropdownElement && !dropdownElement.contains(event.target as Node)) {
			onClose();
		}
	}

	// Initialize
	$effect(() => {
		if (selectInfo) {
			selectedIndex = selectInfo.selectedIndex;
			highlightedIndex = selectInfo.selectedIndex;

			// Focus dropdown for keyboard navigation
			if (dropdownElement) {
				dropdownElement.focus();
			}

			// Add click outside listener
			setTimeout(() => {
				document.addEventListener('mousedown', handleClickOutside);
			}, 0);
		}

		return () => {
			document.removeEventListener('mousedown', handleClickOutside);
		};
	});

	const position = $derived(getDropdownPosition());
</script>

{#if selectInfo}
	<div
		bind:this={dropdownElement}
		class="browser-select-dropdown"
		style="top: {position.top}; left: {position.left}; width: {position.width};"
		tabindex="-1"
		onkeydown={handleKeydown}
		role="listbox"
		aria-label="Select options"
	>
		<div class="select-dropdown-list">
			{#each selectInfo.options as option (option.index)}
				<div
					class="select-option"
					class:selected={option.index === selectedIndex}
					class:highlighted={option.index === highlightedIndex}
					class:disabled={option.disabled}
					role="option"
					tabindex={option.disabled ? -1 : 0}
					aria-selected={option.index === selectedIndex}
					aria-disabled={option.disabled}
					onclick={() => handleOptionClick(option)}
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							handleOptionClick(option);
						}
					}}
					onmouseenter={() => {
						if (!option.disabled) highlightedIndex = option.index;
					}}
				>
					{option.text}
				</div>
			{/each}
		</div>
	</div>
{/if}

<style>
	.browser-select-dropdown {
		position: fixed;
		z-index: 999999;
		background: white;
		border: 1px solid #ccc;
		border-radius: 4px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
		max-height: 300px;
		overflow-y: auto;
		outline: none;
	}

	.select-dropdown-list {
		padding: 4px 0;
	}

	.select-option {
		padding: 6px 12px;
		cursor: pointer;
		user-select: none;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
		font-size: 14px;
		line-height: 1.5;
		color: #333;
	}

	.select-option:hover:not(.disabled) {
		background: #f0f0f0;
	}

	.select-option.highlighted:not(.disabled) {
		background: #e6f7ff;
	}

	.select-option.selected {
		background: #1890ff;
		color: white;
	}

	.select-option.disabled {
		color: #999;
		cursor: not-allowed;
		opacity: 0.6;
	}

	/* Dark mode support */
	@media (prefers-color-scheme: dark) {
		.browser-select-dropdown {
			background: #2d2d2d;
			border-color: #444;
		}

		.select-option {
			color: #e0e0e0;
		}

		.select-option:hover:not(.disabled) {
			background: #3a3a3a;
		}

		.select-option.highlighted:not(.disabled) {
			background: #003d66;
		}

		.select-option.selected {
			background: #1890ff;
			color: white;
		}

		.select-option.disabled {
			color: #666;
		}
	}
</style>
