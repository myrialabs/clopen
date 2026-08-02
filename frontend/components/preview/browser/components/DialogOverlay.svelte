<script lang="ts">
	/**
	 * `alert()` / `confirm()` / `prompt()` for the preview.
	 *
	 * A JS dialog blocks the page's renderer, which in a streamed preview means
	 * the video freezes until it is answered — so it has to be answered *here*,
	 * by the person watching. Rendering our own also avoids `window.confirm`,
	 * which would block Clopen's own UI thread and stall the stream decoder.
	 *
	 * Dialogs are modal by nature, so this traps focus and blocks the canvas
	 * beneath it, exactly like the real thing.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import type { BrowserDialogEvent } from '$frontend/utils/native-ui';

	let {
		dialog = null as BrowserDialogEvent | null,
		origin = '',
		onRespond = (_accept: boolean, _promptText?: string) => {}
	} = $props();

	let promptValue = $state('');
	let inputElement = $state<HTMLInputElement | undefined>();
	let confirmButton = $state<HTMLButtonElement | undefined>();

	const isPrompt = $derived(dialog?.type === 'prompt');
	const isAlert = $derived(dialog?.type === 'alert');
	const isBeforeUnload = $derived(dialog?.type === 'beforeunload');

	const heading = $derived.by(() => {
		if (!dialog) return '';
		if (isBeforeUnload) return 'Leave site?';
		return origin ? `${origin} says` : 'This page says';
	});

	const confirmLabel = $derived(isBeforeUnload ? 'Leave' : 'OK');
	const cancelLabel = $derived(isBeforeUnload ? 'Stay' : 'Cancel');

	function accept() {
		onRespond(true, isPrompt ? promptValue : undefined);
	}

	function dismiss() {
		onRespond(false);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			accept();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			// alert() has no cancel path — Escape resolves it the same way OK does.
			if (isAlert) accept();
			else dismiss();
		}
	}

	$effect(() => {
		if (!dialog) return;

		promptValue = dialog.defaultValue ?? '';
		queueMicrotask(() => {
			if (isPrompt) {
				inputElement?.focus();
				inputElement?.select();
			} else {
				confirmButton?.focus();
			}
		});
	});
</script>

{#if dialog}
	<div
		class="absolute inset-0 z-40 flex items-start justify-center bg-slate-900/40 px-4 pt-10 backdrop-blur-[1px]"
		role="dialog"
		aria-modal="true"
		aria-label={heading}
		tabindex="-1"
		onkeydown={handleKeydown}
		transition:fade={{ duration: 120 }}
	>
		<div
			class="w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-800"
			in:scale={{ duration: 160, easing: cubicOut, start: 0.96 }}
		>
			<div class="flex items-start gap-3 px-5 pt-4">
				<span
					class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full
						{isBeforeUnload ? 'bg-amber-500/15 text-amber-500' : 'bg-violet-500/15 text-violet-500'}"
				>
					<Icon name={isBeforeUnload ? 'lucide:triangle-alert' : 'lucide:message-square'} class="h-4 w-4" />
				</span>
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{heading}</p>
					<p class="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm text-slate-600 dark:text-slate-300">
						{dialog.message || (isBeforeUnload ? 'Changes you made may not be saved.' : '')}
					</p>
				</div>
			</div>

			{#if isPrompt}
				<div class="px-5 pt-3">
					<input
						bind:this={inputElement}
						bind:value={promptValue}
						type="text"
						class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-violet-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
					/>
				</div>
			{/if}

			<div class="mt-4 flex justify-end gap-2 bg-slate-50 px-5 py-3 dark:bg-slate-900/50">
				{#if !isAlert}
					<button
						type="button"
						class="rounded-lg px-3.5 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-700"
						onclick={dismiss}
					>
						{cancelLabel}
					</button>
				{/if}
				<button
					bind:this={confirmButton}
					type="button"
					class="rounded-lg bg-violet-600 px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-700"
					onclick={accept}
				>
					{confirmLabel}
				</button>
			</div>
		</div>
	</div>
{/if}
