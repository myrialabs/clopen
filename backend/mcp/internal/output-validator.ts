/**
 * MCP Tool Output Validator
 *
 * Validates and sanitizes MCP tool outputs before forwarding to AI models.
 * Prevents memory pressure from oversized tool responses.
 *
 * Limits:
 *   - Text content: 10 MB per tool response
 *   - Image content: 5 MB per image
 *   - Total content array: 15 MB per tool call
 */

import { debug } from '$shared/utils/logger';

const LIMITS = {
	maxTextSize: 10 * 1024 * 1024,
	maxImageSize: 5 * 1024 * 1024,
	maxTotalSize: 15 * 1024 * 1024
};

interface MCPContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

function estimateTextSize(text: string): number {
	return new TextEncoder().encode(text).length;
}

function estimateImageSize(base64Data: string): number {
	return Math.ceil(base64Data.length * 0.75);
}

function truncateText(text: string, maxSize: number): string {
	if (estimateTextSize(text) <= maxSize) return text;

	const truncationMessage = '\n\n[Content truncated due to size limit]';
	const messageSize = estimateTextSize(truncationMessage);
	if (messageSize >= maxSize) return truncationMessage;

	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const candidate = text.substring(0, mid) + truncationMessage;
		if (estimateTextSize(candidate) <= maxSize) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}

	return text.substring(0, low) + truncationMessage;
}

export function validateMcpOutput(content: MCPContent[], toolName: string): MCPContent[] {
	if (!content || content.length === 0) return content;

	let totalSize = 0;
	const sanitized: MCPContent[] = [];

	for (const item of content) {
		let sanitizedItem: MCPContent = item;
		let itemSize = 0;

		if (item.type === 'text' && item.text) {
			const textSize = estimateTextSize(item.text);
			if (textSize > LIMITS.maxTextSize) {
				debug.warn('mcp', `Tool ${toolName} text output exceeded limit: ${(textSize / 1024 / 1024).toFixed(2)} MB > ${(LIMITS.maxTextSize / 1024 / 1024).toFixed(0)} MB`);
				sanitizedItem = { type: 'text', text: truncateText(item.text, LIMITS.maxTextSize) };
			}
			itemSize = estimateTextSize(sanitizedItem.text ?? '');
		} else if (item.type === 'image' && item.data) {
			const imageSize = estimateImageSize(item.data);
			if (imageSize > LIMITS.maxImageSize) {
				debug.warn('mcp', `Tool ${toolName} image output exceeded limit: ${(imageSize / 1024 / 1024).toFixed(2)} MB > ${(LIMITS.maxImageSize / 1024 / 1024).toFixed(0)} MB`);
				sanitizedItem = {
					type: 'text',
					text: `[Image omitted: size ${(imageSize / 1024 / 1024).toFixed(2)} MB exceeds limit of ${(LIMITS.maxImageSize / 1024 / 1024).toFixed(0)} MB]`
				};
				itemSize = estimateTextSize(sanitizedItem.text ?? '');
			} else {
				itemSize = imageSize;
			}
		}

		totalSize += itemSize;
		if (totalSize > LIMITS.maxTotalSize) {
			debug.warn('mcp', `Tool ${toolName} total output exceeded limit: ${(totalSize / 1024 / 1024).toFixed(2)} MB > ${(LIMITS.maxTotalSize / 1024 / 1024).toFixed(0)} MB`);
			sanitized.push({
				type: 'text',
				text: '\n\n[Additional content omitted due to total size limit]'
			});
			break;
		}

		sanitized.push(sanitizedItem);
	}

	return sanitized;
}
