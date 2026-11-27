<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		isLoading: boolean;
		isCancelling: boolean;
		hasActiveProject: boolean;
		attachmentCount: number;
		isProcessingFiles: boolean;
		/** What the submit button does right now. */
		submitMode: 'send' | 'queue' | 'edit';
		/** Whether there is anything to submit. */
		hasContent: boolean;
		/** Why submitting is not possible right now (null = it is). */
		submitBlockedReason: string | null;
		onSubmit: () => void;
		onCancel: () => void;
		onAttachFile: () => void;
		/** Open the `@` picker, as typing "@" does. */
		onMention: () => void;
	}

	const {
		isLoading,
		isCancelling,
		hasActiveProject,
		attachmentCount,
		isProcessingFiles,
		submitMode,
		hasContent,
		submitBlockedReason,
		onSubmit,
		onCancel,
		onAttachFile,
		onMention
	}: Props = $props();

	const attachDisabled = $derived(
		isProcessingFiles || !hasActiveProject
	);

	const attachTitle = 'Attach files';

	const submitLabel = $derived(
		submitMode === 'queue' ? 'Queue message' : submitMode === 'edit' ? 'Send edited message' : 'Send message'
	);
	const submitIcon = $derived<IconName>(submitMode === 'queue' ? 'lucide:list-plus' : 'lucide:send-horizontal');

	// While a response runs, the submit button only appears once there is
	// something to queue — Stop stays the obvious action.
	const showSubmit = $derived(!isCancelling && (!isLoading || hasContent));
	const submitDisabled = $derived(!hasContent || !!submitBlockedReason);
</script>

<!--
	Every control in the toolbar is the same height as the pickers beside it
	(32px; 40px on touch), with one gap between them: the two icon buttons are
	square, the solid send button a little wider.
-->
<div class="flex shrink-0 items-center gap-2">
	<div class="flex shrink-0 items-center gap-1">
		<!-- Mention button: the same picker as typing "@" -->
		<button
			type="button"
			onmousedown={(event) => event.preventDefault()}
			onclick={onMention}
			disabled={!hasActiveProject}
			class="inline-flex w-8 h-8 pointer-coarse:w-10 pointer-coarse:h-10 shrink-0 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
			title="Mention files, terminals, git, preview, chats… (@)"
			aria-label="Mention"
		>
			<Icon name="lucide:at-sign" class="text-slate-600 dark:text-slate-400 w-4.5 h-4.5" />
		</button>

		<!-- Attach file button -->
		<button
			type="button"
			onclick={onAttachFile}
			disabled={attachDisabled}
			class="relative inline-flex w-8 h-8 pointer-coarse:w-10 pointer-coarse:h-10 shrink-0 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
			title={attachTitle}
			aria-label={attachTitle}
		>
			<Icon name="lucide:paperclip" class="text-slate-600 dark:text-slate-400 w-4.5 h-4.5" />
			{#if attachmentCount > 0}
				<span class="absolute top-0.5 -right-1 w-4 h-4 bg-violet-500 text-white text-xs rounded-full flex items-center justify-center">
					{attachmentCount}
				</span>
			{/if}
		</button>
	</div>

	{#if showSubmit}
		<button
			type="button"
			onclick={onSubmit}
			disabled={submitDisabled}
			class="inline-flex shrink-0 w-10 h-8 pointer-coarse:h-10 rounded-lg items-center justify-center transition-colors disabled:cursor-not-allowed
				{submitMode === 'queue'
				? 'bg-slate-700 hover:bg-slate-800 dark:bg-slate-600 dark:hover:bg-slate-500 disabled:bg-slate-300 dark:disabled:bg-slate-700'
				: 'bg-violet-600 hover:bg-violet-700 disabled:bg-slate-300 dark:disabled:bg-slate-700'}"
			title={submitBlockedReason ?? submitLabel}
			aria-label={submitLabel}
		>
			<Icon name={submitIcon} class="text-white w-4.5 h-4.5" />
		</button>
	{/if}

	{#if isLoading}
		<button
			type="button"
			onclick={onCancel}
			class="inline-flex shrink-0 w-10 h-8 pointer-coarse:h-10 bg-red-500 hover:bg-red-600 rounded-lg items-center justify-center transition-colors"
			title="Stop"
			aria-label="Stop response"
		>
			<Icon name="lucide:circle-stop" class="text-white w-4.5 h-4.5" />
		</button>
	{:else if isCancelling}
		<button
			type="button"
			disabled
			class="inline-flex shrink-0 w-10 h-8 pointer-coarse:h-10 bg-red-500 opacity-70 rounded-lg items-center justify-center cursor-not-allowed"
			aria-label="Stopping..."
		>
			<Icon name="lucide:loader-circle" class="text-white w-4.5 h-4.5 animate-spin" />
		</button>
	{/if}
</div>
