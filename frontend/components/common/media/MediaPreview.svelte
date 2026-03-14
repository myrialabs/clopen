<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import LoadingSpinner from '$frontend/components/common/feedback/LoadingSpinner.svelte';
	import { isImageFile, isSvgFile, isPdfFile, isAudioFile, isVideoFile } from '$frontend/utils/file-type';
	import { debug } from '$shared/utils/logger';
	import ws from '$frontend/utils/ws';

	interface Props {
		/** File name for type detection */
		fileName: string;
		/** Absolute path used to load binary content via ws */
		filePath: string;
		/** Optional text content for SVG inline rendering */
		svgContent?: string;
	}

	const { fileName, filePath, svgContent }: Props = $props();

	let blobUrl = $state<string | null>(null);
	let pdfBlobUrl = $state<string | null>(null);
	let mediaBlobUrl = $state<string | null>(null);
	let isLoading = $state(false);

	function cleanup() {
		if (blobUrl) {
			URL.revokeObjectURL(blobUrl);
			blobUrl = null;
		}
		if (pdfBlobUrl) {
			URL.revokeObjectURL(pdfBlobUrl);
			pdfBlobUrl = null;
		}
		if (mediaBlobUrl) {
			URL.revokeObjectURL(mediaBlobUrl);
			mediaBlobUrl = null;
		}
	}

	async function loadBinaryContent(path: string, name: string) {
		isLoading = true;
		try {
			const response = await ws.http('files:read-content', { path });

			if (response.content) {
				const binaryString = atob(response.content);
				const bytes = new Uint8Array(binaryString.length);
				for (let i = 0; i < binaryString.length; i++) {
					bytes[i] = binaryString.charCodeAt(i);
				}
				const blob = new Blob([bytes], { type: response.contentType || 'application/octet-stream' });

				if (isPdfFile(name)) {
					if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);
					pdfBlobUrl = URL.createObjectURL(blob);
				} else if (isAudioFile(name) || isVideoFile(name)) {
					if (mediaBlobUrl) URL.revokeObjectURL(mediaBlobUrl);
					mediaBlobUrl = URL.createObjectURL(blob);
				} else {
					if (blobUrl) URL.revokeObjectURL(blobUrl);
					blobUrl = URL.createObjectURL(blob);
				}
			}
		} catch (err) {
			debug.error('file', 'Failed to load binary content:', err);
		} finally {
			isLoading = false;
		}
	}

	$effect(() => {
		const name = fileName;
		const path = filePath;
		untrack(() => {
			cleanup();
			if (name && path) {
				loadBinaryContent(path, name);
			}
		});
	});

	onDestroy(cleanup);
</script>

{#if isImageFile(fileName)}
	<div class="flex items-center justify-center h-full p-4 overflow-hidden checkerboard-bg">
		{#if isLoading}
			<LoadingSpinner size="lg" />
		{:else if blobUrl}
			<img
				src={blobUrl}
				alt={fileName}
				class="max-w-full max-h-full object-contain"
			/>
		{:else}
			<div class="flex flex-col items-center gap-2 text-slate-500 text-xs">
				<Icon name="lucide:image-off" class="w-8 h-8 opacity-40" />
				<span>Failed to load preview</span>
			</div>
		{/if}
	</div>
{:else if isSvgFile(fileName)}
	<div class="flex items-center justify-center h-full p-4 overflow-auto checkerboard-bg">
		{#if isLoading}
			<LoadingSpinner size="lg" />
		{:else if blobUrl}
			<img
				src={blobUrl}
				alt={fileName}
				class="max-w-full max-h-full object-contain"
			/>
		{:else if svgContent}
			<div class="max-w-full max-h-full flex items-center justify-center">
				{@html svgContent}
			</div>
		{:else}
			<div class="flex flex-col items-center gap-2 text-slate-500 text-xs">
				<Icon name="lucide:image-off" class="w-8 h-8 opacity-40" />
				<span>Failed to load preview</span>
			</div>
		{/if}
	</div>
{:else if isPdfFile(fileName)}
	<div class="h-full w-full">
		{#if isLoading}
			<div class="flex items-center justify-center h-full">
				<LoadingSpinner size="lg" />
			</div>
		{:else if pdfBlobUrl}
			<iframe
				src={pdfBlobUrl}
				title={fileName}
				class="w-full h-full border-0"
			></iframe>
		{:else}
			<div class="flex flex-col items-center justify-center h-full gap-2 text-slate-500 text-xs">
				<Icon name="lucide:file-x" class="w-8 h-8 opacity-40" />
				<span>Failed to load PDF preview</span>
			</div>
		{/if}
	</div>
{:else if isAudioFile(fileName)}
	<div class="flex flex-col items-center justify-center h-full p-8 checkerboard-bg">
		<Icon name="lucide:music" class="w-16 h-16 text-violet-400 mb-6" />
		<h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4">
			{fileName}
		</h3>
		{#if isLoading}
			<LoadingSpinner size="lg" />
		{:else if mediaBlobUrl}
			<audio controls class="w-full max-w-md" src={mediaBlobUrl}>
				Your browser does not support the audio element.
			</audio>
		{:else}
			<div class="flex flex-col items-center gap-2 text-slate-500 text-xs">
				<Icon name="lucide:music" class="w-8 h-8 opacity-40" />
				<span>Failed to load audio</span>
			</div>
		{/if}
	</div>
{:else if isVideoFile(fileName)}
	<div class="flex items-center justify-center h-full p-4 overflow-hidden checkerboard-bg">
		{#if isLoading}
			<LoadingSpinner size="lg" />
		{:else if mediaBlobUrl}
			<!-- svelte-ignore a11y_media_has_caption -->
			<video controls class="max-w-full max-h-full object-contain" src={mediaBlobUrl}>
				Your browser does not support the video element.
			</video>
		{:else}
			<div class="flex flex-col items-center gap-2 text-slate-500 text-xs">
				<Icon name="lucide:video-off" class="w-8 h-8 opacity-40" />
				<span>Failed to load video</span>
			</div>
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
