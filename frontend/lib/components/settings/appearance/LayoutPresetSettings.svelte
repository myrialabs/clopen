<script lang="ts">
	import Icon from '../../common/Icon.svelte';
	import LayoutPreview from './LayoutPreview.svelte';
	import { builtInPresets } from '$frontend/lib/stores/ui/workspace.svelte';
	import { settings, updateSettings } from '$frontend/lib/stores/features/settings.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	// Group presets by category
	const presetCategories = [
		{
			name: 'Single Panel Focus',
			description: 'Full screen layouts for maximum focus',
			icon: 'lucide:maximize-2',
			presets: builtInPresets.slice(0, 5)
		},
		{
			name: 'Two Panel Layouts',
			description: 'Dual focus workflows',
			icon: 'lucide:columns-2',
			presets: builtInPresets.slice(5, 13)
		},
		{
			name: 'Three Panel Layouts',
			description: 'Balanced multi-panel setups',
			icon: 'lucide:columns-3',
			presets: builtInPresets.slice(13, 22)
		},
		{
			name: 'Four Panel Layouts',
			description: 'All panels visible',
			icon: 'lucide:layout-grid',
			presets: builtInPresets.slice(22, 26)
		},
		{
			name: 'Five Panel Layouts',
			description: 'Full workspace with source control',
			icon: 'lucide:layout-dashboard',
			presets: builtInPresets.slice(26, 28)
		}
	];

	function togglePresetVisibility(presetId: string) {
		const newVisibility = {
			...settings.layoutPresetVisibility,
			[presetId]: !settings.layoutPresetVisibility[presetId]
		};
		updateSettings({ layoutPresetVisibility: newVisibility });
	}

	function toggleCategoryVisibility(categoryPresets: typeof builtInPresets) {
		const allVisible = categoryPresets.every(
			(preset) => settings.layoutPresetVisibility[preset.id]
		);
		const newVisibility = { ...settings.layoutPresetVisibility };
		categoryPresets.forEach((preset) => {
			newVisibility[preset.id] = !allVisible;
		});
		updateSettings({ layoutPresetVisibility: newVisibility });
	}

	function isVisible(presetId: string): boolean {
		return settings.layoutPresetVisibility[presetId] ?? true;
	}

	function isCategoryAllVisible(categoryPresets: typeof builtInPresets): boolean {
		return categoryPresets.every((preset) => isVisible(preset.id));
	}

	function isCategorySomeVisible(categoryPresets: typeof builtInPresets): boolean {
		return (
			categoryPresets.some((preset) => isVisible(preset.id)) &&
			!isCategoryAllVisible(categoryPresets)
		);
	}
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Layout Presets</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">
		Customize which layout presets appear in the View menu
	</p>

	<div class="flex flex-col gap-4">
		{#each presetCategories as category}
			<div
				class="bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden transition-all duration-150 hover:border-violet-500/20"
			>
				<!-- Category Header -->
				<div class="flex items-center justify-between w-full p-4 bg-transparent border-none text-left">
					<div class="flex items-center gap-3.5">
						<div
							class="flex items-center justify-center w-10 h-10 bg-violet-500/10 dark:bg-violet-500/15 rounded-lg text-violet-600 dark:text-violet-400"
						>
							<Icon name={category.icon as IconName} class="w-5 h-5" />
						</div>
						<div class="flex flex-col gap-0.5">
							<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">{category.name}</div>
							<div class="text-xs text-slate-600 dark:text-slate-500">{category.description}</div>
						</div>
					</div>
					<label class="relative inline-block w-12 h-6.5 shrink-0">
						<input
							type="checkbox"
							checked={isCategoryAllVisible(category.presets)}
							indeterminate={isCategorySomeVisible(category.presets)}
							onchange={(e) => {
								e.stopPropagation();
								toggleCategoryVisibility(category.presets);
							}}
							class="opacity-0 w-0 h-0"
						/>
						<span
							class="absolute cursor-pointer inset-0 bg-slate-600/40 rounded-3xl transition-all duration-200
							before:absolute before:content-[''] before:h-5 before:w-5 before:left-0.75 before:bottom-0.75 before:bg-white before:rounded-full before:transition-all before:duration-200
							{isCategoryAllVisible(category.presets)
								? 'bg-gradient-to-br from-violet-600 to-purple-600 before:translate-x-5.5'
								: isCategorySomeVisible(category.presets)
									? 'bg-violet-500/50 before:translate-x-2.75'
									: ''}"
						></span>
					</label>
				</div>

				<!-- Individual Presets - 2 Column Grid -->
				<div class="px-4 pb-3 grid grid-cols-2 gap-2">
					{#each category.presets as preset}
						<div
							class="flex flex-col gap-2 py-2.5 px-3 bg-white/60 dark:bg-slate-900/40 rounded-lg border border-violet-500/5"
						>
							<div class="flex items-center justify-between gap-2">
								<span class="text-sm font-medium text-slate-900 dark:text-slate-100"
									>{preset.name}</span
								>
								<label class="relative inline-block w-10 h-5.5 shrink-0">
									<input
										type="checkbox"
										checked={isVisible(preset.id)}
										onchange={() => togglePresetVisibility(preset.id)}
										class="opacity-0 w-0 h-0"
									/>
									<span
										class="absolute cursor-pointer inset-0 bg-slate-600/40 rounded-3xl transition-all duration-200
										before:absolute before:content-[''] before:h-4 before:w-4 before:left-0.5 before:bottom-0.75 before:bg-white before:rounded-full before:transition-all before:duration-200
										{isVisible(preset.id)
											? 'bg-gradient-to-br from-violet-600 to-purple-600 before:translate-x-4.5'
											: ''}"
									></span>
								</label>
							</div>
							<!-- Visual Preview -->
							<div class="w-full">
								<LayoutPreview layout={preset.layout} size="small" />
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/each}
	</div>
</div>
