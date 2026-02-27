<script lang="ts">
	import { settings, updateSettings } from '$frontend/lib/stores/features/settings.svelte';
	import Icon from '../../common/Icon.svelte';
	import Dialog from '../../common/Dialog.svelte';
	import { detectPlatform } from '$frontend/lib/utils/platform';

	let showAddPathDialog = $state(false);
	let newPathValue = $state('');

	// Detect backend OS: prioritize existing path entries, fallback to browser platform.
	// Checking existing paths is most reliable (works correctly in WSL too).
	const isWindowsBackend = $derived(
		settings.allowedBasePaths.some(p => /^[A-Za-z]:/.test(p)) ||
		(!settings.allowedBasePaths.some(p => p.startsWith('/')) && detectPlatform() === 'windows')
	);
	const pathInputPlaceholder = $derived(
		isWindowsBackend ? 'e.g. C:\\Users\\projects' : 'e.g. /home/user/projects'
	);

	// Track which path index is being edited, and its current edit value
	let editingIndex = $state<number | null>(null);
	let editingValue = $state('');

	function openAddPathDialog() {
		newPathValue = '';
		showAddPathDialog = true;
	}

	function addPath() {
		const path = newPathValue.trim();
		if (path && !settings.allowedBasePaths.includes(path)) {
			updateSettings({ allowedBasePaths: [...settings.allowedBasePaths, path] });
		}
		newPathValue = '';
		showAddPathDialog = false;
	}

	function removePath(index: number) {
		const newPaths = [...settings.allowedBasePaths];
		newPaths.splice(index, 1);
		updateSettings({ allowedBasePaths: newPaths });
		if (editingIndex === index) {
			editingIndex = null;
			editingValue = '';
		}
	}

	function startEdit(index: number) {
		editingIndex = index;
		editingValue = settings.allowedBasePaths[index];
	}

	function saveEdit() {
		if (editingIndex === null) return;
		const path = editingValue.trim();
		if (path) {
			const newPaths = [...settings.allowedBasePaths];
			newPaths[editingIndex] = path;
			updateSettings({ allowedBasePaths: newPaths });
		}
		editingIndex = null;
		editingValue = '';
	}

	function cancelEdit() {
		editingIndex = null;
		editingValue = '';
	}

	function handleEditKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') saveEdit();
		else if (e.key === 'Escape') cancelEdit();
	}
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Advanced</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">Security and access control settings</p>

	<div class="flex flex-col gap-3.5">
		<!-- Folder Access Restriction -->
		<div class="p-4 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
			<div class="flex items-start gap-3.5 mb-4">
				<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-amber-400/15 text-amber-500">
					<Icon name="lucide:folder-lock" class="w-5 h-5" />
				</div>
				<div class="flex flex-col gap-0.5 min-w-0 flex-1">
					<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">
						Folder Access Restriction
					</div>
					<div class="text-xs text-slate-600 dark:text-slate-500">
						Restrict the <span class="font-medium text-slate-700 dark:text-slate-400">Select Project Folder</span> browser to only show specific base directories.
						This does not restrict file access in other parts of the app. Leave empty to allow browsing all directories.
					</div>
				</div>
			</div>

			<!-- Allowed paths list -->
			<div class="flex flex-col gap-2">
				{#if settings.allowedBasePaths.length === 0}
					<div class="flex items-center gap-2 px-3 py-2.5 bg-green-500/10 border border-green-500/20 rounded-lg">
						<Icon name="lucide:circle-check" class="w-4 h-4 text-green-600 dark:text-green-400 shrink-0" />
						<span class="text-xs text-green-700 dark:text-green-400">
							No restrictions — all directories can be selected as project folder
						</span>
					</div>
				{:else}
					{#each settings.allowedBasePaths as basePath, index (basePath + index)}
						<div class="flex items-center gap-2 px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg group">
							<Icon name="lucide:folder-check" class="w-4 h-4 text-violet-500 shrink-0" />

							{#if editingIndex === index}
								<!-- Edit mode -->
								<input
									type="text"
									bind:value={editingValue}
									onkeydown={handleEditKeydown}
									class="flex-1 font-mono text-xs bg-slate-50 dark:bg-slate-800 border border-violet-400 dark:border-violet-500 rounded px-2 py-1 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-violet-500/30"
								/>
								<button
									type="button"
									onclick={saveEdit}
									disabled={!editingValue.trim()}
									class="flex items-center justify-center w-6 h-6 rounded-md bg-violet-500/10 hover:bg-violet-500/20 text-violet-600 dark:text-violet-400 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
									title="Save"
								>
									<Icon name="lucide:check" class="w-3.5 h-3.5" />
								</button>
								<button
									type="button"
									onclick={cancelEdit}
									class="flex items-center justify-center w-6 h-6 rounded-md hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 transition-all"
									title="Cancel"
								>
									<Icon name="lucide:x" class="w-3.5 h-3.5" />
								</button>
							{:else}
								<!-- Display mode -->
								<span class="flex-1 font-mono text-xs text-slate-700 dark:text-slate-300 truncate">{basePath}</span>
								<button
									type="button"
									onclick={() => startEdit(index)}
									class="flex items-center justify-center w-6 h-6 rounded-md opacity-0 group-hover:opacity-100 hover:bg-violet-100 dark:hover:bg-violet-900/30 text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 transition-all"
									title="Edit path"
								>
									<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
								</button>
								<button
									type="button"
									onclick={() => removePath(index)}
									class="flex items-center justify-center w-6 h-6 rounded-md opacity-0 group-hover:opacity-100 hover:bg-red-100 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-all"
									title="Remove path"
								>
									<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
								</button>
							{/if}
						</div>
					{/each}
				{/if}

				<button
					type="button"
					onclick={openAddPathDialog}
					class="inline-flex items-center gap-1.5 py-2 px-3.5 mt-1 bg-violet-500/10 dark:bg-violet-500/10 border border-violet-500/20 dark:border-violet-500/25 rounded-lg text-violet-600 dark:text-violet-400 text-xs font-semibold cursor-pointer transition-all duration-150 hover:bg-violet-500/20 hover:border-violet-600/40 self-start"
				>
					<Icon name="lucide:folder-plus" class="w-3.5 h-3.5" />
					Add Allowed Path
				</button>
			</div>
		</div>
	</div>
</div>

<Dialog
	bind:isOpen={showAddPathDialog}
	onClose={() => { showAddPathDialog = false; newPathValue = ''; }}
	title="Add Allowed Path"
	type="info"
	message="Enter the full path to allow as a project folder. All subdirectories will also be selectable."
	bind:inputValue={newPathValue}
	inputPlaceholder={pathInputPlaceholder}
	confirmText="Add"
	cancelText="Cancel"
	showCancel={true}
	confirmDisabled={!newPathValue.trim()}
	onConfirm={addPath}
/>
