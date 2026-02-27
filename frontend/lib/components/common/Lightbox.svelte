<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import { getFileIcon } from '$frontend/lib/utils/file-icon-mappings';
	import { formatFileSize } from '$frontend/lib/components/chat/shared/utils';
	import { debug } from '$shared/utils/logger';

	interface Props {
		isOpen: boolean;
		type: 'image' | 'document';
		mediaType: string;
		data: string;
		onClose: () => void;
		fileName?: string;
	}

	let {
		isOpen = $bindable(),
		type,
		mediaType,
		data,
		onClose,
		fileName = 'Document'
	}: Props = $props();

	let modalElement = $state<HTMLDivElement>();

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && isOpen) {
			onClose();
		}
	}

	function handleBackdropClick(event: MouseEvent) {
		if (event.target === modalElement) {
			onClose();
		}
	}

	function openInNewTab() {
		try {
			// Create a blob from the base64 data
			const byteCharacters = atob(data);
			const byteNumbers = new Array(byteCharacters.length);
			for (let i = 0; i < byteCharacters.length; i++) {
				byteNumbers[i] = byteCharacters.charCodeAt(i);
			}
			const byteArray = new Uint8Array(byteNumbers);
			const blob = new Blob([byteArray], { type: mediaType });

			// Create object URL and open it
			const blobUrl = URL.createObjectURL(blob);
			const newWindow = window.open(blobUrl, '_blank');

			// Clean up the object URL after a delay to ensure the new tab has loaded
			if (newWindow) {
				setTimeout(() => {
					URL.revokeObjectURL(blobUrl);
				}, 1000);
			}
		} catch (error) {
			debug.error('session', 'Failed to open attachment in new tab:', error);
			// Fallback to data URL approach if blob creation fails
			const dataUrl = `data:${mediaType};base64,${data}`;
			window.open(dataUrl, '_blank');
		}

		onClose();
	}

	function downloadFile() {
		try {
			// Create a blob from the base64 data
			const byteCharacters = atob(data);
			const byteNumbers = new Array(byteCharacters.length);
			for (let i = 0; i < byteCharacters.length; i++) {
				byteNumbers[i] = byteCharacters.charCodeAt(i);
			}
			const byteArray = new Uint8Array(byteNumbers);
			const blob = new Blob([byteArray], { type: mediaType });

			// Create object URL and trigger download
			const blobUrl = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = blobUrl;

			// Determine file extension based on media type
			let extension = '.bin';
			if (mediaType.includes('pdf')) extension = '.pdf';
			else if (mediaType.includes('image/png')) extension = '.png';
			else if (mediaType.includes('image/jpeg') || mediaType.includes('image/jpg')) extension = '.jpg';
			else if (mediaType.includes('image/gif')) extension = '.gif';
			else if (mediaType.includes('image/svg')) extension = '.svg';
			else if (mediaType.includes('image/webp')) extension = '.webp';

			link.download = fileName || `attachment_${Date.now()}${extension}`;
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);

			// Clean up
			setTimeout(() => {
				URL.revokeObjectURL(blobUrl);
			}, 100);
		} catch (error) {
			debug.error('session', 'Failed to download attachment:', error);
		}

		onClose();
	}

	$effect(() => {
		if (isOpen) {
			document.body.style.overflow = 'hidden';
		} else {
			document.body.style.overflow = '';
		}
	});
</script>

<svelte:window on:keydown={handleKeydown} />

{#if isOpen}
	<div
		bind:this={modalElement}
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
		aria-label="View attachment"
		tabindex="-1"
		onclick={handleBackdropClick}
		onkeydown={handleKeydown}
		in:fade={{ duration: 200, easing: cubicOut }}
		out:fade={{ duration: 150, easing: cubicOut }}
	>
		<!-- Close button (always visible) -->
		<button
			onclick={onClose}
			class="absolute top-4 right-4 z-10 p-2.5 rounded-full bg-white/90 dark:bg-slate-800/90 hover:bg-white dark:hover:bg-slate-800 transition-all shadow-lg"
			aria-label="Close lightbox"
		>
			<svg class="w-5 h-5 text-slate-700 dark:text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
			</svg>
		</button>

		<!-- Download button -->
		<button
			onclick={downloadFile}
			class="absolute top-4 right-16 z-10 p-2.5 rounded-full bg-white/90 dark:bg-slate-800/90 hover:bg-white dark:hover:bg-slate-800 transition-all shadow-lg"
			aria-label="Download file"
			title="Download file"
		>
			<svg class="w-5 h-5 text-slate-700 dark:text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path>
			</svg>
		</button>

		<!-- Open in new tab button -->
		<button
			onclick={openInNewTab}
			class="absolute top-4 right-28 z-10 p-2.5 rounded-full bg-white/90 dark:bg-slate-800/90 hover:bg-white dark:hover:bg-slate-800 transition-all shadow-lg"
			aria-label="Open in new tab"
			title="Open in new tab"
		>
			<svg class="w-5 h-5 text-slate-700 dark:text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path>
			</svg>
		</button>

		<!-- Content container -->
		<div
			class="relative max-w-[95vw] max-h-[95vh] flex items-center justify-center"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
			tabindex="-1"
			in:scale={{ duration: 200, easing: cubicOut, start: 0.9 }}
			out:scale={{ duration: 150, easing: cubicOut, start: 0.95 }}
		>
			{#if type === 'image'}
				<!-- Image viewer -->
				<img
					src="data:{mediaType};base64,{data}"
					alt="Full size view"
					class="max-w-full max-h-[90vh] object-contain rounded-lg shadow-2xl"
					loading="eager"
				/>
			{:else if type === 'document'}
				<!-- Document preview -->
				<div class="bg-white dark:bg-slate-900 rounded-lg shadow-2xl p-8 min-w-80 max-w-md text-center">
					<div class="mb-6">
						<Icon
							name={fileName ? getFileIcon(fileName) : 'material:document'}
							class="w-20 h-20 mx-auto text-slate-600 dark:text-slate-400"
						/>
					</div>

					<h3 class="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">
						{fileName}
					</h3>

					<p class="text-sm text-slate-600 dark:text-slate-400 mb-6">
						{formatFileSize(data.length * 0.75)}
					</p>

					<div class="flex flex-col gap-3">
						<button
							onclick={downloadFile}
							class="w-full px-4 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors font-medium flex items-center justify-center gap-2"
						>
							<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path>
							</svg>
							Download File
						</button>

						<button
							onclick={openInNewTab}
							class="w-full px-4 py-2.5 bg-slate-600 hover:bg-slate-700 text-white rounded-lg transition-colors font-medium flex items-center justify-center gap-2"
						>
							<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path>
							</svg>
							Open in New Tab
						</button>
					</div>
				</div>
			{/if}
		</div>
	</div>
{/if}