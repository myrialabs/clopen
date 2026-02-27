<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import LayoutPreview from '$frontend/lib/components/settings/appearance/LayoutPreview.svelte';
	import {
		workspaceState,
		builtInPresets,
		applyLayoutPreset,
		type LayoutPreset
	} from '$frontend/lib/stores/ui/workspace.svelte';
	import { settings } from '$frontend/lib/stores/features/settings.svelte';
	import { clickOutside } from '$frontend/lib/utils/click-outside';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		collapsed?: boolean;
	}

	const { collapsed = false }: Props = $props();

	let isOpen = $state(false);

	const isCollapsed = $derived(collapsed || workspaceState.navigatorCollapsed);

	// Group presets by category
	const presetCategories = [
		{
			name: 'Single Panel',
			presets: builtInPresets.slice(0, 5)
		},
		{
			name: 'Two Panels',
			presets: builtInPresets.slice(5, 13)
		},
		{
			name: 'Three Panels',
			presets: builtInPresets.slice(13, 22)
		},
		{
			name: 'Four Panels',
			presets: builtInPresets.slice(22, 26)
		},
		{
			name: 'Five Panels',
			presets: builtInPresets.slice(26, 28)
		}
	];

	// Filter visible presets and categories
	const visibleCategories = $derived(
		presetCategories
			.map((category) => ({
				...category,
				presets: category.presets.filter(
					(preset) => settings.layoutPresetVisibility[preset.id] !== false
				)
			}))
			.filter((category) => category.presets.length > 0)
	);

	function toggleMenu() {
		isOpen = !isOpen;
	}

	function handleApplyPreset(preset: LayoutPreset) {
		applyLayoutPreset(preset);
		isOpen = false;
	}

	function handleClickOutside() {
		isOpen = false;
	}
</script>

<div class="relative" use:clickOutside={handleClickOutside}>
	{#if isCollapsed}
		<!-- Collapsed: Icon Only -->
		<button
			type="button"
			class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100
				{isOpen ? 'bg-violet-500/10 text-slate-900 dark:text-slate-100' : ''}"
			onclick={toggleMenu}
			aria-label="Layout Presets"
			aria-expanded={isOpen}
			title="Layout Presets"
		>
			<Icon name="lucide:layout-grid" class="w-5 h-5" />
		</button>
	{:else}
		<!-- Expanded: Full Width -->
		<button
			type="button"
			class="flex items-center gap-2.5 w-full py-2.5 px-3 bg-transparent border-none rounded-lg text-slate-500 text-sm cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100
				{isOpen ? 'bg-violet-500/10 text-slate-900 dark:text-slate-100' : ''}"
			onclick={toggleMenu}
			aria-label="Layout Presets"
			aria-expanded={isOpen}
		>
			<Icon name="lucide:layout-grid" class="w-4 h-4" />
			<span class="flex-1 text-left">Layout Presets</span>
		</button>
	{/if}

	{#if isOpen}
		<div
			class="absolute bottom-full left-0 mb-1 w-[280px] bg-white dark:bg-slate-800 border border-violet-500/20 rounded-lg shadow-2xl shadow-slate-900/20 dark:shadow-black/40 z-50 overflow-hidden"
			transition:scale={{ duration: 150, easing: cubicOut, start: 0.95, opacity: 0 }}
		>
			<div class="py-1.5 max-h-[32rem] overflow-y-auto">
				<!-- Layout Presets Header -->
				<div
					class="px-3 py-1.5 text-xs font-semibold text-slate-600 dark:text-slate-500 uppercase tracking-wider"
				>
					Layout Presets
				</div>

				<!-- Categories -->
				{#each visibleCategories as category, categoryIndex}
					<!-- Category Name -->
					<div
						class="px-3 py-1.5 mt-2 text-xs font-medium text-violet-600 dark:text-violet-400 uppercase tracking-wide"
					>
						{category.name}
					</div>

					<!-- Presets in Category - 2 Column Grid -->
					<div class="grid grid-cols-2 gap-2 px-3">
						{#each category.presets as preset}
							<button
								type="button"
								class="flex items-center p-2.5 bg-transparent border border-slate-200 dark:border-slate-800 rounded-lg text-slate-700 dark:text-slate-300 text-sm text-left cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:border-violet-500/20 {workspaceState.activePresetId ===
								preset.id
									? 'bg-violet-500/5 border-violet-500/30'
									: ''}"
								onclick={() => handleApplyPreset(preset)}
							>
								<div class="flex flex-col gap-1 flex-1 min-w-0">
									<div class="flex justify-between">
										<span class="font-medium text-xs">{preset.name}</span>
										{#if workspaceState.activePresetId === preset.id}
											<Icon name="lucide:check" class="w-3.5 h-3.5 text-violet-600 dark:text-violet-400 shrink-0" />
										{/if}
									</div>
									<!-- Visual Preview -->
									<div class="w-full">
										<LayoutPreview layout={preset.layout} size="small" />
									</div>
								</div>
							</button>
						{/each}
					</div>

					<!-- Divider (except for last category) -->
					{#if categoryIndex < visibleCategories.length - 1}
						<div class="my-2 mx-3 border-t border-slate-200 dark:border-slate-800"></div>
					{/if}
				{/each}
			</div>
		</div>
	{/if}
</div>
