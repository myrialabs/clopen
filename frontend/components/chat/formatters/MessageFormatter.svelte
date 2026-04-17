<script lang="ts">
	import ErrorMessage from './ErrorMessage.svelte';
	import TextMessage from './TextMessage.svelte';
	import Tools from './Tools.svelte';
	import Lightbox from '$frontend/components/common/overlay/Lightbox.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { formatFileSize } from '$frontend/utils/format';

	import type { FrontendMessage } from '$frontend/stores/core/sessions.svelte';
	import { getCompactSummary } from '$frontend/utils/chat/message-grouper';

	const { message }: { message: FrontendMessage } = $props();

	let lightboxOpen = $state(false);
	let lightboxData = $state<{ type: 'image' | 'document', data: string, mediaType: string, fileName?: string }>({
		type: 'image',
		data: '',
		mediaType: '',
		fileName: ''
	});

	function openAttachment(type: 'image' | 'document', data: string, mediaType: string, fileName?: string) {
		lightboxData = { type, data, mediaType, fileName };
		lightboxOpen = true;
	}

	function closeLightbox() {
		lightboxOpen = false;
	}

	type ContentElement = {
		type: 'text' | 'tool_use' | 'error' | 'image' | 'document';
		content: any;
		fileName?: string;
	};
	
	// Parse content into structured elements
	function parseContent() {
		const elements: ContentElement[] = [];

		// Handle compact boundary messages
		if (message.type === 'compact_boundary') {
			const trigger = message.trigger === 'manual' ? 'Manual' : 'Auto';
			elements.push({
				type: 'text',
				content: `Context was compacted (${trigger}). Previous messages have been summarized to free up context space.`
			});
			const summary = getCompactSummary(message);
			if (summary) {
				elements.push({ type: 'text', content: summary });
			}
			return elements;
		}

		// Handle streaming messages
		if (message.type === 'stream_event') {
			if (message.text) {
				elements.push({ type: 'text', content: message.text });
			}
			return elements;
		}

		// Handle reasoning messages
		if (message.type === 'reasoning') {
			if (message.text) {
				elements.push({ type: 'text', content: message.text });
			}
			return elements;
		}

		// Handle assistant messages
		if (message.type === 'assistant' && 'content' in message) {
			const elements: ContentElement[] = [];

			for (const contentItem of message.content) {
				if (contentItem.type === 'text') {
					elements.push({ type: 'text', content: (contentItem as any).text });
				} else if (contentItem.type === 'tool_use') {
					elements.push({ type: 'tool_use', content: contentItem });
				}
			}

			return elements;
		}

		// Handle user messages
		if (message.type === 'user' && 'content' in message) {
			for (const contentItem of message.content) {
				if (contentItem.type === 'text') {
					elements.push({ type: 'text', content: (contentItem as any).text });
				} else if (contentItem.type === 'image') {
					elements.push({ type: 'image', content: contentItem });
				} else if (contentItem.type === 'document') {
					elements.push({ type: 'document', content: contentItem });
				}
			}

			return elements;
		}

		return elements;
	}
	
	// Main parsed content  
	const parsedElements = $derived.by(parseContent);
</script>

{#each parsedElements as element}
	{#if element.type === 'error'}
		<ErrorMessage errorText={element.content} />
	{:else if element.type === 'text'}
		<TextMessage content={element.content} />
	{:else if element.type === 'tool_use'}
		<Tools toolInput={element.content} />
	{:else if element.type === 'image'}
		<div class="inline-block mr-2 mb-2">
			<div class="flex flex-col gap-1">
				{#if element.content.data}
					<button
						onclick={() => openAttachment('image', element.content.data, element.content.mediaType, element.fileName || 'Image')}
						class="relative w-28 h-28 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 cursor-pointer hover:opacity-80 transition-opacity focus:outline-none focus:ring-2 focus:ring-violet-500"
						aria-label="Click to view full image"
					>
						<img
							src="data:{element.content.mediaType};base64,{element.content.data}"
							alt={element.fileName || "User uploaded content"}
							class="absolute inset-0 w-full h-full object-cover"
							loading="lazy"
						/>
						</button>
				{:else}
					<div class="w-28 h-28 flex items-center justify-center bg-gradient-to-r from-slate-50 to-slate-100 dark:from-slate-800 dark:to-slate-750 rounded-lg border border-slate-200 dark:border-slate-700">
						<svg class="w-12 h-12 text-slate-400 dark:text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
						</svg>
					</div>
				{/if}
			</div>
		</div>
	{:else if element.type === 'document'}
		<div class="inline-block mr-2 mb-2">
			<div class="flex flex-col gap-1">
				{#if element.content.data}
					<button
						onclick={() => openAttachment('document', element.content.data, element.content.mediaType, element.fileName || 'Document')}
						class="relative w-28 h-28 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 cursor-pointer hover:opacity-80 transition-opacity focus:outline-none focus:ring-2 focus:ring-violet-500"
						aria-label="Click to view document"
					>
						<div class="absolute inset-0 flex flex-col items-center justify-center gap-1.5 p-2">
							<Icon
								name={element.fileName ? getFileIcon(element.fileName) : 'material:document'}
								class="w-8 h-8 text-slate-600 dark:text-slate-400 flex-shrink-0"
							/>
							{#if element.fileName}
								<span class="text-xs font-medium text-slate-700 dark:text-slate-300 line-clamp-2 w-full px-1 text-center leading-tight" title={element.fileName}>
									{element.fileName}
								</span>
							{/if}
							<span class="text-xs text-slate-500 dark:text-slate-400 -mt-0.5">
								{formatFileSize(element.content.data.length * 0.75)}
							</span>
						</div>
					</button>
				{:else}
					<div class="relative w-28 h-28 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
						<div class="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
							<Icon
								name="material:document"
								class="w-10 h-10 text-slate-600 dark:text-slate-400"
							/>
							<span class="text-xs font-medium text-slate-700 dark:text-slate-300">DOCUMENT</span>
						</div>
					</div>
				{/if}
			</div>
		</div>
	{/if}
{/each}

<!-- Lightbox for viewing attachments -->
<Lightbox
	bind:isOpen={lightboxOpen}
	type={lightboxData.type}
	mediaType={lightboxData.mediaType}
	data={lightboxData.data}
	fileName={lightboxData.fileName}
	onClose={closeLightbox}
/>