<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Lightbox from '$frontend/components/common/overlay/Lightbox.svelte';
	import type { FileAttachment } from '../composables/use-file-handling.svelte';

	interface Props {
		attachedFiles: FileAttachment[];
		onRemove: (id: string) => void;
	}

	const { attachedFiles, onRemove }: Props = $props();

	// Open an attachment before sending it — the same viewer a sent message uses.
	// The viewer stays mounted and keeps its last content after closing: its
	// open/close animation only plays when it is already on the page and still
	// has something to show while it fades out.
	let lightboxOpen = $state(false);
	let preview = $state<{ type: 'image' | 'document'; mediaType: string; data: string; fileName: string }>({
		type: 'image',
		mediaType: '',
		data: '',
		fileName: ''
	});

	function openPreview(attachment: FileAttachment) {
		if (!attachment.base64) return;
		preview = {
			type: attachment.type === 'image' ? 'image' : 'document',
			mediaType: attachment.file.type,
			data: attachment.base64,
			fileName: attachment.file.name
		};
		lightboxOpen = true;
	}

	function closePreview() {
		lightboxOpen = false;
	}
</script>

{#if attachedFiles.length > 0}
	<div class="mb-2 p-2 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
		<div class="flex flex-wrap gap-2">
			{#each attachedFiles as attachment (attachment.id)}
				<div class="relative group">
					<div class="flex items-center gap-2 pl-1.5 pr-3 py-1.5 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700">
						<button
							type="button"
							onclick={() => openPreview(attachment)}
							disabled={!attachment.base64}
							class="flex items-center gap-2 min-w-0 rounded-md px-1.5 py-0.5 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:cursor-default disabled:hover:bg-transparent"
							title="Preview {attachment.file.name}"
							aria-label="Preview {attachment.file.name}"
						>
							{#if attachment.type === 'image' && attachment.previewUrl}
								<img
									src={attachment.previewUrl}
									alt={attachment.file.name}
									class="w-8 h-8 object-cover rounded"
								/>
							{:else if attachment.type === 'pdf' || attachment.file.type === 'application/pdf'}
								<Icon name="lucide:file-text" class="w-4 h-4 text-slate-500" />
							{:else if attachment.type === 'audio'}
								<Icon name="lucide:audio-lines" class="w-4 h-4 text-slate-500" />
							{:else if attachment.type === 'video'}
								<Icon name="lucide:video" class="w-4 h-4 text-slate-500" />
							{:else}
								<Icon name="lucide:file" class="w-4 h-4 text-slate-500" />
							{/if}
							<span class="text-sm text-slate-700 dark:text-slate-300 max-w-37.5 truncate">
								{attachment.file.name}
							</span>
							<span class="text-xs text-slate-500 dark:text-slate-400">
								({(attachment.file.size / 1024).toFixed(1)}KB)
							</span>
						</button>
						<button
							type="button"
							onclick={() => onRemove(attachment.id)}
							class="-my-1 -mr-1.5 flex items-center justify-center w-7 h-7 [@media(pointer:coarse)]:w-9 [@media(pointer:coarse)]:h-9 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
							title="Remove"
							aria-label="Remove {attachment.file.name}"
						>
							<Icon name="lucide:x" class="w-3.5 h-3.5 text-slate-500" />
						</button>
					</div>
				</div>
			{/each}
		</div>
	</div>
{/if}

<Lightbox
	bind:isOpen={lightboxOpen}
	type={preview.type}
	mediaType={preview.mediaType}
	data={preview.data}
	fileName={preview.fileName}
	onClose={closePreview}
/>
