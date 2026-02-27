// Utility functions for tool displays

/**
 * Format file path for display by shortening long paths
 */
export function formatPath(path: string): string {
	if (path === 'current directory') return path;
	
	if (path.length > 60) {
		const parts = path.split(/[/\\]/);
		if (parts.length > 3) {
			return `.../${parts.slice(-3).join('/')}`;
		}
	}
	return path;
}

/**
 * Format content by truncating long text intelligently
 */
export function formatContent(content: string, maxLength: number = 500): string {
	if (content.length <= maxLength) {
		return content;
	}

	const lines = content.split('\n');
	if (lines.length > 10) {
		return lines.slice(0, 5).join('\n') + 
			'\n... (' + (lines.length - 10) + ' more lines) ...\n' + 
			lines.slice(-5).join('\n');
	}
	return content.substring(0, maxLength) + '...';
}

/**
 * Format file size in human readable format
 */
export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Truncate text with ellipsis
 */
export function truncateText(text: string, maxLength: number): string {
	if (text.length > maxLength) {
		return text.substring(0, maxLength - 3) + '...';
	}
	return text;
}

/**
 * Remove common indentation from a string
 */
export function removeCommonIndentation(input: string): string {
	const lines = input.split('\n');
	
	// Find minimum indentation across all non-empty lines
	let minIndent = Infinity;
	
	for (const line of lines) {
		if (line.trim()) { // Skip empty lines
			const match = line.match(/^(\s*)/);
			if (match) {
				minIndent = Math.min(minIndent, match[1].length);
			}
		}
	}
	
	// Remove common indentation from all lines
	if (minIndent > 0 && minIndent < Infinity) {
		return lines.map(line => {
			if (line.trim()) {
				return line.substring(minIndent);
			}
			return line;
		}).join('\n');
	}
	
	return input;
}

/**
 * Remove common indentation from an array of lines
 */
export function removeCommonIndentationFromLines(lines: string[]): { lines: string[], commonIndent: string } {
	// Find minimum indentation across all non-empty lines
	let minIndent = Infinity;
	let commonIndent = '';
	
	for (const line of lines) {
		if (line.trim()) { // Skip empty lines
			const match = line.match(/^(\s*)/);
			if (match) {
				const indent = match[1].length;
				if (indent < minIndent) {
					minIndent = indent;
					commonIndent = match[1].substring(0, minIndent);
				}
			}
		}
	}
	
	// Remove common indentation from all lines
	if (minIndent > 0 && minIndent < Infinity) {
		return {
			lines: lines.map(line => line.startsWith(commonIndent) ? line.substring(minIndent) : line),
			commonIndent
		};
	}
	
	return { lines, commonIndent: '' };
}