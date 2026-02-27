<script lang="ts">
	import type { BrowserContextMenuInfo, BrowserContextMenuItem } from '$frontend/lib/types/native-ui';
	import { onMount } from 'svelte';

	let {
		menuInfo = $bindable<BrowserContextMenuInfo | null>(null),
		onSelectItem = $bindable<(itemId: string) => void>(() => {}),
		onClose = $bindable<() => void>(() => {})
	} = $props();

	let menuElement = $state<HTMLDivElement | undefined>(undefined);
	let highlightedItemId = $state<string | null>(null);

	// Position the context menu
	function getMenuPosition() {
		if (!menuInfo) return { top: '0px', left: '0px' };

		let x = menuInfo.x;
		let y = menuInfo.y;

		// Adjust if menu would go off screen
		if (menuElement) {
			const menuRect = menuElement.getBoundingClientRect();
			const windowWidth = window.innerWidth;
			const windowHeight = window.innerHeight;

			if (x + menuRect.width > windowWidth) {
				x = windowWidth - menuRect.width - 10;
			}

			if (y + menuRect.height > windowHeight) {
				y = windowHeight - menuRect.height - 10;
			}
		}

		return {
			top: `${y}px`,
			left: `${x}px`
		};
	}

	// Handle item click
	function handleItemClick(item: BrowserContextMenuItem) {
		if (!item.enabled || item.type === 'separator') return;
		onSelectItem(item.id);
		onClose();
	}

	// Handle keyboard navigation
	function handleKeydown(event: KeyboardEvent) {
		if (!menuInfo) return;

		const enabledItems = menuInfo.items.filter(
			(item: BrowserContextMenuItem) => item.enabled && item.type !== 'separator'
		);

		switch (event.key) {
			case 'ArrowDown': {
				event.preventDefault();
				const currentIndex = enabledItems.findIndex((item: BrowserContextMenuItem) => item.id === highlightedItemId);
				const nextIndex = (currentIndex + 1) % enabledItems.length;
				highlightedItemId = enabledItems[nextIndex]?.id || null;
				break;
			}

			case 'ArrowUp': {
				event.preventDefault();
				const currentIndex = enabledItems.findIndex((item: BrowserContextMenuItem) => item.id === highlightedItemId);
				const prevIndex = currentIndex <= 0 ? enabledItems.length - 1 : currentIndex - 1;
				highlightedItemId = enabledItems[prevIndex]?.id || null;
				break;
			}

			case 'Enter': {
				event.preventDefault();
				const item = enabledItems.find((item: BrowserContextMenuItem) => item.id === highlightedItemId);
				if (item) {
					handleItemClick(item);
				}
				break;
			}

			case 'Escape':
				event.preventDefault();
				onClose();
				break;
		}
	}

	// Handle click outside to close
	function handleClickOutside(event: MouseEvent) {
		if (menuElement && !menuElement.contains(event.target as Node)) {
			onClose();
		}
	}

	// Initialize
	$effect(() => {
		if (menuInfo) {
			// Focus menu for keyboard navigation
			if (menuElement) {
				menuElement.focus();
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

	const position = $derived(getMenuPosition());
</script>

{#if menuInfo}
	<div
		bind:this={menuElement}
		class="browser-context-menu"
		style="top: {position.top}; left: {position.left};"
		tabindex="-1"
		onkeydown={handleKeydown}
		role="menu"
		aria-label="Context menu"
	>
		{#each menuInfo.items as item (item.id)}
			{#if item.type === 'separator'}
				<div class="context-menu-separator" role="separator"></div>
			{:else}
				<div
					class="context-menu-item"
					class:disabled={!item.enabled}
					class:highlighted={item.id === highlightedItemId}
					role="menuitem"
					tabindex={item.enabled ? 0 : -1}
					aria-disabled={!item.enabled}
					onclick={() => handleItemClick(item)}
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							handleItemClick(item);
						}
					}}
					onmouseenter={() => {
						if (item.enabled) highlightedItemId = item.id;
					}}
				>
					<span class="menu-item-label">{item.label}</span>
				</div>
			{/if}
		{/each}
	</div>
{/if}

<style>
	.browser-context-menu {
		position: fixed;
		z-index: 999999;
		min-width: 200px;
		background: white;
		border: 1px solid #ccc;
		border-radius: 4px;
		box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2);
		padding: 4px 0;
		outline: none;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
	}

	.context-menu-item {
		padding: 8px 24px 8px 16px;
		cursor: pointer;
		user-select: none;
		font-size: 14px;
		line-height: 1.5;
		color: #333;
		display: flex;
		align-items: center;
		transition: background-color 0.1s ease;
	}

	.context-menu-item:hover:not(.disabled) {
		background: #f0f0f0;
	}

	.context-menu-item.highlighted:not(.disabled) {
		background: #e6f7ff;
	}

	.context-menu-item.disabled {
		color: #999;
		cursor: not-allowed;
		opacity: 0.5;
	}

	.context-menu-separator {
		height: 1px;
		background: #e0e0e0;
		margin: 4px 0;
	}

	.menu-item-label {
		flex: 1;
	}

	/* Dark mode support */
	@media (prefers-color-scheme: dark) {
		.browser-context-menu {
			background: #2d2d2d;
			border-color: #444;
			box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
		}

		.context-menu-item {
			color: #e0e0e0;
		}

		.context-menu-item:hover:not(.disabled) {
			background: #3a3a3a;
		}

		.context-menu-item.highlighted:not(.disabled) {
			background: #003d66;
		}

		.context-menu-item.disabled {
			color: #666;
		}

		.context-menu-separator {
			background: #444;
		}
	}
</style>
