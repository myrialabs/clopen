<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { FileNode } from '$shared/types/filesystem';
	import { copyText } from '$frontend/utils/clipboard';
	import { fetchFileBlob, isAbortError, saveBlob } from '$frontend/utils/file-download';
	import { debug } from '$shared/utils/logger';

	interface Props {
		file: FileNode | null;
		isOpen: boolean;
		onClose: () => void;
	}

	const { file, isOpen, onClose }: Props = $props();

	let copied = $state(false);
	let downloading = $state(false);
	let progress = $state<number | null>(null);
	let error = $state<string | null>(null);
	let controller = $state<AbortController | null>(null);

	// Reset transient state each time the dialog opens so a previous run's
	// feedback (copied tick, progress, error) never carries over.
	$effect(() => {
		if (isOpen) {
			copied = false;
			downloading = false;
			progress = null;
			error = null;
			controller = null;
		}
	});

	async function copyPath(): Promise<void> {
		if (!file) return;
		error = null;
		if (await copyText(file.path)) {
			copied = true;
		} else {
			error = 'Could not copy the path.';
		}
	}

	async function download(): Promise<void> {
		if (!file || downloading) return;
		error = null;
		downloading = true;
		progress = null;
		controller = new AbortController();
		try {
			const blob = await fetchFileBlob(file.path, {
				totalBytes: file.size ?? null,
				signal: controller.signal,
				onProgress: ({ transferredBytes, totalBytes }) => {
					progress = totalBytes ? transferredBytes / totalBytes : null;
				}
			});
			saveBlob(blob, file.name);
			onClose();
		} catch (err) {
			if (isAbortError(err)) return;
			const message = err instanceof Error ? err.message : 'Failed to download file';
			error = message;
			debug.error('files', 'share-modal download failed:', err);
		} finally {
			downloading = false;
			controller = null;
		}
	}

	function cancelDownload(): void {
		controller?.abort();
	}
</script>

<Modal {isOpen} {onClose} title="Share" size="sm">
	<div class="space-y-3 text-sm">
		{#if file}
			<div class="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-slate-100/80 dark:bg-slate-800/60 min-w-0">
				<Icon name="lucide:file" class="w-4 h-4 text-slate-400 shrink-0" />
				<div class="flex-1 min-w-0">
					<div class="font-medium text-slate-900 dark:text-slate-100 truncate">{file.name}</div>
					<div class="text-xs text-slate-500 dark:text-slate-400 truncate">{file.path}</div>
				</div>
			</div>
		{/if}

		<div class="flex flex-col gap-1">
			<button
				type="button"
				class="flex items-center gap-2.5 w-full px-3 min-h-[44px] py-2 rounded-lg text-left text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 active:bg-slate-200 dark:active:bg-slate-700 touch-manipulation cursor-pointer transition-colors"
				onclick={copyPath}
				disabled={!file}
			>
				<Icon name={copied ? 'lucide:check' : 'lucide:link'} class="w-4 h-4 shrink-0 {copied ? 'text-emerald-500' : 'text-slate-400'}" />
				<span class="flex-1">{copied ? 'Path copied' : 'Copy path'}</span>
			</button>

			<button
				type="button"
				class="flex items-center gap-2.5 w-full px-3 min-h-[44px] py-2 rounded-lg text-left text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 active:bg-slate-200 dark:active:bg-slate-700 touch-manipulation cursor-pointer transition-colors disabled:opacity-50"
				onclick={downloading ? cancelDownload : download}
				disabled={!file}
			>
				<Icon name={downloading ? 'lucide:x' : 'lucide:download'} class="w-4 h-4 shrink-0 text-slate-400" />
				<span class="flex-1">{downloading ? 'Cancel download' : 'Download to this device'}</span>
			</button>

			{#if downloading}
				<div class="px-3 py-1">
					<div class="h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
						{#if progress !== null}
							<div class="h-full rounded-full bg-violet-500 transition-[width] duration-150" style="width: {Math.round(progress * 100)}%"></div>
						{:else}
							<div class="h-full w-1/3 rounded-full bg-violet-500 animate-pulse"></div>
						{/if}
					</div>
				</div>
			{/if}
		</div>

		{#if error}
			<p class="px-1 text-xs text-red-600 dark:text-red-400">{error}</p>
		{/if}

		<p class="px-1 text-xs text-slate-400 dark:text-slate-500">
			Link and QR-code sharing aren't available on this server yet — copy the path or download the file instead.
		</p>
	</div>

	{#snippet footer()}
		<button
			type="button"
			class="px-3 py-1.5 rounded-md text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
			onclick={onClose}
		>
			Close
		</button>
	{/snippet}
</Modal>
