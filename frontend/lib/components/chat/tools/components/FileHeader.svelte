<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import { getFileIcon } from '$frontend/lib/utils/file-icon-mappings';
	import { formatPath } from '../../shared/utils';

	interface Props {
		filePath: string;
		fileName?: string;
		iconColor?: string;
		badges?: Array<{ text: string; color: string }>;
		box?: boolean;
	}

	const { filePath, fileName, iconColor, badges = [], box = true }: Props = $props();

	const displayFileName = fileName || filePath.split(/[/\\]/).pop() || filePath;
</script>

<div class={box ? "bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3" : ""}>
	<div class="flex items-center gap-3 mb-1">
		<Icon 
			name={getFileIcon(displayFileName)} 
			class="w-6 h-6 {iconColor || ''}" 
		/>
		<div class="flex-1 min-w-0">
			<h3 class="font-medium text-slate-900 dark:text-slate-100 truncate">
				{displayFileName}
			</h3>
			<p class="text-xs text-slate-600 dark:text-slate-400 truncate" title={filePath}>
				{formatPath(filePath)}
			</p>
		</div>
	</div>
	
	{#if badges.length > 0}
		<div class="flex gap-2 mt-3">
			{#each badges as badge}
				<div class="text-xs px-2 py-1 rounded {badge.color}">
					{badge.text}
				</div>
			{/each}
		</div>
	{/if}
</div>
