<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import type { GitConflictFile } from '$shared/types/git';

	interface Props {
		isOpen: boolean;
		conflictFiles: GitConflictFile[];
		isLoading: boolean;
		onResolve: (filePath: string, resolution: 'ours' | 'theirs' | 'custom', customContent?: string) => void;
		onResolveWithAI: (filePath: string) => void;
		onAbortMerge: () => void;
		onClose: () => void;
	}

	const { isOpen, conflictFiles, isLoading, onResolve, onResolveWithAI, onAbortMerge, onClose }: Props = $props();

	let selectedFile = $state<GitConflictFile | null>(null);

	$effect(() => {
		if (conflictFiles.length > 0 && !selectedFile) {
			selectedFile = conflictFiles[0];
		}
	});
</script>

{#if isOpen}
	<div class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onclick={onClose}>
		<div
			class="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[85vh] flex flex-col"
			onclick={(e) => e.stopPropagation()}
		>
			<!-- Header -->
			<div class="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
				<div class="flex items-center gap-2">
					<Icon name="lucide:triangle-alert" class="w-4 h-4 text-orange-500" />
					<h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">
						Merge Conflicts ({conflictFiles.length} files)
					</h3>
				</div>
				<div class="flex items-center gap-2">
					<button
						type="button"
						class="px-3 py-1.5 text-xs font-medium text-red-600 bg-red-500/10 rounded-md hover:bg-red-500/20 transition-colors cursor-pointer border-none"
						onclick={onAbortMerge}
					>
						Abort Merge
					</button>
					<button
						type="button"
						class="flex items-center justify-center w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer bg-transparent border-none"
						onclick={onClose}
					>
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
				</div>
			</div>

			{#if isLoading}
				<div class="flex-1 flex items-center justify-center py-12">
					<div class="w-6 h-6 border-2 border-slate-200 dark:border-slate-700 border-t-violet-600 rounded-full animate-spin"></div>
				</div>
			{:else}
				<div class="flex flex-1 overflow-hidden">
					<!-- File list sidebar -->
					<div class="w-48 border-r border-slate-200 dark:border-slate-700 overflow-y-auto shrink-0">
						{#each conflictFiles as file (file.path)}
							<button
								type="button"
								class="flex items-center gap-1.5 w-full px-3 py-2 text-left text-xs bg-transparent border-none cursor-pointer transition-colors
									{selectedFile?.path === file.path
										? 'bg-violet-500/10 text-violet-600 font-medium'
										: 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'}"
								onclick={() => selectedFile = file}
							>
								<Icon name="lucide:file-warning" class="w-3.5 h-3.5 text-orange-500 shrink-0" />
								<span class="truncate">{file.path.split(/[\\/]/).pop()}</span>
							</button>
						{/each}
					</div>

					<!-- Conflict content -->
					<div class="flex-1 flex flex-col overflow-hidden">
						{#if selectedFile}
							<!-- File path -->
							<div class="px-4 py-2 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-400">
								{selectedFile.path}
							</div>

							<!-- Conflict markers -->
							<div class="flex-1 overflow-y-auto">
								{#each selectedFile.markers as marker, markerIndex}
									<div class="border-b border-slate-200 dark:border-slate-700">
										<!-- Conflict header -->
										<div class="flex items-center gap-2 px-4 py-1.5 bg-orange-500/5 text-3xs font-medium text-orange-600 dark:text-orange-400">
											<Icon name="lucide:triangle-alert" class="w-3 h-3" />
											Conflict #{markerIndex + 1}
										</div>

										<div class="flex">
											<!-- Ours (current) -->
											<div class="w-1/2 border-r border-slate-200 dark:border-slate-700">
												<div class="px-3 py-1 bg-emerald-500/10 text-3xs font-semibold text-emerald-600 dark:text-emerald-400 border-b border-emerald-500/10">
													Current (Ours)
												</div>
												<pre class="px-3 py-2 text-2xs font-mono text-slate-700 dark:text-slate-300 whitespace-pre-wrap bg-emerald-500/5">{marker.ourContent}</pre>
											</div>
											<!-- Theirs (incoming) -->
											<div class="w-1/2">
												<div class="px-3 py-1 bg-blue-500/10 text-3xs font-semibold text-blue-600 dark:text-blue-400 border-b border-blue-500/10">
													Incoming (Theirs)
												</div>
												<pre class="px-3 py-2 text-2xs font-mono text-slate-700 dark:text-slate-300 whitespace-pre-wrap bg-blue-500/5">{marker.theirContent}</pre>
											</div>
										</div>
									</div>
								{/each}
							</div>

							<!-- Resolution actions -->
							<div class="flex items-center gap-2 px-4 py-3 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-700">
								<button
									type="button"
									class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-600 text-white rounded-md hover:bg-emerald-700 transition-colors cursor-pointer border-none"
									onclick={() => selectedFile && onResolve(selectedFile.path, 'ours')}
								>
									<Icon name="lucide:check" class="w-3.5 h-3.5" />
									Accept Ours
								</button>
								<button
									type="button"
									class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors cursor-pointer border-none"
									onclick={() => selectedFile && onResolve(selectedFile.path, 'theirs')}
								>
									<Icon name="lucide:check" class="w-3.5 h-3.5" />
									Accept Theirs
								</button>
								<div class="flex-1"></div>
								<button
									type="button"
									class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-violet-600 text-white rounded-md hover:bg-violet-700 transition-colors cursor-pointer border-none"
									onclick={() => selectedFile && onResolveWithAI(selectedFile.path)}
									title="Send conflict to AI chat for resolution"
								>
									<Icon name="lucide:bot" class="w-3.5 h-3.5" />
									Resolve with AI
								</button>
							</div>
						{:else}
							<div class="flex-1 flex items-center justify-center text-slate-500 text-xs">
								Select a file to view conflicts
							</div>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	</div>
{/if}
