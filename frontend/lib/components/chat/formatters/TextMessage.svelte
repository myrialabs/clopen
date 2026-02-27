<script lang="ts">
	import { marked } from 'marked';
	import {
		isTerminalOutput,
		processAnsiCodes,
		splitContentIntoSegments,
		formatTerminalOutput,
		escapeHtml
	} from '$frontend/lib/utils/terminalFormatter';

	const { content }: { content: string } = $props();

	// Configure marked for better styling
	marked.setOptions({
		breaks: true,
		gfm: true,
		async: false
	});

	// Custom renderer - with HTML sanitization for security
	const renderer = new marked.Renderer();
	
	// Override HTML rendering to escape instead of render - this prevents XSS
	renderer.html = function(token) {
		return escapeHtml(token.text);
	};
	
	// Override code blocks to ensure they look good and escape HTML
	renderer.code = function(token) {
		const code = escapeHtml(token.text);
		const language = token.lang || '';
		return `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${code}</code></pre>`;
	};
	
	// Override inline code to escape HTML but allow normal markdown processing
	renderer.codespan = function(token) {
		return `<code>${escapeHtml(token.text)}</code>`;
	};

	// Wrap tables in a responsive scroll container
	renderer.table = function(token) {
		const headerCells = token.header
			.map((cell, i) => {
				const align = token.align[i] ? ` style="text-align:${token.align[i]}"` : '';
				return `<th${align}>${this.parser.parseInline(cell.tokens)}</th>`;
			})
			.join('');
		const headerRow = `<tr>${headerCells}</tr>`;

		const bodyRows = token.rows
			.map(row => {
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

	// Split content into segments (terminal vs regular text)
	function splitContent(text: string): Array<{type: 'terminal' | 'markdown', content: string}> {
		const segments = splitContentIntoSegments(text);
		// Convert 'text' type to 'markdown' for compatibility
		return segments.map(segment => ({
			type: segment.type === 'terminal' ? 'terminal' : 'markdown',
			content: segment.content
		}));
	}

	// Process content based on type
	function processContent(text: string): string {
		const segments = splitContent(text);

		return segments.map(segment => {
			if (segment.type === 'terminal') {
				// For terminal output, use the formatting utility
				return formatTerminalOutput(segment.content);
			} else {
				// For regular text, use marked to parse markdown with prose wrapper
				const markdownContent = marked.parse(segment.content, { renderer }) as string;
				return `<div>${markdownContent}</div>`;
			}
		}).join('');
	}

	const processedContent = $derived(processContent(content));
</script>

<div class="message-content">
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	{@html processedContent}
</div>

<style>
	/* Custom markdown styling using CSS instead of @apply */
	:global(.message-content) {
		color: rgb(30 41 59);
		line-height: 1.5;
		margin-bottom: -1rem;
	}

	:global(.dark .message-content) {
		color: rgb(226 232 240);
	}
	
	/* Headings */
	:global(.message-content h1:first-child),
	:global(.message-content h2:first-child),
	:global(.message-content h3:first-child),
	:global(.message-content h4:first-child),
	:global(.message-content h5:first-child),
	:global(.message-content h6:first-child) {
		margin-top: 0;
	}

	:global(.message-content h1:last-child),
	:global(.message-content h2:last-child),
	:global(.message-content h3:last-child),
	:global(.message-content h4:last-child),
	:global(.message-content h5:last-child),
	:global(.message-content h6:last-child) {
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
	:global(.message-content a) {
		color: rgb(37 99 235);
		text-decoration: underline;
	}
	
	:global(.dark .message-content a) {
		color: rgb(96 165 250);
	}
	
	:global(.message-content a:hover) {
		color: rgb(29 78 216);
	}
	
	:global(.dark .message-content a:hover) {
		color: rgb(147 197 253);
	}
	
	/* Code */
	:global(.message-content code) {
		background-color: rgb(248 250 252);
		color: rgb(51 65 85);
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		font-family: monospace;
		font-size: 0.875rem;
		border: 1px solid rgb(226 232 240);
	}
	
	:global(.dark .message-content code) {
		background-color: rgb(30 41 59);
		color: rgb(203 213 225);
		border-color: rgb(51 65 85);
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