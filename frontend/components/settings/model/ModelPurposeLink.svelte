<script lang="ts">
	/**
	 * Which model a job uses, said where the job is (Git, Memory) — and a link
	 * to its row in Settings → Models, the one place a job's model is chosen.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { openModelsFor } from '$frontend/stores/ui/settings-modal.svelte';
	import { modelSummary, purposeInfo, type ModelPurposeId } from './purposes.svelte';

	interface Props {
		purpose: ModelPurposeId;
	}

	const { purpose }: Props = $props();
</script>

<p class="flex flex-wrap items-center gap-x-1.5 text-xs text-slate-600 dark:text-slate-400">
	<span>{purposeInfo(purpose).label} uses</span>
	<button
		type="button"
		class="inline-flex items-center gap-0.5 p-0 bg-transparent border-none text-xs font-medium text-violet-600 dark:text-violet-400 cursor-pointer hover:underline"
		onclick={() => openModelsFor(purpose)}
	>
		{modelSummary(purpose)}
		<Icon name="lucide:chevron-right" class="w-3 h-3" />
	</button>
</p>
