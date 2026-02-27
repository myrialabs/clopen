<script lang="ts">
	import Modal from '$frontend/lib/components/common/Modal.svelte';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import GitPanel from '$frontend/lib/components/workspace/panels/GitPanel.svelte';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(), onClose }: Props = $props();

	let gitPanelRef: any = $state();
</script>

<Modal {isOpen} {onClose} size="full" className="!max-h-[85vh] !max-w-[95vw] md:!max-w-5xl">
	{#snippet header()}
		<div class="flex items-center justify-between px-4 py-3 md:px-6 md:py-4">
			<div class="flex items-center gap-2.5">
				<Icon name="lucide:git-branch" class="w-5 h-5 text-violet-600" />
				<h2 class="text-base md:text-lg font-bold text-slate-900 dark:text-slate-100">Source Control</h2>
			</div>
			<div class="flex items-center gap-1.5">
				<!-- Fetch -->
				<button
					type="button"
					class="flex items-center justify-center gap-1.5 h-8 px-2.5 bg-transparent border border-slate-200 dark:border-slate-700 rounded-lg text-slate-600 dark:text-slate-400 text-xs font-medium cursor-pointer transition-all duration-150 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={() => gitPanelRef?.panelActions?.fetch()}
					title="Fetch"
				>
					<Icon name="lucide:cloud-download" class="w-4 h-4" />
					<span class="hidden sm:inline">Fetch</span>
				</button>
				<!-- Pull -->
				<button
					type="button"
					class="flex items-center justify-center gap-1.5 h-8 px-2.5 bg-transparent border border-slate-200 dark:border-slate-700 rounded-lg text-slate-600 dark:text-slate-400 text-xs font-medium cursor-pointer transition-all duration-150 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={() => gitPanelRef?.panelActions?.pull()}
					title="Pull"
				>
					<Icon name="lucide:arrow-down-to-line" class="w-4 h-4" />
					<span class="hidden sm:inline">Pull</span>
				</button>
				<!-- Push -->
				<button
					type="button"
					class="flex items-center justify-center gap-1.5 h-8 px-2.5 bg-transparent border border-slate-200 dark:border-slate-700 rounded-lg text-slate-600 dark:text-slate-400 text-xs font-medium cursor-pointer transition-all duration-150 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={() => gitPanelRef?.panelActions?.push()}
					title="Push"
				>
					<Icon name="lucide:arrow-up-from-line" class="w-4 h-4" />
					<span class="hidden sm:inline">Push</span>
				</button>

				<!-- Close -->
				<button
					type="button"
					class="p-1.5 md:p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-violet-500/10 transition-colors"
					onclick={onClose}
					aria-label="Close modal"
				>
					<svg class="w-4 h-4 md:w-5 md:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M6 18L18 6M6 6l12 12"
						/>
					</svg>
				</button>
			</div>
		</div>
	{/snippet}

	{#snippet children()}
		<div class="h-[65vh] -mx-4 -my-6 md:-mx-6">
			<GitPanel bind:this={gitPanelRef} />
		</div>
	{/snippet}
</Modal>
