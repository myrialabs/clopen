<script lang="ts">
	import type { NoteWithImages } from '$shared/types/database/schema';
	import Icon from '$frontend/components/common/display/Icon.svelte';

	interface Props {
		notes: NoteWithImages[];
		selectedId: string | null;
		onSelect: (id: string) => void;
		onDelete: (id: string) => void;
		onCreate: () => void;
		isLoading?: boolean;
	}

	const { notes, selectedId, onSelect, onDelete, onCreate, isLoading = false }: Props = $props();

	function formatDate(iso: string): string {
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}

	function displayTitle(note: NoteWithImages): string {
		const t = note.title?.trim();
		return t ? t : 'Untitled';
	}

	function snippet(note: NoteWithImages): string {
		const text = note.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
		const first = text.split('\n')[0]?.slice(0, 80) ?? '';
		return first || (note.title?.trim() ?? '(empty)');
	}
</script>

<div class="flex flex-col h-full bg-transparent">
	<div class="flex items-center justify-between p-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
		<span class="text-sm font-semibold text-slate-700 dark:text-slate-200">Notes</span>
		<button
			type="button"
			onclick={onCreate}
			class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-violet-600 hover:bg-violet-700 text-white"
		>
			<Icon name="lucide:plus" class="w-3.5 h-3.5" />
			New
		</button>
	</div>

	<div class="flex-1 overflow-auto bg-white dark:bg-slate-900">
		{#if isLoading}
			<div class="p-6 text-center text-sm text-slate-500">Loading...</div>
		{:else if notes.length === 0}
			<div class="p-6 text-center text-sm text-slate-500 dark:text-slate-400">
				<Icon name="lucide:sticky-note" class="w-8 h-8 mx-auto mb-2 opacity-40" />
				No notes in this project
			</div>
		{:else}
			{#each notes as note (note.id)}
				<button
					type="button"
					onclick={() => onSelect(note.id)}
					class="w-full text-left px-3 py-2.5 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 {selectedId === note.id ? 'bg-violet-50 dark:bg-violet-950/30 border-l-2 border-l-violet-500' : ''}"
				>
					<div class="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{displayTitle(note)}</div>
					<div class="text-xs text-slate-500 dark:text-slate-400 truncate">{snippet(note)}</div>
					<div class="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{formatDate(note.updated_at)} {#if note.images.length > 0}· {note.images.length} images{/if}</div>
				</button>
			{/each}
		{/if}
	</div>

	{#if notes.length > 0}
		<div class="p-2 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs text-slate-400">{notes.length} {notes.length === 1 ? 'note' : 'notes'}</div>
	{/if}
</div>
