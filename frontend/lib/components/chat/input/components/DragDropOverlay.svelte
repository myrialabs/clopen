<script lang="ts">
	interface Props {
		isDragging: boolean;
		isProcessingFiles: boolean;
	}

	const { isDragging, isProcessingFiles }: Props = $props();
</script>

<!-- Drag and drop overlay -->
{#if isDragging}
	<div class="absolute inset-0 bg-violet-500/10 rounded-xl flex items-center justify-center pointer-events-none">
		<div class="bg-white dark:bg-slate-800 px-4 py-2 rounded-lg shadow-lg border border-violet-500">
			<span class="text-sm font-medium text-violet-700 dark:text-violet-300">Drop files here to attach</span>
		</div>
	</div>
{/if}

<!-- Processing files overlay -->
{#if isProcessingFiles}
	<div class="absolute top-0 left-0 right-0 -mt-10 flex justify-center">
		<div class="bg-white dark:bg-slate-800 px-3 py-1.5 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 flex items-center gap-2">
			<svg class="animate-spin h-3 w-3 text-violet-500" viewBox="0 0 24 24">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle>
				<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
			</svg>
			<span class="text-xs text-slate-600 dark:text-slate-400">Processing files...</span>
		</div>
	</div>
{/if}
