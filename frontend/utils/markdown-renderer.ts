// Shared markdown rendering for the whole app (chat messages, file markdown preview, settings
// release notes). `renderMarkdown` is the single entry point: it builds a marked renderer from the
// common token helpers so code, tables, headings, and links render identically everywhere. The
// only per-consumer knobs are the RenderMarkdownOptions below; the click behavior of the emitted
// [data-md-file] / [data-md-fragment] links is wired in each component (DOM concern, not rendering).

import { marked, type Token, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import { escapeHtml, hasAnsiCodes, processAnsiCodes, formatTerminalOutput } from './terminal-formatter';

type InlineParser = { parseInline(tokens: Token[]): string };

// Apply the marked options shared by every consumer.
export function configureMarked(): void {
	marked.setOptions({ breaks: true, gfm: true, async: false });
}

// Render a fenced code block. With `ansi: true`, ANSI escape sequences are converted to
// styled spans (processAnsiCodes escapes HTML itself, so no double-escape); otherwise the
// code is plain HTML-escaped.
export function renderCodeBlock(
	token: { text: string; lang?: string },
	options?: { ansi?: boolean }
): string {
	const language = token.lang || '';
	const code =
		options?.ansi && hasAnsiCodes(token.text)
			? processAnsiCodes(token.text)
			: escapeHtml(token.text);
	return `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${code}</code></pre>`;
}

// Render inline code, escaping HTML.
export function renderInlineCode(token: { text: string }): string {
	return `<code>${escapeHtml(token.text)}</code>`;
}

// Render a table wrapped in a responsive scroll container. `parser` is the renderer's parser
// (`this.parser`), used to render inline content inside cells.
export function renderTable(token: Tokens.Table, parser: InlineParser): string {
	const headerCells = token.header
		.map((cell, i) => {
			const align = token.align[i] ? ` style="text-align:${token.align[i]}"` : '';
			return `<th${align}>${parser.parseInline(cell.tokens)}</th>`;
		})
		.join('');
	const headerRow = `<tr>${headerCells}</tr>`;

	const bodyRows = token.rows
		.map((row) => {
			const cells = row
				.map((cell, i) => {
					const align = token.align[i] ? ` style="text-align:${token.align[i]}"` : '';
					return `<td${align}>${parser.parseInline(cell.tokens)}</td>`;
				})
				.join('');
			return `<tr>${cells}</tr>`;
		})
		.join('');

	return `<div class="table-responsive"><table><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table></div>`;
}

// --- Link classification (shared by every consumer) ---

const PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:/i;

// A link is "external" when it carries an explicit scheme/host — it opens in a new tab.
function isExternalUrl(href: string): boolean {
	return PROTOCOL_RE.test(href) || href.startsWith('//') || href.startsWith('mailto:');
}

// Detect URLs that point to a local absolute file path served by the current host (e.g.
// http://localhost/Users/...). Returns the resolved file path if matched, otherwise null, so
// same-host file links resolve to a Files-panel target instead of opening a new tab.
function matchLocalFilePath(href: string): string | null {
	try {
		const url = new URL(href, window.location.origin);
		const sameHost =
			url.hostname === window.location.hostname ||
			url.hostname === 'localhost' ||
			url.hostname === '127.0.0.1';
		if (!sameHost) return null;
		const path = decodeURIComponent(url.pathname);
		// Unix-style absolute file path
		if (/^\/(Users|home|tmp|opt|var|root|mnt|private|etc)\//.test(path)) return path;
		// Windows-style /C:/...
		const winMatch = path.match(/^\/([A-Za-z]):\/(.*)$/);
		if (winMatch) return `${winMatch[1]}:/${winMatch[2]}`;
		return null;
	} catch {
		return null;
	}
}

// --- Heading id generation (used for in-document scroll anchors) ---

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

export interface RenderMarkdownOptions {
	// How raw inline HTML is handled. 'sanitize' keeps safe tags via DOMPurify (so <img>,
	// <details>, etc. render — right for file previews and release notes); 'escape' shows tags
	// literally (right for chat, where unknown pseudo-tags like <thinking> must stay visible).
	// Default 'sanitize'.
	html?: 'sanitize' | 'escape';
}

// Single entry point for rendering markdown to an HTML string. Links are classified uniformly:
// external → new tab; '#frag' → [data-md-fragment]; local/relative → [data-md-file]. Consumers
// wire what a [data-md-file] click does (reveal in Files panel, open in preview, etc.).
export function renderMarkdown(content: string, options: RenderMarkdownOptions = {}): string {
	const { html = 'sanitize' } = options;

	configureMarked();

	// Preserve a genuine terminal dump (ANSI-colored output) as monospace, since markdown would
	// collapse its alignment. ANSI escape codes never occur in real markdown prose, so this is the
	// ONLY trigger — markdown is never forced into a raw block by prose syntax like '#' or '>'.
	// (Fenced content is left to the normal code-block path.)
	if (hasAnsiCodes(content) && !content.includes('```')) {
		return formatTerminalOutput(content);
	}

	const renderer = new marked.Renderer();
	const usedHeadingIds = new Set<string>();

	renderer.html =
		html === 'escape'
			? (token) => escapeHtml(token.text)
			: (token) => DOMPurify.sanitize(token.text, { USE_PROFILES: { html: true } });

	// ANSI is only processed when actually present, so `ansi: true` is a no-op for plain code.
	renderer.code = (token) => renderCodeBlock(token, { ansi: true });
	renderer.codespan = (token) => renderInlineCode(token);

	renderer.heading = function (token) {
		const text = this.parser.parseInline(token.tokens);
		const raw = extractText(token.tokens as Tokens.Generic[]);
		const base = slugify(raw) || `heading-${token.depth}`;
		let unique = base;
		let n = 1;
		while (usedHeadingIds.has(unique)) unique = `${base}-${n++}`;
		usedHeadingIds.add(unique);
		return `<h${token.depth} id="${escapeHtml(unique)}">${text}</h${token.depth}>`;
	};

	renderer.link = function (token) {
		const href = token.href || '';
		const text = this.parser.parseInline(token.tokens);
		const titleAttr = token.title ? ` title="${escapeHtml(token.title)}"` : '';
		if (href.startsWith('#')) {
			return `<a href="${escapeHtml(href)}" data-md-fragment="${escapeHtml(href.slice(1))}"${titleAttr}>${text}</a>`;
		}
		const localPath = matchLocalFilePath(href);
		if (localPath) {
			return `<a href="${escapeHtml(href)}" data-md-file="${escapeHtml(localPath)}"${titleAttr}>${text}</a>`;
		}
		if (!isExternalUrl(href)) {
			const safeHref = escapeHtml(href);
			return `<a href="${safeHref}" data-md-file="${safeHref}"${titleAttr}>${text}</a>`;
		}
		return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
	};

	renderer.table = function (token) {
		return renderTable(token, this.parser);
	};

	return marked.parse(content, { renderer }) as string;
}

export interface MarkdownClickHandlers {
	// Invoked when an internal file link (rendered as [data-md-file]) is clicked. If omitted, such
	// clicks are ignored. Fragment links ([data-md-fragment]) are handled internally.
	onFileLink?: (path: string) => void;
}

// Delegated click handler for the links produced by renderMarkdown. Finds the clicked
// [data-md-file] / [data-md-fragment] anchor and handles it: fragment links scroll to the matching
// heading within the container the listener is bound to; file links are dispatched to onFileLink so
// the caller decides the action (reveal in Files panel, open in preview, ...). Bind this to the
// element that wraps the rendered markdown (its currentTarget is used as the scroll scope).
export function dispatchMarkdownClick(event: MouseEvent, handlers: MarkdownClickHandlers = {}): void {
	const target = event.target as HTMLElement | null;
	if (!target) return;

	const fileLink = target.closest('a[data-md-file]') as HTMLElement | null;
	if (fileLink) {
		const path = fileLink.getAttribute('data-md-file');
		if (path && handlers.onFileLink) {
			event.preventDefault();
			handlers.onFileLink(path);
		}
		return;
	}

	const fragmentLink = target.closest('a[data-md-fragment]') as HTMLElement | null;
	if (fragmentLink) {
		const id = fragmentLink.getAttribute('data-md-fragment');
		if (!id) return;
		event.preventDefault();
		scrollToFragment(id, event.currentTarget as HTMLElement | null);
	}
}

// Scroll to the heading with the given id within `root`. Falls back to a lowercased lookup because
// heading anchors are slugified to lowercase.
function scrollToFragment(id: string, root: HTMLElement | null): void {
	const scope: ParentNode = root ?? document;
	let el: Element | null = null;
	try {
		el = scope.querySelector(`#${CSS.escape(id)}`);
	} catch {
		el = null;
	}
	if (!el) el = scope.querySelector(`[id="${id.toLowerCase()}"]`);
	if (el && 'scrollIntoView' in el) {
		(el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
	}
}
