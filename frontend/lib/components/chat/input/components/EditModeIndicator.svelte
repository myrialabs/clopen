<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import { editModeState } from '$frontend/lib/stores/ui/edit-mode.svelte';

	interface Props {
		onCancel: () => void;
	}

	const { onCancel }: Props = $props();
</script>

{#if editModeState.isEditing}
	<div class="px-4 py-2 bg-amber-50 dark:bg-amber-900/20 border-b border-slate-200 dark:border-slate-600">
		<div class="flex items-center justify-between">
			<div class="flex flex-col gap-1">
				<div class="flex items-center gap-2">
					<Icon name="lucide:pencil" class="w-4 h-4 text-amber-600 dark:text-amber-400" />
					<span class="text-sm text-amber-700 dark:text-amber-300 font-medium">
						Editing message
					</span>
				</div>
			</div>
			<button
				onclick={onCancel}
				class="px-2 py-1 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-800/40 rounded-md text-sm font-medium transition-colors flex items-center gap-1 flex-shrink-0"
				aria-label="Cancel edit"
			>
				<Icon name="lucide:x" class="w-3.5 h-3.5" />
				Cancel
			</button>
		</div>
	</div>
{/if}
