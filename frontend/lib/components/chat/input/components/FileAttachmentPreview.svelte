<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import type { FileAttachment } from '../composables/use-file-handling.svelte';

	interface Props {
		attachedFiles: FileAttachment[];
		onRemove: (id: string) => void;
	}

	const { attachedFiles, onRemove }: Props = $props();
</script>

{#if attachedFiles.length > 0}
	<div class="mb-2 p-2 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
		<div class="flex flex-wrap gap-2">
			{#each attachedFiles as attachment (attachment.id)}
				<div class="relative group">
					<div class="flex items-center gap-2 px-3 py-2 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700">
						{#if attachment.type === 'image' && attachment.previewUrl}
							<img
								src={attachment.previewUrl}
								alt={attachment.file.name}
								class="w-8 h-8 object-cover rounded"
							/>
						{:else if attachment.type === 'document'}
							<Icon name="lucide:file-text" class="w-4 h-4 text-slate-500" />
						{:else}
							<Icon name="lucide:file" class="w-4 h-4 text-slate-500" />
						{/if}
						<span class="text-sm text-slate-700 dark:text-slate-300 max-w-37.5 truncate">
							{attachment.file.name}
						</span>
						<span class="text-xs text-slate-500 dark:text-slate-400">
							({(attachment.file.size / 1024).toFixed(1)}KB)
						</span>
						<button
							onclick={() => onRemove(attachment.id)}
							class="ml-1 p-0.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors"
							aria-label="Remove attachment"
						>
							<Icon name="lucide:x" class="w-3 h-3 text-slate-500" />
						</button>
					</div>
				</div>
			{/each}
		</div>
	</div>
{/if}
