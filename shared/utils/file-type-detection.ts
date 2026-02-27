import { fileTypeFromBuffer } from 'file-type';
import isTextPath from 'is-text-path';

import { debug } from '$shared/utils/logger';
/**
 * Simple and reliable text file detection using external libraries
 */
export async function isTextFile(filePath: string): Promise<boolean> {
	try {
		// Fast path: check by extension first (covers 90% of cases)
		if (isTextPath(filePath)) {
			return true;
		}
		
		const file = Bun.file(filePath);
		const buffer = Buffer.from(await file.arrayBuffer());
		
		// Empty files are text
		if (buffer.length === 0) {
			return true;
		}
		
		// Let file-type check for binary formats
		const detectedType = await fileTypeFromBuffer(buffer);
		if (detectedType) {
			// If it detected something, check if content is actually text
			return isContentText(buffer);
		}
		
		// Unknown format - analyze content
		return isContentText(buffer);
		
	} catch (error) {
		debug.error('file', 'Error checking if file is text:', error);
		return false;
	}
}

/**
 * Simple content analysis for text detection
 */
function isContentText(buffer: Buffer): boolean {
	const sample = buffer.slice(0, Math.min(8192, buffer.length));
	let textBytes = 0;
	let nullBytes = 0;
	
	for (let i = 0; i < sample.length; i++) {
		const byte = sample[i];
		
		if (byte === 0) {
			nullBytes++;
		} else if (
			(byte >= 0x20 && byte <= 0x7E) || // Printable ASCII
			byte === 0x09 || byte === 0x0A || byte === 0x0D || // Whitespace
			byte >= 0x80 // UTF-8 or other text encodings
		) {
			textBytes++;
		}
	}
	
	const textRatio = textBytes / sample.length;
	const nullRatio = nullBytes / sample.length;
	
	// Handle UTF-16 (has many nulls but in pattern)
	if (nullRatio > 0.3) {
		return isLikelyUTF16(sample);
	}
	
	// If mostly text characters, it's text
	return textRatio > 0.7;
}

/**
 * Check if buffer might be UTF-16
 */
function isLikelyUTF16(buffer: Buffer): boolean {
	// Check for BOM
	if (buffer.length >= 2) {
		if ((buffer[0] === 0xFF && buffer[1] === 0xFE) || 
			(buffer[0] === 0xFE && buffer[1] === 0xFF)) {
			return true;
		}
	}
	
	// Check for alternating null pattern
	let evenNulls = 0;
	let oddNulls = 0;
	
	for (let i = 0; i < Math.min(200, buffer.length); i++) {
		if (buffer[i] === 0) {
			if (i % 2 === 0) evenNulls++;
			else oddNulls++;
		}
	}
	
	// UTF-16 has nulls mostly on one side
	return Math.abs(evenNulls - oddNulls) > (evenNulls + oddNulls) * 0.6;
}

/**
 * Auto-detect encoding and read file content
 */
export async function readFileWithEncoding(filePath: string): Promise<{ content: string; detectedEncoding: string }> {
	try {
		const file = Bun.file(filePath);
		const buffer = Buffer.from(await file.arrayBuffer());
		
		// Check BOM for encoding
		if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
			return {
				content: buffer.subarray(3).toString('utf8'),
				detectedEncoding: 'utf-8'
			};
		}
		
		if (buffer.length >= 2) {
			if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
				return {
					content: buffer.subarray(2).toString('utf16le'),
					detectedEncoding: 'utf16le'
				};
			}
			if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
				// Convert UTF-16 BE to LE
				const swapped = Buffer.alloc(buffer.length - 2);
				for (let i = 2; i < buffer.length - 1; i += 2) {
					swapped[i - 2] = buffer[i + 1];
					swapped[i - 1] = buffer[i];
				}
				return {
					content: swapped.toString('utf16le'),
					detectedEncoding: 'utf16be'
				};
			}
		}
		
		// Try UTF-8, fallback to latin1 if invalid
		const utf8Content = buffer.toString('utf8');
		if (!utf8Content.includes('\ufffd')) {
			return { content: utf8Content, detectedEncoding: 'utf-8' };
		}
		
		// Check if it's UTF-16 without BOM
		if (isLikelyUTF16(buffer)) {
			return {
				content: buffer.toString('utf16le'),
				detectedEncoding: 'utf16le'
			};
		}
		
		// Fallback to latin1
		return {
			content: buffer.toString('latin1'),
			detectedEncoding: 'latin1'
		};
		
	} catch (error) {
		debug.error('file', 'Error reading file with encoding:', error);
		const file = Bun.file(filePath);
		const buffer = Buffer.from(await file.arrayBuffer());
		return {
			content: buffer.toString('latin1'),
			detectedEncoding: 'latin1'
		};
	}
}