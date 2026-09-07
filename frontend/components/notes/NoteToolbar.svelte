<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		editor: HTMLDivElement | null;
		onUploadClick?: () => void;
	}

	const { editor, onUploadClick }: Props = $props();

	/**
	 * Which formats apply to the caret right now.
	 *
	 * Without this the toolbar never says whether bold is on, so the only way to
	 * find out is to type and look. `queryCommandState` is deprecated alongside
	 * `execCommand`, but the two have to agree: reading state any other way would
	 * drift from what the buttons actually do.
	 */
	let active = $state<Record<string, boolean>>({});
	let block = $state('');

	function refreshState(): void {
		if (!editor) return;
		const selection = window.getSelection();
		const anchor = selection?.anchorNode;
		if (!anchor || !editor.contains(anchor)) return;

		const next: Record<string, boolean> = {};
		for (const command of [
			'bold',
			'italic',
			'underline',
			'strikeThrough',
			'insertUnorderedList',
			'insertOrderedList',
			'justifyLeft',
			'justifyCenter',
			'justifyRight'
		]) {
			try {
				next[command] = document.queryCommandState(command);
			} catch {
				next[command] = false;
			}
		}
		// `code` is a plain wrapper element, not an execCommand format, so it has
		// to be detected by walking up from the caret.
		const element = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as HTMLElement);
		next.code = !!element?.closest('code');
		active = next;

		try {
			block = document.queryCommandValue('formatBlock').toLowerCase();
		} catch {
			block = '';
		}
	}

	$effect(() => {
		const el = editor;
		if (!el) return;
		// `selectionchange` only fires on the document, and the caret also moves
		// through typing and clicks that never change the selection object.
		document.addEventListener('selectionchange', refreshState);
		el.addEventListener('input', refreshState);
		el.addEventListener('keyup', refreshState);
		el.addEventListener('mouseup', refreshState);
		return () => {
			document.removeEventListener('selectionchange', refreshState);
			el.removeEventListener('input', refreshState);
			el.removeEventListener('keyup', refreshState);
			el.removeEventListener('mouseup', refreshState);
		};
	});

	function exec(command: string, value?: string): void {
		if (!editor) return;
		editor.focus();
		// execCommand is deprecated but remains the only built-in that edits a
		// contenteditable without pulling in an editor framework.
		try {
			document.execCommand(command, false, value);
		} catch {
			// fallback no-op
		}
		refreshState();
	}

	function formatBlock(tag: string): void {
		// Pressing the active heading again returns the line to a paragraph,
		// otherwise there is no way back out of H1 from the toolbar.
		exec('formatBlock', block === tag ? '<p>' : `<${tag}>`);
	}

	function toggleInlineTag(tag: string): void {
		if (!editor) return;
		editor.focus();
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return;
		const range = sel.getRangeAt(0);
		if (range.collapsed) {
			// No selection: insert placeholder
			const el = document.createElement(tag);
			el.textContent = tag === 'code' ? 'code' : 'text';
			range.insertNode(el);
			// Select inserted content
			const newRange = document.createRange();
			newRange.selectNodeContents(el);
			sel.removeAllRanges();
			sel.addRange(newRange);
			refreshState();
			return;
		}
		// If selection already inside same tag, unwrap
		let ancestor: Node | null = range.commonAncestorContainer;
		if (ancestor.nodeType === Node.TEXT_NODE) ancestor = ancestor.parentNode;
		const tagEl = (ancestor as HTMLElement | null)?.closest?.(tag) as HTMLElement | null;
		if (tagEl && editor.contains(tagEl)) {
			// Unwrap: replace with its children
			const parent = tagEl.parentNode;
			if (parent) {
				while (tagEl.firstChild) parent.insertBefore(tagEl.firstChild, tagEl);
				parent.removeChild(tagEl);
			}
			refreshState();
			return;
		}
		const extracted = range.extractContents();
		const wrapper = document.createElement(tag);
		wrapper.appendChild(extracted);
		range.insertNode(wrapper);
		// Reselect
		const newRange = document.createRange();
		newRange.selectNodeContents(wrapper);
		sel.removeAllRanges();
		sel.addRange(newRange);
		refreshState();
	}

	// ---- Link ----

	let linkDialogOpen = $state(false);
	let linkUrl = $state('https://');
	let linkError = $state('');
	// The dialog's input steals focus and the caret with it, so the range the
	// link should wrap is captured before the dialog opens and put back after.
	let savedRange: Range | null = null;

	function openLinkDialog(): void {
		if (!editor) return;
		const sel = window.getSelection();
		savedRange =
			sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode)
				? sel.getRangeAt(0).cloneRange()
				: null;
		linkUrl = 'https://';
		linkError = '';
		linkDialogOpen = true;
	}

	function applyLink(value?: string): void {
		const url = (value ?? '').trim();
		// `createLink` will happily build `javascript:` and `data:` hrefs. They are
		// stripped again when the note is sanitized, so the only thing accepting
		// one achieves is a link that silently disappears on save.
		if (!/^https?:\/\/\S+/i.test(url)) {
			linkError = 'Enter a URL starting with http:// or https://';
			return;
		}
		linkDialogOpen = false;
		linkError = '';
		if (!editor) return;
		editor.focus();
		if (savedRange) {
			const sel = window.getSelection();
			sel?.removeAllRanges();
			sel?.addRange(savedRange);
			savedRange = null;
		}
		exec('createLink', url);
	}

	function handleCodeBlock(): void {
		if (!editor) return;
		editor.focus();
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) {
			document.execCommand('insertHTML', false, '<pre><code>code block</code></pre>');
			return;
		}
		const range = sel.getRangeAt(0);
		const selectedText = range.toString() || 'code block';
		document.execCommand('insertHTML', false, `<pre><code>${escapeHtml(selectedText)}</code></pre>`);
	}

	function escapeHtml(s: string): string {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	// Every control is the same 28px square so the icon and text buttons sit on
	// one baseline instead of the text ones setting their own height.
	const BTN =
		'flex items-center justify-center w-7 h-7 shrink-0 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors';
	const BTN_ON = 'bg-violet-500/15 text-violet-600 dark:text-violet-400';

	const iconButtons: { command: string; icon: IconName; label: string }[] = [
		{ command: 'bold', icon: 'lucide:bold', label: 'Bold' },
		{ command: 'italic', icon: 'lucide:italic', label: 'Italic' },
		{ command: 'underline', icon: 'lucide:underline', label: 'Underline' },
		{ command: 'strikeThrough', icon: 'lucide:strikethrough', label: 'Strikethrough' }
	];

	const listButtons: { command: string; icon: IconName; label: string }[] = [
		{ command: 'insertUnorderedList', icon: 'lucide:list', label: 'Bullet List' },
		{ command: 'insertOrderedList', icon: 'lucide:list-ordered', label: 'Numbered List' }
	];

	const alignButtons: { command: string; icon: IconName; label: string }[] = [
		{ command: 'justifyLeft', icon: 'lucide:align-left', label: 'Align Left' },
		{ command: 'justifyCenter', icon: 'lucide:align-center', label: 'Align Center' },
		{ command: 'justifyRight', icon: 'lucide:align-right', label: 'Align Right' }
	];
</script>

<div
	class="flex flex-wrap items-center gap-0.5 px-2 py-1.5 border-b border-slate-200 dark:border-slate-800"
	onmousedown={(e) => e.preventDefault()}
	role="toolbar"
	tabindex="-1"
	aria-label="Formatting"
>
	{#each iconButtons as button (button.command)}
		<button
			type="button"
			class="{BTN} {active[button.command] ? BTN_ON : ''}"
			title={button.label}
			aria-label={button.label}
			aria-pressed={active[button.command] ?? false}
			onclick={() => exec(button.command)}
		>
			<Icon name={button.icon} class="w-4 h-4" />
		</button>
	{/each}

	<span class="w-px h-5 bg-slate-200 dark:bg-slate-800 mx-1"></span>

	{#each ['h1', 'h2', 'h3'] as tag (tag)}
		<button
			type="button"
			class="{BTN} text-xs font-semibold {block === tag ? BTN_ON : ''}"
			title="Heading {tag.slice(1)}"
			aria-label="Heading {tag.slice(1)}"
			aria-pressed={block === tag}
			onclick={() => formatBlock(tag)}
		>
			{tag.toUpperCase()}
		</button>
	{/each}

	<span class="w-px h-5 bg-slate-200 dark:bg-slate-800 mx-1"></span>

	{#each listButtons as button (button.command)}
		<button
			type="button"
			class="{BTN} {active[button.command] ? BTN_ON : ''}"
			title={button.label}
			aria-label={button.label}
			aria-pressed={active[button.command] ?? false}
			onclick={() => exec(button.command)}
		>
			<Icon name={button.icon} class="w-4 h-4" />
		</button>
	{/each}
	<button type="button" class={BTN} title="Link" aria-label="Link" onclick={openLinkDialog}>
		<Icon name="lucide:link" class="w-4 h-4" />
	</button>
	<button
		type="button"
		class="{BTN} {active.code ? BTN_ON : ''}"
		title="Inline Code"
		aria-label="Inline Code"
		aria-pressed={active.code ?? false}
		onclick={() => toggleInlineTag('code')}
	>
		<Icon name="lucide:code" class="w-4 h-4" />
	</button>
	<button type="button" class={BTN} title="Code Block" aria-label="Code Block" onclick={handleCodeBlock}>
		<Icon name="lucide:code-xml" class="w-4 h-4" />
	</button>

	<span class="w-px h-5 bg-slate-200 dark:bg-slate-800 mx-1"></span>

	{#each alignButtons as button (button.command)}
		<button
			type="button"
			class="{BTN} {active[button.command] ? BTN_ON : ''}"
			title={button.label}
			aria-label={button.label}
			aria-pressed={active[button.command] ?? false}
			onclick={() => exec(button.command)}
		>
			<Icon name={button.icon} class="w-4 h-4" />
		</button>
	{/each}

	<span class="w-px h-5 bg-slate-200 dark:bg-slate-800 mx-1"></span>

	<button
		type="button"
		class={BTN}
		title="Upload Image"
		aria-label="Upload Image"
		onclick={() => onUploadClick?.()}
	>
		<Icon name="lucide:image" class="w-4 h-4" />
	</button>
</div>

<Dialog
	bind:isOpen={linkDialogOpen}
	onClose={() => {
		linkDialogOpen = false;
		linkError = '';
		savedRange = null;
	}}
	title="Insert link"
	message={linkError || 'The selected text will link to this address.'}
	type={linkError ? 'error' : 'info'}
	bind:inputValue={linkUrl}
	inputPlaceholder="https://example.com"
	confirmText="Insert"
	closeOnConfirm={false}
	onConfirm={applyLink}
/>
