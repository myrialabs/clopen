<script lang="ts">
	import { systemSettings, updateSystemSettings } from '$frontend/stores/features/settings.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import Icon from '../../common/display/Icon.svelte';
	import Dialog from '../../common/overlay/Dialog.svelte';
	import { detectPlatform } from '$frontend/utils/platform';

	const isAdmin = $derived(authStore.isAdmin);
	const settings = $derived(systemSettings);

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
			updateSystemSettings({ allowedBasePaths: [...settings.allowedBasePaths, path] });
		}
		newPathValue = '';
		showAddPathDialog = false;
	}

	function removePath(index: number) {
		const newPaths = [...settings.allowedBasePaths];
		newPaths.splice(index, 1);
		updateSystemSettings({ allowedBasePaths: newPaths });
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
			updateSystemSettings({ allowedBasePaths: newPaths });
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

	// Draft input for the max file size limit so the user can type freely before saving.
	// State is initialized to defaults and synced from `settings` via `$effect` because
	// `settings` is itself a `$derived` — referencing it directly in an initializer would
	// only capture its initial value.
	let maxFileSizeDraft = $state<string>('500');
	let lastSyncedMaxFileSize = $state<number>(500);
	$effect(() => {
		const current = settings.maxFileSizeMB ?? 500;
		if (current !== lastSyncedMaxFileSize) {
			lastSyncedMaxFileSize = current;
			maxFileSizeDraft = String(current);
		}
	});

	const maxFileSizeError = $derived.by(() => {
		const trimmed = maxFileSizeDraft.trim();
		if (trimmed === '') return 'Enter a value in megabytes.';
		const parsed = Number(trimmed);
		if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return 'Enter a whole number.';
		if (parsed < 1) return 'Must be at least 1 MB.';
		if (parsed > 102400) return 'Must be 102400 MB (100 GB) or less.';
		return '';
	});
	const maxFileSizeDirty = $derived(
		!maxFileSizeError && Number(maxFileSizeDraft.trim()) !== lastSyncedMaxFileSize
	);

	function saveMaxFileSize() {
		if (maxFileSizeError || !maxFileSizeDirty) return;
		const next = Number(maxFileSizeDraft.trim());
		updateSystemSettings({ maxFileSizeMB: next });
	}

	function handleMaxFileSizeKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			saveMaxFileSize();
		}
	}
</script>

{#if isAdmin}
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

		<!-- Maximum file size for write/upload/zip/extract -->
		<div class="p-4 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
			<div class="flex items-start gap-3.5 mb-4">
				<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-violet-400/15 text-violet-500">
					<Icon name="lucide:hard-drive-upload" class="w-5 h-5" />
				</div>
				<div class="flex flex-col gap-0.5 min-w-0 flex-1">
					<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">
						Maximum File Size
					</div>
					<div class="text-xs text-slate-600 dark:text-slate-500">
						Upper bound (in megabytes) for file writes, uploads, ZIP archives, and extracted contents.
					</div>
				</div>
			</div>

			<div class="flex flex-col gap-1.5">
				<div class="flex items-center gap-2">
					<input
						type="text"
						inputmode="numeric"
						pattern="[0-9]*"
						bind:value={maxFileSizeDraft}
						onkeydown={handleMaxFileSizeKeydown}
						class="w-32 font-mono text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md px-2 py-1.5 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-violet-500/30 focus:border-violet-400 dark:focus:border-violet-500"
					/>
					<span class="text-xs text-slate-600 dark:text-slate-400">MB</span>
					<button
						type="button"
						onclick={saveMaxFileSize}
						disabled={!!maxFileSizeError || !maxFileSizeDirty}
						class="inline-flex items-center gap-1.5 py-1.5 px-3 bg-violet-500/10 border border-violet-500/20 rounded-md text-violet-600 dark:text-violet-400 text-xs font-semibold cursor-pointer transition-all duration-150 hover:bg-violet-500/20 hover:border-violet-600/40 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-violet-500/10 disabled:hover:border-violet-500/20"
					>
						<Icon name="lucide:check" class="w-3.5 h-3.5" />
						Save
					</button>
				</div>
				{#if maxFileSizeError}
					<span class="text-xs text-red-500 dark:text-red-400">{maxFileSizeError}</span>
				{/if}
			</div>
		</div>
	</div>
</div>
{/if}

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
