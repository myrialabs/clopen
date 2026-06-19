import { describe, expect, test } from 'bun:test';
import { validateMcpOutput } from './output-validator';

const MB = 1024 * 1024;

describe('validateMcpOutput', () => {
	test('truncates oversized text output to the configured text budget', () => {
		const oversizedText = 'a'.repeat((10 * MB) + 8_192);

		const result = validateMcpOutput([{ type: 'text', text: oversizedText }], 'tool-a');

		expect(result).toHaveLength(1);
		expect(result[0].type).toBe('text');
		expect(result[0].text).toContain('[Content truncated due to size limit]');
		expect(new TextEncoder().encode(result[0].text ?? '').length).toBeLessThanOrEqual(10 * MB);
	});

	test('replaces oversized image output with explanatory text', () => {
		const oversizedImage = 'a'.repeat(Math.ceil((6 * MB) / 0.75));

		const result = validateMcpOutput([
			{ type: 'image', data: oversizedImage, mimeType: 'image/png' }
		], 'take_screenshot');

		expect(result).toEqual([
			{
				type: 'text',
				text: expect.stringContaining('[Image omitted: size')
			}
		]);
	});

	test('stops once sanitized total output exceeds the overall cap', () => {
		const elevenMbText = 'b'.repeat(11 * MB);
		const sixMbText = 'c'.repeat(6 * MB);
		const trailingText = 'should never appear';

		const result = validateMcpOutput([
			{ type: 'text', text: elevenMbText },
			{ type: 'text', text: sixMbText },
			{ type: 'text', text: trailingText }
		], 'tool-b');

		expect(result).toHaveLength(2);
		expect(result[0].text).toContain('[Content truncated due to size limit]');
		expect(result[1]).toEqual({
			type: 'text',
			text: '\n\n[Additional content omitted due to total size limit]'
		});
		expect(result.some(item => item.text === trailingText)).toBe(false);
	});
});
