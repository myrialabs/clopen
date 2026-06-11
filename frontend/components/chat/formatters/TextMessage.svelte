<script lang="ts">
	import { marked } from 'marked';
	import {
		hasAnsiCodes,
		isTerminalOutput,
		formatTerminalOutput,
		escapeHtml
	} from '$frontend/utils/terminal-formatter';
	import {
		configureMarked,
		renderCodeBlock,
		renderInlineCode,
		renderTable
	} from '$frontend/utils/markdown-renderer';
	import { requestRevealFile } from '$frontend/stores/core/files.svelte';
	import { getVisiblePanels, workspaceState } from '$frontend/stores/ui/workspace.svelte';

	const { content }: { content: string } = $props();

	// Detect URLs that point to a local absolute file path served by the current host.
	// Returns the resolved file path if matched, otherwise null.
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

	function handleRevealClick(event: MouseEvent) {
		const target = event.target as HTMLElement | null;
		if (!target) return;
		const button = target.closest('[data-reveal-file]') as HTMLElement | null;
		if (!button) return;
		event.preventDefault();
		const filePath = button.getAttribute('data-reveal-file');
		if (!filePath) return;
		const visiblePanels = getVisiblePanels(workspaceState.layout);
		if (visiblePanels.includes('files')) requestRevealFile(filePath);
	}

	// Configure marked for better styling
	configureMarked();

	// Custom renderer - with HTML sanitization for security
	const renderer = new marked.Renderer();

	// Override HTML rendering to escape instead of render - this prevents XSS
	renderer.html = function(token) {
		return escapeHtml(token.text);
	};

	// Override code blocks to escape HTML and colorize any ANSI escapes
	renderer.code = (token) => renderCodeBlock(token, { ansi: true });

	// Override inline code to escape HTML but allow normal markdown processing
	renderer.codespan = (token) => renderInlineCode(token);

	// Override link rendering to convert local-file URLs into reveal-file buttons.
	renderer.link = function(token) {
		const href = token.href || '';
		const text = this.parser.parseInline(token.tokens);
		const filePath = matchLocalFilePath(href);
		if (filePath) {
			return `<button type="button" class="reveal-file-link" data-reveal-file="${escapeHtml(filePath)}" title="Reveal in Files panel">${text}</button>`;
		}
		const safeHref = escapeHtml(href);
		const titleAttr = token.title ? ` title="${escapeHtml(token.title)}"` : '';
		return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
	};

	// Wrap tables in a responsive scroll container
	renderer.table = function(token) {
		return renderTable(token, this.parser);
	};

	// Process content: marked owns the full document so markdown structure (nested fenced
	// code blocks, headings after them, etc.) parses correctly. A whole-message terminal dump
	// — ANSI escapes, or clearly terminal output with no markdown fences — is rendered as
	// terminal instead, preserving monospace + whitespace (alignment, box drawing).
	function processContent(text: string): string {
		if ((hasAnsiCodes(text) || isTerminalOutput(text)) && !text.includes('```')) {
			return formatTerminalOutput(text);
		}
		return `<div>${marked.parse(text, { renderer }) as string}</div>`;
	}

	const processedContent = $derived(processContent(content));
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="message-content space-y-4 wrap-break-word" onclick={handleRevealClick}>
	{@html processedContent}
</div>

<style>
	/* Custom markdown styling using CSS instead of @apply */
	:global(.message-content) {
		color: rgb(30 41 59);
		line-height: 1.5;
	}

	:global(.dark .message-content) {
		color: rgb(226 232 240);
	}
	
	/* Headings */
	:global(.message-content *:first-child) {
		margin-top: 0;
	}

	:global(.message-content *:last-child) {
		margin-bottom: 0;
	}

	:global(.message-content h1) {
		font-size: 1.5rem;
		font-weight: 700;
		margin-top: 1.5rem;
		margin-bottom: 1rem;
		color: rgb(15 23 42);
	}

	:global(.dark .message-content h1) {
		color: rgb(241 245 249);
	}

	:global(.message-content h2) {
		font-size: 1.25rem;
		font-weight: 700;
		margin-top: 1.25rem;
		margin-bottom: 0.75rem;
		color: rgb(15 23 42);
	}

	:global(.dark .message-content h2) {
		color: rgb(241 245 249);
	}

	:global(.message-content h3) {
		font-size: 1.125rem;
		font-weight: 700;
		margin-top: 1rem;
		margin-bottom: 0.5rem;
		color: rgb(15 23 42);
	}

	:global(.dark .message-content h3) {
		color: rgb(241 245 249);
	}

	:global(.message-content h4),
	:global(.message-content h5),
	:global(.message-content h6) {
		font-size: 1rem;
		font-weight: 700;
		margin-top: 0.75rem;
		margin-bottom: 0.5rem;
		color: rgb(15 23 42);
	}

	:global(.dark .message-content h4),
	:global(.dark .message-content h5),
	:global(.dark .message-content h6) {
		color: rgb(241 245 249);
	}
	
	/* Paragraphs */
	:global(.message-content p) {
		margin-bottom: 1rem;
		line-height: 1.5;
	}
	
	/* Links */
	:global(.message-content a),
	:global(.message-content .reveal-file-link) {
		color: rgb(37 99 235);
		text-decoration: underline;
	}

	:global(.dark .message-content a),
	:global(.dark .message-content .reveal-file-link) {
		color: rgb(96 165 250);
	}

	:global(.message-content a:hover),
	:global(.message-content .reveal-file-link:hover) {
		color: rgb(29 78 216);
	}

	:global(.dark .message-content a:hover),
	:global(.dark .message-content .reveal-file-link:hover) {
		color: rgb(147 197 253);
	}

	:global(.message-content .reveal-file-link) {
		background: transparent;
		border: 0;
		padding: 0;
		font: inherit;
		cursor: pointer;
		word-break: break-all;
	}
	
	/* Code */
	:global(.message-content code) {
		background-color: rgb(248 250 252);
		color: rgb(51 65 85);
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		font-family: monospace;
		font-size: 0.875rem;
	}
	
	:global(.dark .message-content code) {
		background-color: rgb(30 41 59);
		color: rgb(203 213 225);
	}
	
	/* Code blocks */
	:global(.message-content pre) {
		background-color: rgb(248 250 252);
		color: rgb(51 65 85);
		padding: 0.5rem 1rem;
		border-radius: 0.5rem;
		overflow-x: auto;
		margin: 1rem 0;
		border: 1px solid rgb(226 232 240);
	}
	
	:global(.dark .message-content pre) {
		background-color: rgb(30 41 59);
		color: rgb(203 213 225);
		border-color: rgb(51 65 85);
	}
	
	:global(.message-content pre code) {
		background-color: transparent;
		padding: 0;
		border-radius: 0;
		border: 0;
		color: inherit;
	}

	:global(.dark .message-content pre code) {
		background-color: transparent;
		padding: 0;
		border-radius: 0;
		border: 0;
		color: inherit;
	}
	
	/* Typography */
	:global(.message-content strong) {
		font-weight: 700;
		color: rgb(15 23 42);
	}

	:global(.dark .message-content strong) {
		color: rgb(241 245 249);
	}

	:global(.message-content em) {
		font-style: italic;
		color: rgb(51 65 85);
	}

	:global(.dark .message-content em) {
		color: rgb(203 213 225);
	}
	
	/* Blockquotes */
	:global(.message-content blockquote) {
		border-left: 0.25rem solid rgb(203 213 225);
		padding-left: 1rem;
		font-style: italic;
		color: rgb(100 116 139);
		margin: 1rem 0;
	}

	:global(.dark .message-content blockquote) {
		border-left-color: rgb(100 116 139);
		color: rgb(148 163 184);
	}
	
	/* Lists */
	:global(.message-content ul) {
		list-style-type: disc;
		margin-left: 1.5rem;
		margin-bottom: 1rem;
	}
	
	:global(.message-content ol) {
		list-style-type: decimal;
		margin-left: 1.5rem;
		margin-bottom: 1rem;
	}
	
	:global(.message-content li) {
		margin-bottom: 0.25rem;
	}
	
	/* Horizontal rules */
	:global(.message-content hr) {
		border-color: rgb(226 232 240);
		margin: 1.5rem 0;
	}

	:global(.dark .message-content hr) {
		border-color: rgb(51 65 85);
	}
	
	/* Tables - Responsive wrapper */
	:global(.message-content .table-responsive) {
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		margin: 1rem 0;
		border-radius: 0.5rem;
		border: 1px solid rgb(226 232 240);
		scrollbar-width: thin;
		scrollbar-color: rgb(139 92 246 / 0.2) transparent;
	}

	:global(.dark .message-content .table-responsive) {
		border-color: rgb(51 65 85);
	}

	:global(.message-content .table-responsive::-webkit-scrollbar) {
		height: 0.375rem;
	}

	:global(.message-content .table-responsive::-webkit-scrollbar-track) {
		background: transparent;
	}

	:global(.message-content .table-responsive::-webkit-scrollbar-thumb) {
		background: rgb(139 92 246 / 0.2);
		border-radius: 0.25rem;
	}

	:global(.message-content .table-responsive::-webkit-scrollbar-thumb:hover) {
		background: rgb(139 92 246 / 0.4);
	}

	:global(.message-content table) {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	:global(.message-content th),
	:global(.message-content td) {
		border: 1px solid rgb(226 232 240);
		padding: 0.5rem 0.75rem;
		white-space: nowrap;
	}

	:global(.dark .message-content th),
	:global(.dark .message-content td) {
		border-color: rgb(51 65 85);
	}

	/* Header row with violet accent */
	:global(.message-content th) {
		background-color: rgb(248 250 252);
		font-weight: 600;
		text-align: left;
		color: rgb(51 65 85);
	}

	:global(.dark .message-content th) {
		background-color: rgb(30 41 59);
		color: rgb(203 213 225);
	}

	/* Alternating row colors */
	:global(.message-content tbody tr:nth-child(even)) {
		background-color: rgb(248 250 252);
	}

	:global(.dark .message-content tbody tr:nth-child(even)) {
		background-color: rgb(30 41 59 / 0.5);
	}

	/* Images */
	:global(.message-content img) {
		max-width: 100%;
		height: auto;
		border-radius: 0.25rem;
		margin: 1rem 0;
	}
</style>