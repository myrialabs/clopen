<!--
  One viewer for every file preview: the Files panel, Git diffs, the SSH file
  browser and chat attachments.

  - PDFs are drawn with PDF.js (PdfViewer), so they read the same on every
    device — browsers' own viewers don't exist on Android.
  - Whether an image, audio or video plays is up to the browser (HEIC shows in
    Safari only, AVI almost nowhere). When it can't, the viewer says so and
    offers the file instead of showing a broken player.
  - With `textPreview`, a file of no known kind is shown as text when it reads
    as text — what an attached log, CSV or source file needs.
-->
<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import LoadingSpinner from '$frontend/components/common/feedback/LoadingSpinner.svelte';
	import PdfViewer from './PdfViewer.svelte';
	import { previewKind } from '$frontend/utils/file-type';
	import { getAttachmentIcon } from '$frontend/utils/file-icon-mappings';
	import { formatFileSize } from '$frontend/utils/format';
	import { debug } from '$shared/utils/logger';
	import ws from '$frontend/utils/ws';

	interface Props {
		/** File name for type detection */
		fileName: string;
		/** Absolute path used to load binary content via ws */
		filePath: string;
		/** The file's MIME type, when the name alone doesn't tell (a pasted "image"). */
		mediaType?: string;
		/** Optional text content for SVG inline rendering */
		svgContent?: string;
		/** Bump to force a reload of the same path (e.g. after an in-place edit). */
		reloadToken?: number;
		/**
		 * How the file's bytes are fetched. Defaults to reading a project file
		 * over the WebSocket; the SSH file browser passes a loader that pulls the
		 * bytes off the remote host, and chat attachments decode their own — so
		 * every panel previews through this one component.
		 */
		loadBlob?: (path: string) => Promise<Blob | null>;
		/** Show files of no known kind as text when they read as text. */
		textPreview?: boolean;
		/** Offer download / open-in-new-tab inside the viewer (off where the window around it has them). */
		fileActions?: boolean;
	}

	const { fileName, filePath, mediaType, svgContent, reloadToken = 0, loadBlob, textPreview = false, fileActions = true }: Props = $props();

	/** Larger text is cut here — a preview, not an editor. */
	const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;

	const kind = $derived(previewKind(fileName, mediaType));

	let blob = $state<Blob | null>(null);
	let blobUrl = $state<string | null>(null);
	let text = $state<string | null>(null);
	let textTruncated = $state(false);
	let isLoading = $state(false);
	let loadFailed = $state(false);
	// The browser had the bytes but couldn't show them.
	let unsupported = $state(false);
	let generation = 0;

	function cleanup() {
		if (blobUrl) URL.revokeObjectURL(blobUrl);
		blobUrl = null;
		blob = null;
		text = null;
		textTruncated = false;
		unsupported = false;
		loadFailed = false;
	}

	/** The default source: a file in the open project, read over the socket. */
	async function readProjectFile(path: string): Promise<Blob | null> {
		const response = await ws.http('files:read-content', { path });
		if (!response.content) return null;
		const binaryString = atob(response.content);
		const bytes = new Uint8Array(binaryString.length);
		for (let index = 0; index < binaryString.length; index++) {
			bytes[index] = binaryString.charCodeAt(index);
		}
		return new Blob([bytes], { type: response.contentType || 'application/octet-stream' });
	}

	/** The text of a file that reads as UTF-8 text, or null for binary bytes. */
	async function readAsText(source: Blob): Promise<{ text: string; truncated: boolean } | null> {
		const truncated = source.size > MAX_TEXT_PREVIEW_BYTES;
		const bytes = new Uint8Array(await source.slice(0, MAX_TEXT_PREVIEW_BYTES).arrayBuffer());
		if (bytes.includes(0)) return null;
		try {
			// A cut can split a multi-byte character; only the end may be broken.
			const decoded = new TextDecoder('utf-8', { fatal: !truncated }).decode(bytes);
			return { text: decoded, truncated };
		} catch {
			return null;
		}
	}

	async function load(path: string, currentKind: typeof kind) {
		const current = ++generation;
		isLoading = true;
		try {
			const loaded = await (loadBlob ?? readProjectFile)(path);
			if (current !== generation) return;
			if (!loaded) {
				loadFailed = true;
				return;
			}
			blob = loaded;
			if (currentKind === 'other') {
				const readable = textPreview ? await readAsText(loaded) : null;
				if (current !== generation) return;
				if (readable) {
					text = readable.text;
					textTruncated = readable.truncated;
				} else {
					unsupported = true;
				}
			} else if (currentKind !== 'pdf') {
				blobUrl = URL.createObjectURL(loaded);
			}
		} catch (err) {
			if (current !== generation) return;
			debug.error('file', 'Failed to load binary content:', err);
			loadFailed = true;
		} finally {
			if (current === generation) isLoading = false;
		}
	}

	$effect(() => {
		const name = fileName;
		const path = filePath;
		const currentKind = kind;
		// Track reloadToken so an in-place edit re-fetches the same path.
		void reloadToken;
		untrack(() => {
			cleanup();
			if (name && path) void load(path, currentKind);
		});
	});

	onDestroy(() => {
		generation++;
		cleanup();
	});

	function download() {
		if (!blob) return;
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = fileName;
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	function openInNewTab() {
		if (!blob) return;
		const url = URL.createObjectURL(blob);
		window.open(url, '_blank', 'noopener');
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	}

	const unsupportedReason = $derived.by(() => {
		switch (kind) {
			case 'image':
				return "This browser can't display this image format.";
			case 'audio':
				return "This browser can't play this audio format.";
			case 'video':
				return "This browser can't play this video format.";
			default:
				return 'There is no preview for this kind of file.';
		}
	});
</script>

{#snippet fallback(reason: string)}
	<div class="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
		<Icon name={getAttachmentIcon(fileName, mediaType ?? blob?.type ?? '')} class="w-14 h-14" />
		<div class="flex flex-col gap-1 min-w-0 max-w-full">
			<span class="text-sm font-semibold text-slate-900 dark:text-slate-100 break-all">{fileName}</span>
			{#if blob}
				<span class="text-xs text-slate-500">{formatFileSize(blob.size)}</span>
			{/if}
		</div>
		<p class="text-xs text-slate-500 dark:text-slate-400 max-w-xs">{reason}</p>
		{#if blob}
			<div class="flex flex-wrap justify-center gap-2">
				<button
					type="button"
					class="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-xs font-medium transition-colors"
					onclick={download}
				>
					<Icon name="lucide:download" class="w-3.5 h-3.5" />
					Download
				</button>
				<button
					type="button"
					class="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium transition-colors"
					onclick={openInNewTab}
				>
					<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
					Open in new tab
				</button>
			</div>
		{/if}
	</div>
{/snippet}

{#if isLoading}
	<div class="flex items-center justify-center h-full">
		<LoadingSpinner size="lg" />
	</div>
{:else if loadFailed && !(kind === 'svg' && svgContent)}
	<div class="flex flex-col items-center justify-center h-full gap-2 text-slate-500 text-xs">
		<Icon name="lucide:file-x" class="w-8 h-8 opacity-40" />
		<span>Failed to load preview</span>
	</div>
{:else if unsupported}
	{@render fallback(unsupportedReason)}
{:else if kind === 'image'}
	<div class="flex items-center justify-center h-full p-4 overflow-hidden checkerboard-bg">
		{#if blobUrl}
			<img
				src={blobUrl}
				alt={fileName}
				class="max-w-full max-h-full object-contain"
				onerror={() => (unsupported = true)}
			/>
		{/if}
	</div>
{:else if kind === 'svg'}
	<div class="flex items-center justify-center h-full p-4 overflow-auto checkerboard-bg">
		{#if blobUrl}
			<img
				src={blobUrl}
				alt={fileName}
				class="max-w-full max-h-full object-contain"
			/>
		{:else if svgContent}
			<div class="max-w-full max-h-full flex items-center justify-center">
				{@html svgContent}
			</div>
		{/if}
	</div>
{:else if kind === 'pdf'}
	{#if blob}
		<PdfViewer data={blob} {fileName} {fileActions} />
	{/if}
{:else if kind === 'audio'}
	<div class="flex flex-col items-center justify-center h-full p-8 checkerboard-bg">
		<Icon name="lucide:music" class="w-16 h-16 text-violet-400 mb-6" />
		<h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4 break-all text-center">
			{fileName}
		</h3>
		{#if blobUrl}
			<audio controls class="w-full max-w-md" src={blobUrl} onerror={() => (unsupported = true)}>
				Your browser does not support the audio element.
			</audio>
		{/if}
	</div>
{:else if kind === 'video'}
	<div class="flex items-center justify-center h-full p-4 overflow-hidden checkerboard-bg">
		{#if blobUrl}
			<!-- svelte-ignore a11y_media_has_caption -->
			<video
				controls
				playsinline
				class="max-w-full max-h-full object-contain"
				src={blobUrl}
				onerror={() => (unsupported = true)}
			>
				Your browser does not support the video element.
			</video>
		{/if}
	</div>
{:else if text !== null}
	<div class="h-full overflow-auto bg-white dark:bg-slate-950">
		<pre class="p-4 text-xs leading-relaxed font-mono text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-words">{text}</pre>
		{#if textTruncated}
			<div class="px-4 pb-4 text-xs text-slate-500">Showing the first {formatFileSize(MAX_TEXT_PREVIEW_BYTES)}. Download the file to see all of it.</div>
		{/if}
	</div>
{/if}

<style>
	.checkerboard-bg {
		background-image: url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2220%22%20height%3D%2220%22%3E%3Crect%20width%3D%2220%22%20height%3D%2220%22%20fill%3D%22%23f0f0f0%22%2F%3E%3Crect%20width%3D%2210%22%20height%3D%2210%22%20fill%3D%22%23e0e0e0%22%2F%3E%3Crect%20x%3D%2210%22%20y%3D%2210%22%20width%3D%2210%22%20height%3D%2210%22%20fill%3D%22%23e0e0e0%22%2F%3E%3C%2Fsvg%3E');
	}

	:global(.dark) .checkerboard-bg {
		background-image: url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2220%22%20height%3D%2220%22%3E%3Crect%20width%3D%2220%22%20height%3D%2220%22%20fill%3D%22%23181818%22%2F%3E%3Crect%20width%3D%2210%22%20height%3D%2210%22%20fill%3D%22%23222222%22%2F%3E%3Crect%20x%3D%2210%22%20y%3D%2210%22%20width%3D%2210%22%20height%3D%2210%22%20fill%3D%22%23222222%22%2F%3E%3C%2Fsvg%3E');
	}
</style>
