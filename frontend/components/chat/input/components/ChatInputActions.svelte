<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		isLoading: boolean;
		isCancelling: boolean;
		hasActiveProject: boolean;
		attachmentCount: number;
		isProcessingFiles: boolean;
		modelSupportsAttachments: boolean;
		/** What the submit button does right now. */
		submitMode: 'send' | 'queue' | 'edit';
		/** Whether there is anything to submit. */
		hasContent: boolean;
		/** Why submitting is not possible right now (null = it is). */
		submitBlockedReason: string | null;
		onSubmit: () => void;
		onCancel: () => void;
		onAttachFile: () => void;
	}

	const {
		isLoading,
		isCancelling,
		hasActiveProject,
		attachmentCount,
		isProcessingFiles,
		modelSupportsAttachments,
		submitMode,
		hasContent,
		submitBlockedReason,
		onSubmit,
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

	const submitLabel = $derived(
		submitMode === 'queue' ? 'Queue message' : submitMode === 'edit' ? 'Send edited message' : 'Send message'
	);
	const submitIcon = $derived<IconName>(submitMode === 'queue' ? 'lucide:list-plus' : 'lucide:send-horizontal');

	// While a response runs, the submit button only appears once there is
	// something to queue — Stop stays the obvious action.
	const showSubmit = $derived(!isCancelling && (!isLoading || hasContent));
	const submitDisabled = $derived(!hasContent || !!submitBlockedReason);
</script>

<div class="flex items-center gap-1 flex-shrink-0 pr-2 pb-2">
	<!-- Attach file button -->
	<button
		type="button"
		onclick={onAttachFile}
		disabled={attachDisabled}
		class="w-9 h-9 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed relative"
		title={attachTitle}
		aria-label={attachTitle}
	>
		<Icon name="lucide:paperclip" class="text-slate-600 dark:text-slate-400 w-4.5 h-4.5" />
		{#if attachmentCount > 0}
			<span class="absolute -top-1 -right-1 w-4 h-4 bg-violet-500 text-white text-xs rounded-full flex items-center justify-center">
				{attachmentCount}
			</span>
		{/if}
	</button>

	{#if showSubmit}
		<button
			type="button"
			onclick={onSubmit}
			disabled={submitDisabled}
			class="w-10 h-10 rounded-xl flex items-center justify-center transition-colors disabled:cursor-not-allowed
				{submitMode === 'queue'
				? 'bg-slate-700 hover:bg-slate-800 dark:bg-slate-600 dark:hover:bg-slate-500 disabled:bg-slate-300 dark:disabled:bg-slate-700'
				: 'bg-violet-600 hover:bg-violet-700 disabled:bg-slate-300 dark:disabled:bg-slate-700'}"
			title={submitBlockedReason ?? submitLabel}
			aria-label={submitLabel}
		>
			<Icon name={submitIcon} class="text-white w-5 h-5" />
		</button>
	{/if}

	{#if isLoading}
		<button
			type="button"
			onclick={onCancel}
			class="w-10 h-10 bg-red-500 hover:bg-red-600 rounded-xl flex items-center justify-center transition-colors"
			title="Stop"
			aria-label="Stop response"
		>
			<Icon name="lucide:circle-stop" class="text-white w-5 h-5" />
		</button>
	{:else if isCancelling}
		<button
			type="button"
			disabled
			class="w-10 h-10 bg-red-500 opacity-70 rounded-xl flex items-center justify-center cursor-not-allowed"
			aria-label="Stopping..."
		>
			<Icon name="lucide:loader-circle" class="text-white w-5 h-5 animate-spin" />
		</button>
	{/if}
</div>
