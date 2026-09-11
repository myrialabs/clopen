<script lang="ts">
	/**
	 * A markdown composer, in the shape the providers themselves use: a toolbar
	 * over a Write / Preview pair.
	 *
	 * WHY NOT THE NOTES EDITOR. Notes is a contenteditable HTML editor whose
	 * attachments live in Clopen's own image store. An issue comment is
	 * MARKDOWN, sent verbatim to a service other people read in a browser, so
	 * HTML would have to be converted on the way out and the conversion is where
	 * the fidelity goes. Formatting here writes markdown directly, and Preview
	 * renders it through the same `Markdown` surface the chat uses — so what you
	 * see is what the provider will be given, not an approximation of it.
	 *
	 * IMAGES. There is no API for attaching a file to a comment: GitHub's own
	 * upload endpoint is private to github.com and not part of the REST API.
	 * Storing the bytes in Clopen instead would produce a link that only works
	 * on this machine — a broken image for every other person on the thread — so
	 * this offers image-by-URL, which does work, and says plainly what it cannot
	 * do rather than silently producing something broken.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Markdown from '$frontend/components/common/display/Markdown.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		value: string;
		placeholder?: string;
		minRows?: number;
		/** Shown next to the tabs — the item's web URL, for the image notice. */
		itemUrl?: string;
		onInput: (value: string) => void;
		onSubmit?: () => void;
	}

	const {
		value,
		placeholder = 'Leave a comment…',
		minRows = 4,
		itemUrl,
		onInput,
		onSubmit
	}: Props = $props();

	let mode = $state<'write' | 'preview'>('write');
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let imageNotice = $state(false);

	interface ToolbarAction {
		id: string;
		label: string;
		icon: IconName;
		run: () => void;
	}

	/**
	 * Wrap or unwrap the selection.
	 *
	 * Unwrapping matters more than it looks: a toolbar that only ever adds
	 * markers turns a mis-click into a cleanup job, and bold-then-bold-again is
	 * the first thing anyone tries.
	 */
	function surround(marker: string, endMarker = marker): void {
		const el = textarea;
		if (!el) return;

		const start = el.selectionStart;
		const end = el.selectionEnd;
		const selected = value.slice(start, end);

		const before = value.slice(0, start);
		const after = value.slice(end);

		if (before.endsWith(marker) && after.startsWith(endMarker)) {
			const next = before.slice(0, -marker.length) + selected + after.slice(endMarker.length);
			onInput(next);
			restore(start - marker.length, end - marker.length);
			return;
		}

		onInput(`${before}${marker}${selected}${endMarker}${after}`);
		restore(start + marker.length, end + marker.length);
	}

	/** Prefix every selected line, or the caret's line when nothing is selected. */
	function prefixLines(prefix: string | ((index: number) => string)): void {
		const el = textarea;
		if (!el) return;

		const start = value.lastIndexOf('\n', el.selectionStart - 1) + 1;
		const rawEnd = value.indexOf('\n', el.selectionEnd);
		const end = rawEnd === -1 ? value.length : rawEnd;

		const lines = value.slice(start, end).split('\n');
		const rendered = lines
			.map((line, index) => `${typeof prefix === 'string' ? prefix : prefix(index)}${line}`)
			.join('\n');

		onInput(value.slice(0, start) + rendered + value.slice(end));
		restore(start, start + rendered.length);
	}

	function insert(text: string): void {
		const el = textarea;
		if (!el) return;
		const start = el.selectionStart;
		const end = el.selectionEnd;
		onInput(value.slice(0, start) + text + value.slice(end));
		restore(start + text.length, start + text.length);
	}

	/**
	 * Put the caret back after a value change.
	 *
	 * The parent owns `value`, so the textarea re-renders and the browser drops
	 * the selection to the end — which makes every toolbar press lose the user's
	 * place. The restore has to wait for that render, hence the frame.
	 */
	function restore(start: number, end: number): void {
		requestAnimationFrame(() => {
			const el = textarea;
			if (!el) return;
			el.focus();
			el.setSelectionRange(start, end);
		});
	}

	/**
	 * Asking for a URL, in the page rather than in a `window.prompt`.
	 *
	 * A native prompt is a modal the browser draws: it ignores the theme, cannot
	 * be styled, is suppressed outright in some embeddings, and stacked on top
	 * of a modal it reads as a browser error rather than as part of the form.
	 * The selection has to be remembered because focus moves to the field, and
	 * the textarea forgets where the caret was the moment it loses it.
	 */
	let urlPrompt = $state<{ kind: 'link' | 'image'; start: number; end: number } | null>(null);
	let urlDraft = $state('');
	let urlField = $state<HTMLInputElement | null>(null);

	function askForUrl(kind: 'link' | 'image'): void {
		const el = textarea;
		if (!el) return;
		urlPrompt = { kind, start: el.selectionStart, end: el.selectionEnd };
		urlDraft = '';
		// After the field exists, not before — this runs while it is still being
		// rendered by the `{#if}` below.
		requestAnimationFrame(() => urlField?.focus());
	}

	function confirmUrl(): void {
		const prompt = urlPrompt;
		const url = urlDraft.trim();
		urlPrompt = null;
		if (!prompt || !url) return;

		const selected = value.slice(prompt.start, prompt.end);
		const markdown = prompt.kind === 'link'
			? `[${selected || 'link text'}](${url})`
			: `![${selected || ''}](${url})`;

		onInput(value.slice(0, prompt.start) + markdown + value.slice(prompt.end));
		restore(prompt.start + markdown.length, prompt.start + markdown.length);
	}

	const ACTIONS: ToolbarAction[] = [
		{ id: 'heading', label: 'Heading', icon: 'lucide:heading', run: () => prefixLines('### ') },
		{ id: 'bold', label: 'Bold', icon: 'lucide:bold', run: () => surround('**') },
		{ id: 'italic', label: 'Italic', icon: 'lucide:italic', run: () => surround('_') },
		{ id: 'strike', label: 'Strikethrough', icon: 'lucide:strikethrough', run: () => surround('~~') },
		{ id: 'code', label: 'Inline code', icon: 'lucide:code', run: () => surround('`') },
		{ id: 'block', label: 'Code block', icon: 'lucide:square-code', run: () => surround('\n```\n', '\n```\n') },
		{ id: 'quote', label: 'Quote', icon: 'lucide:quote', run: () => prefixLines('> ') },
		{ id: 'ul', label: 'Bulleted list', icon: 'lucide:list', run: () => prefixLines('- ') },
		{ id: 'ol', label: 'Numbered list', icon: 'lucide:list-ordered', run: () => prefixLines((index) => `${index + 1}. `) },
		{ id: 'task', label: 'Task list', icon: 'lucide:list-checks', run: () => prefixLines('- [ ] ') },
		{ id: 'link', label: 'Link', icon: 'lucide:link', run: () => askForUrl('link') },
		{ id: 'image', label: 'Image by URL', icon: 'lucide:image', run: () => askForUrl('image') }
	];

	function handleKeydown(event: KeyboardEvent): void {
		const meta = event.metaKey || event.ctrlKey;

		// The shortcuts everyone tries first. Enter is deliberately NOT a submit
		// here: a comment is prose, and losing a paragraph to a stray Enter is a
		// worse failure than having to reach for the button.
		if (meta && event.key === 'b') {
			event.preventDefault();
			surround('**');
			return;
		}
		if (meta && event.key === 'i') {
			event.preventDefault();
			surround('_');
			return;
		}
		if (meta && event.key === 'Enter') {
			event.preventDefault();
			onSubmit?.();
		}
	}

	/** An image arriving by paste or drop is the moment to explain the limit. */
	function handleImageDrop(event: DragEvent): void {
		const hasFile = Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === 'file');
		if (!hasFile) return;
		event.preventDefault();
		imageNotice = true;
	}

	function handlePaste(event: ClipboardEvent): void {
		const hasImage = Array.from(event.clipboardData?.items ?? []).some((item) =>
			item.type.startsWith('image/'));
		if (!hasImage) return;
		event.preventDefault();
		imageNotice = true;
	}
</script>

<div class="flex flex-col rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden focus-within:border-violet-500">
	<div class="flex items-center gap-1 px-1.5 py-1 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
		<div class="flex items-center gap-0.5">
			<button
				type="button"
				class="h-7 px-2 text-xs font-medium rounded-md border bg-transparent cursor-pointer transition-colors duration-150
					{mode === 'write'
					? 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-slate-900 dark:text-slate-100'
					: 'border-transparent text-slate-500 dark:text-slate-400 hover:bg-violet-500/10'}"
				onclick={() => (mode = 'write')}
			>
				Write
			</button>
			<button
				type="button"
				class="h-7 px-2 text-xs font-medium rounded-md border bg-transparent cursor-pointer transition-colors duration-150
					{mode === 'preview'
					? 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-slate-900 dark:text-slate-100'
					: 'border-transparent text-slate-500 dark:text-slate-400 hover:bg-violet-500/10'}"
				onclick={() => (mode = 'preview')}
			>
				Preview
			</button>
		</div>

		<span class="w-px h-4 mx-1 bg-slate-200 dark:bg-slate-700"></span>

		<div class="flex items-center gap-0.5 flex-wrap">
			{#each ACTIONS as action (action.id)}
				<button
					type="button"
					class="flex items-center justify-center w-7 h-7 bg-transparent border-none rounded-md text-slate-500 dark:text-slate-400 cursor-pointer transition-colors duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-40"
					disabled={mode === 'preview'}
					onclick={action.run}
					aria-label={action.label}
					title={action.label}
				>
					<Icon name={action.icon} class="w-3.5 h-3.5" />
				</button>
			{/each}
		</div>
	</div>

	{#if urlPrompt}
		<div class="flex items-center gap-1.5 px-1.5 py-1.5 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
			<Icon
				name={urlPrompt.kind === 'link' ? 'lucide:link' : 'lucide:image'}
				class="w-3.5 h-3.5 shrink-0 text-slate-500"
			/>
			<input
				bind:this={urlField}
				type="url"
				class="flex-1 min-w-0 h-7 px-2 text-xs bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
				placeholder="https://"
				value={urlDraft}
				oninput={(event) => (urlDraft = event.currentTarget.value)}
				onkeydown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						confirmUrl();
					}
					if (event.key === 'Escape') {
						event.preventDefault();
						urlPrompt = null;
					}
				}}
			/>
			<button
				type="button"
				class="h-7 px-2 text-xs font-semibold bg-violet-600 hover:bg-violet-700 border-none rounded-md text-white cursor-pointer disabled:opacity-50"
				disabled={!urlDraft.trim()}
				onclick={confirmUrl}
			>
				Insert
			</button>
			<button
				type="button"
				class="h-7 px-2 text-xs bg-transparent border-none rounded-md text-slate-500 dark:text-slate-400 cursor-pointer hover:bg-violet-500/10"
				onclick={() => (urlPrompt = null)}
			>
				Cancel
			</button>
		</div>
	{/if}

	{#if mode === 'write'}
		<textarea
			bind:this={textarea}
			class="w-full px-3 py-2 text-sm leading-6 bg-transparent border-none text-slate-900 dark:text-slate-100 resize-y focus:outline-none"
			rows={minRows}
			{placeholder}
			{value}
			oninput={(event) => onInput(event.currentTarget.value)}
			onkeydown={handleKeydown}
			ondragover={(event) => event.preventDefault()}
			ondrop={handleImageDrop}
			onpaste={handlePaste}
		></textarea>
	{:else}
		<!-- Matched to the textarea it replaces, so toggling does not resize the card. -->
		<div class="px-3 py-2 overflow-y-auto" style="min-height: {minRows * 1.5}rem; max-height: 32rem;">
			{#if value.trim()}
				<Markdown content={value} variant="chat" />
			{:else}
				<p class="text-sm italic text-slate-500 dark:text-slate-500 m-0">Nothing to preview yet.</p>
			{/if}
		</div>
	{/if}

	{#if imageNotice}
		<div class="flex items-start gap-2 px-3 py-2 border-t border-amber-500/30 bg-amber-500/10">
			<Icon name="lucide:image-off" class="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
			<p class="flex-1 text-xs text-amber-800 dark:text-amber-300 m-0">
				Attaching a file is not something the API can do — the upload endpoint behind
				drag-and-drop on the web is private to the provider. Use the image button to link one
				by URL{#if itemUrl}, or
				<a href={itemUrl} target="_blank" rel="noreferrer noopener" class="underline">
					open this item in the browser</a>
				and drop it there{/if}.
			</p>
			<button
				type="button"
				class="shrink-0 w-6 h-6 flex items-center justify-center bg-transparent border-none rounded text-amber-700 dark:text-amber-400 cursor-pointer hover:bg-amber-500/20"
				onclick={() => (imageNotice = false)}
				aria-label="Dismiss"
			>
				<Icon name="lucide:x" class="w-3.5 h-3.5" />
			</button>
		</div>
	{/if}
</div>
