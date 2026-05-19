<script lang="ts">
	import { marked, type Tokens } from 'marked';
	import { escapeHtml } from '$frontend/utils/terminal-formatter';
	import { onMount, tick } from 'svelte';

	interface Props {
		content: string;
		initialScrollPercent?: number;
		onScrollPercent?: (percent: number) => void;
		onFileLink?: (href: string) => void;
	}

	const { content, initialScrollPercent = 0, onScrollPercent, onFileLink }: Props = $props();

	const PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:/i;

	function isExternalUrl(href: string): boolean {
		return PROTOCOL_RE.test(href) || href.startsWith('//') || href.startsWith('mailto:');
	}

	marked.setOptions({
		breaks: true,
		gfm: true,
		async: false
	});

	const renderer = new marked.Renderer();

	function slugify(text: string): string {
		return text
			.toLowerCase()
			.trim()
			.replace(/[^\w\s-]/g, '')
			.replace(/\s+/g, '-')
			.replace(/-+/g, '-');
	}

	function extractText(tokens: Tokens.Generic[] | undefined): string {
		if (!tokens) return '';
		return tokens
			.map((t) => {
				if ('text' in t && typeof t.text === 'string') return t.text;
				if ('tokens' in t && t.tokens) return extractText(t.tokens as Tokens.Generic[]);
				return '';
			})
			.join('');
	}

	const usedHeadingIds = new Set<string>();

	renderer.heading = function (token) {
		const text = this.parser.parseInline(token.tokens);
		const raw = extractText(token.tokens as Tokens.Generic[]);
		let id = slugify(raw);
		if (!id) id = `heading-${token.depth}`;
		let unique = id;
		let n = 1;
		while (usedHeadingIds.has(unique)) {
			unique = `${id}-${n++}`;
		}
		usedHeadingIds.add(unique);
		return `<h${token.depth} id="${escapeHtml(unique)}">${text}</h${token.depth}>`;
	};

	renderer.html = function (token) {
		return escapeHtml(token.text);
	};

	renderer.code = function (token) {
		const code = escapeHtml(token.text);
		const language = token.lang || '';
		return `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${code}</code></pre>`;
	};

	renderer.codespan = function (token) {
		return `<code>${escapeHtml(token.text)}</code>`;
	};

	renderer.link = function (token) {
		const href = token.href || '';
		const text = this.parser.parseInline(token.tokens);
		const titleAttr = token.title ? ` title="${escapeHtml(token.title)}"` : '';
		const safeHref = escapeHtml(href);
		if (href.startsWith('#')) {
			return `<a href="${safeHref}" data-md-fragment="${escapeHtml(href.slice(1))}"${titleAttr}>${text}</a>`;
		}
		if (!isExternalUrl(href)) {
			return `<a href="${safeHref}" data-md-file="${safeHref}"${titleAttr}>${text}</a>`;
		}
		return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
	};

	renderer.table = function (token) {
		const headerCells = token.header
			.map((cell, i) => {
				const align = token.align[i] ? ` style="text-align:${token.align[i]}"` : '';
				return `<th${align}>${this.parser.parseInline(cell.tokens)}</th>`;
			})
			.join('');
		const headerRow = `<tr>${headerCells}</tr>`;

		const bodyRows = token.rows
			.map((row) => {
				const cells = row
					.map((cell, i) => {
						const align = token.align[i] ? ` style="text-align:${token.align[i]}"` : '';
						return `<td${align}>${this.parser.parseInline(cell.tokens)}</td>`;
					})
					.join('');
				return `<tr>${cells}</tr>`;
			})
			.join('');

		return `<div class="table-responsive"><table><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table></div>`;
	};

	const rendered = $derived.by(() => {
		usedHeadingIds.clear();
		return marked.parse(content || '', { renderer }) as string;
	});

	let container: HTMLDivElement | null = $state(null);
	let suppressScrollReport = false;

	function applyScrollPercent(percent: number) {
		if (!container) return;
		const max = container.scrollHeight - container.clientHeight;
		if (max <= 0) return;
		suppressScrollReport = true;
		container.scrollTop = Math.max(0, Math.min(1, percent)) * max;
		requestAnimationFrame(() => {
			suppressScrollReport = false;
		});
	}

	onMount(() => {
		(async () => {
			await tick();
			requestAnimationFrame(() => {
				requestAnimationFrame(() => applyScrollPercent(initialScrollPercent));
			});
		})();
	});

	function handleScroll(e: Event) {
		if (suppressScrollReport) return;
		const el = e.currentTarget as HTMLDivElement;
		const max = el.scrollHeight - el.clientHeight;
		if (max <= 0) return;
		onScrollPercent?.(Math.max(0, Math.min(1, el.scrollTop / max)));
	}

	function handleClick(e: MouseEvent) {
		const target = e.target as HTMLElement | null;
		if (!target || !container) return;

		const fileLink = target.closest('a[data-md-file]') as HTMLAnchorElement | null;
		if (fileLink) {
			e.preventDefault();
			const href = fileLink.getAttribute('data-md-file');
			if (href && onFileLink) onFileLink(href);
			return;
		}

		const fragmentLink = target.closest('a[data-md-fragment]') as HTMLAnchorElement | null;
		if (!fragmentLink) return;
		e.preventDefault();
		const id = fragmentLink.getAttribute('data-md-fragment');
		if (!id) return;
		let el: Element | null = null;
		try {
			el = container.querySelector(`#${CSS.escape(id)}`);
		} catch {
			el = null;
		}
		if (!el) {
			const lowered = id.toLowerCase();
			el = container.querySelector(`[id="${lowered}"]`);
		}
		if (el && 'scrollIntoView' in el) {
			(el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
	}

	export function getScrollPercent(): number {
		if (!container) return 0;
		const max = container.scrollHeight - container.clientHeight;
		if (max <= 0) return 0;
		return Math.max(0, Math.min(1, container.scrollTop / max));
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
	bind:this={container}
	class="markdown-preview h-full overflow-auto px-6 py-5"
	onscroll={handleScroll}
	onclick={handleClick}
>
	{@html rendered}
</div>

<style>
	:global(.markdown-preview) {
		color: rgb(30 41 59);
		line-height: 1.6;
		font-size: 0.9rem;
	}

	:global(.dark .markdown-preview) {
		color: rgb(226 232 240);
	}

	:global(.markdown-preview *:first-child) {
		margin-top: 0;
	}

	:global(.markdown-preview *:last-child) {
		margin-bottom: 0;
	}

	:global(.markdown-preview h1) {
		font-size: 1.875rem;
		font-weight: 700;
		margin-top: 1.5rem;
		margin-bottom: 1rem;
		padding-bottom: 0.4rem;
		border-bottom: 1px solid rgb(226 232 240);
		color: rgb(15 23 42);
	}

	:global(.dark .markdown-preview h1) {
		color: rgb(241 245 249);
		border-bottom-color: rgb(51 65 85);
	}

	:global(.markdown-preview h2) {
		font-size: 1.5rem;
		font-weight: 700;
		margin-top: 1.5rem;
		margin-bottom: 0.75rem;
		padding-bottom: 0.3rem;
		border-bottom: 1px solid rgb(226 232 240);
		color: rgb(15 23 42);
	}

	:global(.dark .markdown-preview h2) {
		color: rgb(241 245 249);
		border-bottom-color: rgb(51 65 85);
	}

	:global(.markdown-preview h3) {
		font-size: 1.25rem;
		font-weight: 700;
		margin-top: 1.25rem;
		margin-bottom: 0.5rem;
		color: rgb(15 23 42);
	}

	:global(.dark .markdown-preview h3) {
		color: rgb(241 245 249);
	}

	:global(.markdown-preview h4),
	:global(.markdown-preview h5),
	:global(.markdown-preview h6) {
		font-size: 1rem;
		font-weight: 700;
		margin-top: 1rem;
		margin-bottom: 0.5rem;
		color: rgb(15 23 42);
	}

	:global(.dark .markdown-preview h4),
	:global(.dark .markdown-preview h5),
	:global(.dark .markdown-preview h6) {
		color: rgb(241 245 249);
	}

	:global(.markdown-preview p) {
		margin-bottom: 1rem;
	}

	:global(.markdown-preview a) {
		color: rgb(37 99 235);
		text-decoration: underline;
	}

	:global(.dark .markdown-preview a) {
		color: rgb(96 165 250);
	}

	:global(.markdown-preview a:hover) {
		color: rgb(29 78 216);
	}

	:global(.dark .markdown-preview a:hover) {
		color: rgb(147 197 253);
	}

	:global(.markdown-preview code) {
		background-color: rgb(248 250 252);
		color: rgb(51 65 85);
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		font-family: 'SF Mono', Monaco, Consolas, monospace;
		font-size: 0.85em;
	}

	:global(.dark .markdown-preview code) {
		background-color: rgb(30 41 59);
		color: rgb(203 213 225);
	}

	:global(.markdown-preview pre) {
		background-color: rgb(248 250 252);
		color: rgb(51 65 85);
		padding: 0.75rem 1rem;
		border-radius: 0.5rem;
		overflow-x: auto;
		margin: 1rem 0;
		border: 1px solid rgb(226 232 240);
		font-size: 0.85rem;
	}

	:global(.dark .markdown-preview pre) {
		background-color: rgb(30 41 59);
		color: rgb(203 213 225);
		border-color: rgb(51 65 85);
	}

	:global(.markdown-preview pre code) {
		background-color: transparent;
		padding: 0;
		border-radius: 0;
		color: inherit;
	}

	:global(.markdown-preview strong) {
		font-weight: 700;
		color: rgb(15 23 42);
	}

	:global(.dark .markdown-preview strong) {
		color: rgb(241 245 249);
	}

	:global(.markdown-preview em) {
		font-style: italic;
	}

	:global(.markdown-preview blockquote) {
		border-left: 0.25rem solid rgb(203 213 225);
		padding-left: 1rem;
		color: rgb(100 116 139);
		margin: 1rem 0;
	}

	:global(.dark .markdown-preview blockquote) {
		border-left-color: rgb(100 116 139);
		color: rgb(148 163 184);
	}

	:global(.markdown-preview ul) {
		list-style-type: disc;
		margin-left: 1.5rem;
		margin-bottom: 1rem;
	}

	:global(.markdown-preview ol) {
		list-style-type: decimal;
		margin-left: 1.5rem;
		margin-bottom: 1rem;
	}

	:global(.markdown-preview li) {
		margin-bottom: 0.25rem;
	}

	:global(.markdown-preview li > ul),
	:global(.markdown-preview li > ol) {
		margin-bottom: 0.25rem;
	}

	:global(.markdown-preview hr) {
		border: 0;
		border-top: 1px solid rgb(226 232 240);
		margin: 1.5rem 0;
	}

	:global(.dark .markdown-preview hr) {
		border-top-color: rgb(51 65 85);
	}

	:global(.markdown-preview .table-responsive) {
		overflow-x: auto;
		margin: 1rem 0;
		border-radius: 0.5rem;
		border: 1px solid rgb(226 232 240);
	}

	:global(.dark .markdown-preview .table-responsive) {
		border-color: rgb(51 65 85);
	}

	:global(.markdown-preview table) {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	:global(.markdown-preview th),
	:global(.markdown-preview td) {
		border: 1px solid rgb(226 232 240);
		padding: 0.5rem 0.75rem;
	}

	:global(.dark .markdown-preview th),
	:global(.dark .markdown-preview td) {
		border-color: rgb(51 65 85);
	}

	:global(.markdown-preview th) {
		background-color: rgb(248 250 252);
		font-weight: 600;
		text-align: left;
		color: rgb(51 65 85);
	}

	:global(.dark .markdown-preview th) {
		background-color: rgb(30 41 59);
		color: rgb(203 213 225);
	}

	:global(.markdown-preview tbody tr:nth-child(even)) {
		background-color: rgb(248 250 252);
	}

	:global(.dark .markdown-preview tbody tr:nth-child(even)) {
		background-color: rgb(30 41 59 / 0.5);
	}

	:global(.markdown-preview img) {
		max-width: 100%;
		height: auto;
		border-radius: 0.25rem;
		margin: 1rem 0;
	}

	:global(.markdown-preview input[type='checkbox']) {
		margin-right: 0.4rem;
	}
</style>
