<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		dbSnippetsState,
		createSnippet,
		updateSnippet,
		closeForm
	} from '$frontend/stores/features/db-sql-snippets.svelte';
	import { dbManagerState } from '$frontend/stores/features/db-manager.svelte';
	import MonacoEditor from '$frontend/components/common/editor/MonacoEditor.svelte';

	const isEditing = $derived(!!dbSnippetsState.editSnippet);

	// Form state
	let title = $state('');
	let description = $state('');
	let sql = $state('');
	let tagInput = $state('');
	let tags = $state<string[]>([]);
	let isPublic = $state(false);
	let isSaving = $state(false);

	// Populate form when the modal opens or editSnippet changes
	$effect(() => {
		const s = dbSnippetsState.editSnippet;
		if (s) {
			title = s.title;
			description = s.description;
			sql = s.sql;
			tags = [...s.tags];
			isPublic = s.isPublic;
		} else {
			// Pre-fill sql from the main editor if creating new
			title = '';
			description = '';
			sql = dbManagerState.currentSql ?? '';
			tags = [];
			isPublic = false;
		}
	});

	function addTag() {
		const tag = tagInput.trim();
		if (tag && !tags.includes(tag)) tags = [...tags, tag];
		tagInput = '';
	}

	function removeTag(tag: string) {
		tags = tags.filter((t) => t !== tag);
	}

	function handleTagKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			addTag();
		}
	}

	async function handleSubmit() {
		if (!title.trim() || !sql.trim()) return;
		isSaving = true;
		try {
			let ok: boolean;
			if (isEditing && dbSnippetsState.editSnippet) {
				ok = await updateSnippet({
					id: dbSnippetsState.editSnippet.id,
					title: title.trim(),
					description: description.trim(),
					sql: sql.trim(),
					tags,
					isPublic
				});
			} else {
				ok = await createSnippet({
					title: title.trim(),
					description: description.trim(),
					sql: sql.trim(),
					tags,
					isPublic
				});
			}
			if (ok) closeForm();
		} finally {
			isSaving = false;
		}
	}
</script>

{#if dbSnippetsState.isFormOpen}
	<!-- Backdrop -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
		role="none"
		onclick={closeForm}
	>
		<div
			class="relative flex flex-col w-full max-w-2xl max-h-[90vh] rounded-xl bg-white dark:bg-slate-900 shadow-2xl overflow-hidden"
			role="dialog"
			aria-modal="true"
			onclick={(e) => e.stopPropagation()}
			onkeydown={undefined}
		>
			<!-- Header -->
			<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
				<div class="flex items-center gap-2">
					<Icon name="lucide:bookmark-plus" class="w-4 h-4 text-violet-500" />
					<h2 class="text-sm font-semibold text-slate-800 dark:text-slate-100">
						{isEditing ? 'Edit Snippet' : 'Save SQL Snippet'}
					</h2>
				</div>
				<button
					type="button"
					class="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
					onclick={closeForm}
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</div>

			<!-- Body -->
			<div class="flex flex-col gap-4 px-5 py-4 overflow-y-auto flex-1 min-h-0">
				<!-- Title -->
				<div class="flex flex-col gap-1">
					<label class="text-xs font-medium text-slate-600 dark:text-slate-400" for="snippet-title">
						Title <span class="text-red-500">*</span>
					</label>
					<input
						id="snippet-title"
						type="text"
						bind:value={title}
						placeholder="e.g. Monthly active users"
						class="px-3 py-2 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
					/>
				</div>

				<!-- Description -->
				<div class="flex flex-col gap-1">
					<label class="text-xs font-medium text-slate-600 dark:text-slate-400" for="snippet-desc">
						Description
					</label>
					<input
						id="snippet-desc"
						type="text"
						bind:value={description}
						placeholder="What does this snippet do?"
						class="px-3 py-2 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
					/>
				</div>

				<!-- SQL Editor -->
				<div class="flex flex-col gap-1">
					<label class="text-xs font-medium text-slate-600 dark:text-slate-400">
						SQL <span class="text-red-500">*</span>
					</label>
					<div class="h-40 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
						<MonacoEditor
							bind:value={sql}
							language="sql"
							height="100%"
							options={{
								lineNumbers: 'off',
								minimap: { enabled: false },
								scrollBeyondLastLine: false,
								padding: { top: 6, bottom: 6 },
								fontSize: 12
							}}
						/>
					</div>
				</div>

				<!-- Tags -->
				<div class="flex flex-col gap-1">
					<label class="text-xs font-medium text-slate-600 dark:text-slate-400" for="snippet-tags">
						Tags
					</label>
					<div class="flex flex-wrap gap-1.5 p-2 min-h-[2.5rem] bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg">
						{#each tags as tag}
							<span class="flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 text-xs font-medium">
								{tag}
								<button
									type="button"
									class="hover:text-red-500 transition-colors"
									onclick={() => removeTag(tag)}
									aria-label="Remove tag {tag}"
								>
									<Icon name="lucide:x" class="w-2.5 h-2.5" />
								</button>
							</span>
						{/each}
						<input
							id="snippet-tags"
							type="text"
							bind:value={tagInput}
							onkeydown={handleTagKeydown}
							onblur={addTag}
							placeholder={tags.length === 0 ? 'Add tags (comma or Enter)…' : ''}
							class="flex-1 min-w-[120px] text-xs bg-transparent text-slate-700 dark:text-slate-300 placeholder-slate-400 focus:outline-none"
						/>
					</div>
				</div>

				<!-- Visibility -->
				<label class="flex items-center gap-3 cursor-pointer select-none">
					<div class="relative">
						<input
							type="checkbox"
							class="sr-only"
							bind:checked={isPublic}
						/>
						<div class="w-9 h-5 rounded-full transition-colors {isPublic ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-600'}"></div>
						<div class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform {isPublic ? 'translate-x-4' : 'translate-x-0'}"></div>
					</div>
					<div>
						<p class="text-xs font-medium text-slate-700 dark:text-slate-300">Share with team</p>
						<p class="text-xs text-slate-400 dark:text-slate-500">All team members can see and use this snippet</p>
					</div>
				</label>
			</div>

			<!-- Footer -->
			<div class="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-800 shrink-0 bg-slate-50 dark:bg-slate-900/50">
				<button
					type="button"
					class="px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
					onclick={closeForm}
				>
					Cancel
				</button>
				<button
					type="button"
					class="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
					onclick={handleSubmit}
					disabled={isSaving || !title.trim() || !sql.trim()}
				>
					{#if isSaving}
						<svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
						Saving…
					{:else}
						<Icon name="lucide:save" class="w-3 h-3" />
						{isEditing ? 'Update Snippet' : 'Save Snippet'}
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}
