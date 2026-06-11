// Shared marked renderer helpers used by both chat messages (TextMessage) and the file
// markdown preview (MarkdownPreview). Keeps marked configuration plus the common code and
// table rendering in one place so both consumers stay in sync. Component-specific behavior
// (HTML sanitization, link handling, heading ids, terminal detection) stays in each component.

import { marked, type Token, type Tokens } from 'marked';
import { escapeHtml, hasAnsiCodes, processAnsiCodes } from './terminal-formatter';

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
