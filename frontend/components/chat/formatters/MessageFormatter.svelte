<script lang="ts">
	import ErrorMessage from './ErrorMessage.svelte';
	import TextMessage from './TextMessage.svelte';
	import Tools from './Tools.svelte';
	import Lightbox, { type ViewerItem } from '$frontend/components/common/overlay/Lightbox.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { getAttachmentIcon } from '$frontend/utils/file-icon-mappings';
	import { formatFileSize } from '$frontend/utils/format';
	import { mentionToken, splitMentions } from '$shared/utils/attachment-mentions';
	import { contextNoun, describeContext, readContextHeaderFromBase64 } from '$shared/utils/context-document';
	import { CONTEXT_ICONS } from '$frontend/utils/context-icons';
	import type { ContextSource } from '$shared/types/mentions';

	import type { FrontendMessage } from '$frontend/stores/core/sessions.svelte';
	import { getCompactSummary } from '$frontend/utils/chat/message-grouper';

	const { message }: { message: FrontendMessage } = $props();

	type ContentElement =
		| { type: 'text' | 'tool_use' | 'error'; content: any }
		| { type: 'attachments' };

	/** One attached file of a user message, under the number `@N` names. */
	interface Attachment {
		number: number;
		kind: 'image' | 'document' | 'file';
		name: string;
		mediaType: string;
		size: number;
		/** The bytes, for a file the message holds inline. */
		data?: string;
		/** Where the file was saved, for one the model was given by path. */
		path?: string;
		/** What an `@` mention attached. */
		context?: ContextSource;
	}

	// A user message's files, in the order (and with the numbers) they were sent.
	// Messages from before numbering are numbered by position — the same order.
	const attachments = $derived.by((): Attachment[] => {
		if (message.type !== 'user' || !('content' in message)) return [];
		const list: Attachment[] = [];
		for (const block of message.content) {
			if (block.type !== 'image' && block.type !== 'document' && block.type !== 'file') continue;
			const number = block.index ?? list.length + 1;
			const fallbackName = `${block.type === 'image' ? 'image' : 'document'}-${number}.${block.mediaType.split('/')[1] || 'bin'}`;
			if (block.type === 'file') {
				list.push({ number, kind: 'file', name: block.title || fallbackName, mediaType: block.mediaType, size: block.size, path: block.path, context: block.source });
			} else {
				list.push({
					number,
					kind: block.type,
					name: block.title || fallbackName,
					mediaType: block.mediaType,
					size: block.data ? Math.floor(block.data.length * 0.75) : 0,
					data: block.data || undefined,
					// A message still on its way holds the document itself; its header says what it is.
					context: block.type === 'document' && block.data ? readContextHeaderFromBase64(block.data, block.mediaType) ?? undefined : undefined
				});
			}
		}
		return list;
	});

	let viewerOpen = $state(false);
	let viewerIndex = $state(0);
	const viewerItems = $derived<ViewerItem[]>(
		attachments.map((attachment) => ({
			name: attachment.name,
			mediaType: attachment.mediaType,
			size: attachment.size,
			number: attachment.number,
			base64: attachment.data,
			path: attachment.path
		}))
	);

	function openAttachment(number: number) {
		const index = attachments.findIndex((attachment) => attachment.number === number);
		if (index === -1 || (!attachments[index].data && !attachments[index].path)) return;
		viewerIndex = index;
		viewerOpen = true;
	}

	// `@N` in the text becomes a chip that opens that file. Done on the rendered
	// markdown, skipping code, so `@2` inside a snippet stays as written.

	function linkMentions(root: HTMLElement, numbers: Set<number>) {
		const highest = Math.max(0, ...numbers);
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode(node) {
				const parent = node.parentElement;
				if (!parent || parent.closest('code, pre, a, button')) return NodeFilter.FILTER_REJECT;
				return node.nodeValue?.includes('@') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
			}
		});
		const nodes: Text[] = [];
		while (walker.nextNode()) nodes.push(walker.currentNode as Text);
		for (const node of nodes) {
			const parts = splitMentions(node.nodeValue ?? '', highest);
			if (!parts.some((part) => typeof part === 'number' && numbers.has(part))) continue;
			const fragment = document.createDocumentFragment();
			for (const part of parts) {
				if (typeof part === 'number' && numbers.has(part)) {
					const chip = document.createElement('button');
					chip.type = 'button';
					chip.dataset.attachmentMention = String(part);
					chip.className = 'attachment-mention';
					chip.textContent = mentionToken(part);
					const named = attachments.find((attachment) => attachment.number === part);
					chip.title = named ? (named.context ? describeContext(named.context) : named.name) : '';
					fragment.append(chip);
				} else {
					fragment.append(String(part));
				}
			}
			node.replaceWith(fragment);
		}
	}

	/** Turns `@N` into chips in the text it wraps, once rendered. */
	function mentionLinks(node: HTMLElement, numbers: Set<number>) {
		queueMicrotask(() => linkMentions(node, numbers));
		return {
			update(next: Set<number>) {
				queueMicrotask(() => linkMentions(node, next));
			}
		};
	}

	const attachmentNumbers = $derived(new Set(attachments.map((attachment) => attachment.number)));

	function handleMentionClick(event: MouseEvent) {
		const chip = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-attachment-mention]');
		if (!chip) return;
		event.preventDefault();
		event.stopPropagation();
		openAttachment(Number(chip.dataset.attachmentMention));
	}
	
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
					const text = (contentItem as any).text as string;
					// Engine-setup errors route through ErrorMessage so they render
					// as an actionable card with a one-click button. These are only
					// ever surfaced as a synthetic assistant message prefixed with
					// "**Error:**" (see stream-manager). Requiring that prefix keeps
					// plain assistant prose that merely *mentions* "Settings → Stack /
					// Engines" from being misdetected as an error — it stays text.
					const isSyntheticError = typeof text === 'string' && /^\s*\*\*Error:\*\*/.test(text);
					if (isSyntheticError && (text.includes('Settings → Stack') || text.includes('Settings → Engines'))) {
						elements.push({ type: 'error', content: text.replace(/^\s*\*\*Error:\*\*\s*/, '') });
					} else {
						elements.push({ type: 'text', content: text });
					}
				} else if (contentItem.type === 'tool_use') {
					elements.push({ type: 'tool_use', content: contentItem });
				}
			}

			return elements;
		}

		// Handle user messages: the files together, then the text
		if (message.type === 'user' && 'content' in message) {
			if (message.content.some((block) => block.type === 'image' || block.type === 'document' || block.type === 'file')) {
				elements.push({ type: 'attachments' });
			}
			for (const contentItem of message.content) {
				if (contentItem.type === 'text') {
					elements.push({ type: 'text', content: (contentItem as any).text });
				}
			}

			return elements;
		}

		return elements;
	}
	
	// Main parsed content  
	const parsedElements = $derived.by(parseContent);
</script>

{#snippet attachmentCard(attachment: Attachment)}
	{@const viewable = !!attachment.data || !!attachment.path}
	<button
		type="button"
		onclick={() => openAttachment(attachment.number)}
		disabled={!viewable}
		class="relative w-28 h-28 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 transition-opacity focus:outline-none focus:ring-2 focus:ring-violet-500 enabled:cursor-pointer enabled:hover:opacity-80"
		title={attachment.context ? describeContext(attachment.context) : attachment.name}
		aria-label="View attachment {mentionToken(attachment.number)}, {attachment.context ? describeContext(attachment.context) : attachment.name}"
	>
		{#if attachment.kind === 'image' && attachment.data}
			<img
				src="data:{attachment.mediaType};base64,{attachment.data}"
				alt={attachment.name}
				class="absolute inset-0 w-full h-full object-cover"
				loading="lazy"
			/>
		{:else if attachment.context}
			<span class="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2">
				<Icon name={CONTEXT_ICONS[attachment.context.kind]} class="w-7 h-7 shrink-0 text-violet-600 dark:text-violet-400" />
				<span class="text-3xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 line-clamp-1 w-full px-1 text-center">
					{contextNoun(attachment.context.kind)}
				</span>
				<span class="text-xs font-medium text-slate-700 dark:text-slate-300 line-clamp-2 w-full px-1 text-center leading-tight break-all">
					{attachment.context.label}
				</span>
			</span>
		{:else}
			<span class="absolute inset-0 flex flex-col items-center justify-center gap-1.5 p-2">
				<Icon name={getAttachmentIcon(attachment.name, attachment.mediaType)} class="w-8 h-8 shrink-0" />
				<span class="text-xs font-medium text-slate-700 dark:text-slate-300 line-clamp-2 w-full px-1 text-center leading-tight break-all">
					{attachment.name}
				</span>
				{#if attachment.size}
					<span class="text-xs text-slate-500 dark:text-slate-400 -mt-0.5">{formatFileSize(attachment.size)}</span>
				{/if}
			</span>
		{/if}
		<span class="absolute top-1 left-1 px-1 rounded bg-violet-600 text-white text-3xs font-semibold leading-4 tabular-nums">
			{mentionToken(attachment.number)}
		</span>
	</button>
{/snippet}

{#each parsedElements as element}
	{#if element.type === 'error'}
		<ErrorMessage errorText={element.content} />
	{:else if element.type === 'attachments'}
		<div class="flex flex-wrap gap-2 mb-2">
			{#each attachments as attachment (attachment.number)}
				{@render attachmentCard(attachment)}
			{/each}
		</div>
	{:else if element.type === 'text'}
		{#if message.type === 'user' && attachments.length > 0}
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
			<div use:mentionLinks={attachmentNumbers} onclick={handleMentionClick}>
				<TextMessage content={element.content} />
			</div>
		{:else}
			<TextMessage content={element.content} />
		{/if}
	{:else if element.type === 'tool_use'}
		<Tools toolInput={element.content} />
	{/if}
{/each}

<!-- Viewer for the message's files -->
<Lightbox bind:isOpen={viewerOpen} bind:index={viewerIndex} items={viewerItems} onClose={() => (viewerOpen = false)} />

<style>
	:global(.attachment-mention) {
		display: inline-flex;
		align-items: center;
		padding: 0 0.3em;
		border-radius: 0.3em;
		background: rgb(124 58 237 / 0.12);
		color: rgb(109 40 217);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.9em;
		font-weight: 600;
		cursor: pointer;
	}

	:global(.attachment-mention:hover) {
		background: rgb(124 58 237 / 0.22);
	}

	:global(.dark .attachment-mention) {
		color: rgb(196 181 253);
		background: rgb(167 139 250 / 0.16);
	}
</style>
