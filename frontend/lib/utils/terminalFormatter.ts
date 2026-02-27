// Terminal output detection and ANSI code processing utilities

export interface TerminalSegment {
	type: 'terminal' | 'text';
	content: string;
}

// Check if content looks like terminal output
export function isTerminalOutput(text: string): boolean {
	// Exclude git diff output - should not be treated as terminal
	if (/^diff --git /m.test(text) || /^@@\s+-\d+.*\+\d+.*@@/m.test(text)) {
		return false;
	}

	// Strong indicators - any of these alone means it's terminal output

	// 1. ANSI escape codes - definitive terminal indicator
	if (/\u001b\[[\d;]*m/.test(text)) {
		return true;
	}

	// 2. Shell prompt at the beginning of a line
	if (/^[\s]*[$>#%]\s+/m.test(text)) {
		return true;
	}

	// 3. Command execution pattern ($ command or > command)
	if (/^[\s]*[$>]\s+\S+/m.test(text)) {
		return true;
	}

	// Weak indicators - need multiple to be considered terminal
	let weakIndicators = 0;

	// Terminal-specific formatting
	if (/^[\s]*[│├└─┬┴┤┌┐]+/m.test(text)) weakIndicators++; // Box drawing
	if (/^\s*\d+\s*│/m.test(text)) weakIndicators++; // Line numbers with pipe
	if (/^[\s]*\[[\d:]+\]/m.test(text)) weakIndicators++; // [timestamp] format
	if (/^[\s]*(?:✓|✔|✗|✖|⚠|➜|→|▶|•)\s+/m.test(text)) weakIndicators++; // Terminal symbols at line start

	// Terminal-specific output patterns
	if (/^(?:error|ERROR|warn|WARN|info|INFO|debug|DEBUG):/m.test(text)) weakIndicators++;
	if (/^\s*at\s+\S+\s+\([^)]+:\d+:\d+\)/m.test(text)) weakIndicators++; // Stack traces
	if (/^[\s]*\+\s+\d+ms/m.test(text)) weakIndicators++; // Timing info

	// Need at least 3 weak indicators for terminal detection
	// This prevents normal text about packages from being detected as terminal
	return weakIndicators >= 3;
}

// ANSI color mappings to CSS classes with improved visibility for both modes
const ansiToClass: Record<string, string> = {
	'0': '', // reset
	'1': 'font-bold', // bold
	'2': 'opacity-60', // dim
	'3': 'italic', // italic
	'4': 'underline', // underline
	'22': '', // normal intensity
	'23': '', // not italic
	'30': 'text-slate-800 dark:text-slate-200', // black - improved contrast
	'31': 'text-red-600 dark:text-red-400', // red
	'32': 'text-green-600 dark:text-green-400', // green
	'33': 'text-yellow-700 dark:text-yellow-300', // yellow - better visibility
	'34': 'text-blue-600 dark:text-blue-400', // blue
	'35': 'text-purple-600 dark:text-purple-400', // magenta
	'36': 'text-cyan-600 dark:text-cyan-400', // cyan
	'37': 'text-slate-600 dark:text-slate-200', // white - improved contrast
	'90': 'text-slate-500 dark:text-slate-500', // bright black (gray)
	'91': 'text-red-500 dark:text-red-300', // bright red
	'92': 'text-green-500 dark:text-green-300', // bright green
	'93': 'text-yellow-600 dark:text-yellow-200', // bright yellow
	'94': 'text-blue-500 dark:text-blue-300', // bright blue
	'95': 'text-purple-500 dark:text-purple-300', // bright magenta
	'96': 'text-cyan-500 dark:text-cyan-300', // bright cyan
	'97': 'text-slate-900 dark:text-slate-100', // bright white
	'39': 'text-slate-900 dark:text-slate-100' // default foreground
};

// Process ANSI escape codes in terminal output
export function processAnsiCodes(text: string): string {
	const ansiRegex = /\u001b\[([0-9;]*)m/g;
	// Escape HTML first to prevent content (e.g. HTML tags in diffs) from being
	// rendered as actual DOM elements when using {@html}
	let processedText = escapeHtml(text);
	let currentStyles: string[] = [];

	// Replace ANSI codes with HTML spans (ANSI escape char \u001b is not affected by escapeHtml)
	processedText = processedText.replace(ansiRegex, (match, codes) => {
		const codeArray = codes.split(';');

		for (const code of codeArray) {
			if (code === '0' || code === '') {
				// Reset all styles
				currentStyles = [];
				return '</span>';
			} else if (ansiToClass[code]) {
				const cssClass = ansiToClass[code];
				if (cssClass) {
					// Remove conflicting styles and add new one
					if (code.startsWith('3') || code === '39' || code === '90') {
						// Color codes - remove existing colors
						currentStyles = currentStyles.filter(s => !s.includes('text-'));
					}
					if (!currentStyles.includes(cssClass)) {
						currentStyles.push(cssClass);
					}
				}
			}
		}

		return `<span class="${currentStyles.join(' ')}">`;
	});

	// Clean up any unclosed spans
	const openSpans = (processedText.match(/<span/g) || []).length;
	const closeSpans = (processedText.match(/<\/span>/g) || []).length;
	if (openSpans > closeSpans) {
		processedText += '</span>'.repeat(openSpans - closeSpans);
	}

	return processedText;
}

// Split content into segments (terminal vs regular text)
export function splitContentIntoSegments(text: string): TerminalSegment[] {
	const segments: TerminalSegment[] = [];

	// First check if the entire text has ANSI codes - if so, it's all terminal
	if (/\u001b\[[\d;]*m/.test(text)) {
		return [{ type: 'terminal', content: text }];
	}

	// For text without ANSI codes, we need to be more careful
	// Split by code blocks first to preserve them
	const codeBlockRegex = /```[\s\S]*?```/g;
	const codeBlocks: {start: number, end: number, content: string}[] = [];
	let match;

	// Find all code blocks
	while ((match = codeBlockRegex.exec(text)) !== null) {
		codeBlocks.push({
			start: match.index,
			end: match.index + match[0].length,
			content: match[0]
		});
	}

	// Process text in chunks, avoiding code blocks
	let lastIndex = 0;
	for (let i = 0; i <= codeBlocks.length; i++) {
		const startIndex = lastIndex;
		const endIndex = i < codeBlocks.length ? codeBlocks[i].start : text.length;

		if (startIndex < endIndex) {
			const chunk = text.slice(startIndex, endIndex);

			// Split chunk by double newlines
			const blocks = chunk.split(/\n\n+/);

			for (const block of blocks) {
				if (!block.trim()) continue;

				const blockType = isTerminalOutput(block) ? 'terminal' : 'text';

				// Merge with previous segment if same type
				if (segments.length > 0 && segments[segments.length - 1].type === blockType) {
					segments[segments.length - 1].content += '\n\n' + block;
				} else {
					segments.push({ type: blockType, content: block });
				}
			}
		}

		// Add code block as text (not terminal)
		if (i < codeBlocks.length) {
			if (segments.length > 0 && segments[segments.length - 1].type === 'text') {
				segments[segments.length - 1].content += '\n\n' + codeBlocks[i].content;
			} else {
				segments.push({ type: 'text', content: codeBlocks[i].content });
			}
			lastIndex = codeBlocks[i].end;
		}
	}

	// If no segments, treat as text
	if (segments.length === 0 && text.trim()) {
		segments.push({ type: 'text', content: text });
	}

	return segments;
}

// Format terminal output with proper styling
export function formatTerminalOutput(text: string): string {
	const processedAnsi = processAnsiCodes(text);
	return `<div class="font-mono text-sm whitespace-pre-wrap terminal-output bg-slate-100 dark:bg-slate-900 text-slate-900 dark:text-slate-100 p-4 rounded-lg overflow-x-auto border border-slate-300 dark:border-slate-700">${processedAnsi}</div>`;
}

// Escape HTML entities for security
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}