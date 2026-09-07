<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';

	interface Props {
		editor: HTMLDivElement | null;
		onUploadClick?: () => void;
	}

	const { editor, onUploadClick }: Props = $props();

	function exec(command: string, value?: string): void {
		if (!editor) return;
		editor.focus();
		// execCommand is deprecated but still the simplest for contenteditable without extra deps
		// Keep for bold/italic/underline/strike/lists/link
		try {
			document.execCommand(command, false, value);
		} catch {
			// fallback no-op
		}
	}

	function formatBlock(tag: string): void {
		exec('formatBlock', `<${tag}>`);
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
			return;
		}
		// If selection already inside same tag, unwrap
		let ancestor: Node | null = range.commonAncestorContainer;
		if (ancestor.nodeType === 3) ancestor = ancestor.parentNode;
		const tagEl = (ancestor as HTMLElement | null)?.closest?.(tag) as HTMLElement | null;
		if (tagEl && editor.contains(tagEl)) {
			// Unwrap: replace with its children
			const parent = tagEl.parentNode;
			if (parent) {
				while (tagEl.firstChild) parent.insertBefore(tagEl.firstChild, tagEl);
				parent.removeChild(tagEl);
			}
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
	}

	function handleLink(): void {
		if (!editor) return;
		const url = prompt('Enter URL:', 'https://example.com');
		if (!url) return;
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
		const html = `<pre><code>${escapeHtml(selectedText)}</code></pre>`;
		document.execCommand('insertHTML', false, html);
	}

	function escapeHtml(s: string): string {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}
</script>

<div
	class="flex flex-wrap items-center gap-1 p-2 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800"
	onmousedown={(e) => e.preventDefault()}
>
	<button type="button" class="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300" title="Bold" aria-label="Bold" onclick={() => exec('bold')}>
		<Icon name="lucide:bold" class="w-4 h-4" />
	</button>
	<button type="button" class="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300" title="Italic" aria-label="Italic" onclick={() => exec('italic')}>
		<Icon name="lucide:italic" class="w-4 h-4" />
	</button>
	<button type="button" class="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300" title="Underline" aria-label="Underline" onclick={() => exec('underline')}>
		<Icon name="lucide:underline" class="w-4 h-4" />
	</button>
	<button type="button" class="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300" title="Strikethrough" aria-label="Strikethrough" onclick={() => exec('strikeThrough')}>
		<Icon name="lucide:strikethrough" class="w-4 h-4" />
	</button>

	<span class="w-px h-5 bg-slate-200 dark:bg-slate-800 mx-1"></span>

	<button type="button" class="px-1.5 py-1 text-xs font-semibold rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300" title="Heading 1" onclick={() => formatBlock('h1')}>H1</button>
	<button type="button" class="px-1.5 py-1 text-xs font-semibold rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300" title="Heading 2" onclick={() => formatBlock('h2')}>H2</button>
	<button type="button" class="px-1.5 py-1 text-xs font-semibold rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300" title="Heading 3" onclick={() => formatBlock('h3')}>H3</button>

	<span class="w-px h-5 bg-slate-200 dark:bg-slate-800 mx-1"></span>

	<button type="button" class="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300" title="Bullet List" onclick={() => exec('insertUnorderedList')}>
		<Icon name="lucide:list" class="w-4 h-4" />
	</button>
	<button type="button" class="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300" title="Numbered List" onclick={() => exec('insertOrderedList')}>
		<Icon name="lucide:list-ordered" class="w-4 h-4" />
	</button>
	<button type="button" class="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300" title="Link" onclick={handleLink}>
		<Icon name="lucide:link" class="w-4 h-4" />
	</button>
	<button type="button" class="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300" title="Inline Code" onclick={() => toggleInlineTag('code')}>
		<Icon name="lucide:code" class="w-4 h-4" />
	</button>
	<button type="button" class="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300" title="Code Block" onclick={handleCodeBlock}>
		<Icon name="lucide:code-xml" class="w-4 h-4" />
	</button>

	<span class="w-px h-5 bg-slate-200 dark:bg-slate-800 mx-1"></span>

	<button type="button" class="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300" title="Align Left" aria-label="Align Left" onclick={() => exec('justifyLeft')}>
		<Icon name="lucide:align-left" class="w-4 h-4" />
	</button>
	<button type="button" class="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300" title="Align Center" aria-label="Align Center" onclick={() => exec('justifyCenter')}>
		<Icon name="lucide:align-center" class="w-4 h-4" />
	</button>
	<button type="button" class="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300" title="Align Right" aria-label="Align Right" onclick={() => exec('justifyRight')}>
		<Icon name="lucide:align-right" class="w-4 h-4" />
	</button>

	<span class="w-px h-5 bg-slate-200 dark:bg-slate-800 mx-1"></span>

	<button type="button" class="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300" title="Upload Image" aria-label="Upload Image" onclick={() => onUploadClick?.()}>
		<Icon name="lucide:image" class="w-4 h-4" />
	</button>
</div>
