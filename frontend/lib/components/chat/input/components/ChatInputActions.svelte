<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import type { FileAttachment } from '../composables/use-file-handling.svelte';

	interface Props {
		isLoading: boolean;
		hasActiveProject: boolean;
		messageText: string;
		attachedFiles: FileAttachment[];
		isProcessingFiles: boolean;
		modelSupportsAttachments: boolean;
		onSend: () => void;
		onCancel: () => void;
		onAttachFile: () => void;
	}

	const {
		isLoading,
		hasActiveProject,
		messageText,
		attachedFiles,
		isProcessingFiles,
		modelSupportsAttachments,
		onSend,
		onCancel,
		onAttachFile
	}: Props = $props();

	const attachDisabled = $derived(
		isProcessingFiles || !hasActiveProject || !modelSupportsAttachments
	);

	const attachTitle = $derived(
		!modelSupportsAttachments
			? 'File attachments are not supported by this model'
			: 'Attach files'
	);
</script>

<div class="absolute bottom-2 right-2 flex items-center gap-1.5">
	{#if !isLoading}
		<!-- Attach file button -->
		<button
			onclick={onAttachFile}
			disabled={attachDisabled}
			class="w-8 h-8 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg flex items-center justify-center transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed group relative"
			title={attachTitle}
			aria-label={attachTitle}
		>
			<Icon name="lucide:paperclip" class="text-slate-600 dark:text-slate-400 w-4.5 h-4.5" />
			{#if attachedFiles.length > 0}
				<span class="absolute -top-1 -right-1 w-4 h-4 bg-violet-500 text-white text-xs rounded-full flex items-center justify-center">
					{attachedFiles.length}
				</span>
			{/if}
		</button>
	{/if}

	<!-- Send/Cancel button -->
	{#if isLoading}
		<button
			onclick={onCancel}
			class="w-10 h-10 bg-red-500 hover:bg-red-600 rounded-xl flex items-center justify-center transition-all duration-200 group"
			aria-label="Cancel request"
		>
			<Icon name="lucide:circle-stop" class="text-white w-5 h-5" />
		</button>
	{:else}
		<button
			onclick={onSend}
			disabled={(!messageText.trim() && attachedFiles.length === 0) || !hasActiveProject || isProcessingFiles}
			class="w-10 h-10 bg-gradient-to-r from-violet-600 to-violet-600 hover:from-violet-700 hover:to-violet-700 disabled:from-slate-300 disabled:to-slate-300 dark:disabled:from-slate-700 dark:disabled:to-slate-700 rounded-xl flex items-center justify-center transition-all duration-200 disabled:cursor-not-allowed group"
			aria-label="Send message"
		>
			<Icon name="lucide:send-horizontal" class="text-white w-5 h-5" />
		</button>
	{/if}
</div>
