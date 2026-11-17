import { describe, expect, test } from 'bun:test';

import { decodeChunk, encodeChunk, sliceText } from './ws-chunk';

describe('ws chunk format', () => {
	test('round-trips header and slice, including separators-like text in the slice', () => {
		const frame = encodeChunk('7', 'messages:list-1-abc', 2, 5, '{"a":"x:y-z"}');
		expect(decodeChunk(frame)).toEqual({
			streamId: '7',
			requestId: 'messages:list-1-abc',
			index: 2,
			count: 5,
			slice: '{"a":"x:y-z"}'
		});
	});

	test('rejects frames that are not chunks or are out of range', () => {
		expect(decodeChunk('{"action":"x"}')).toBeNull();
		expect(decodeChunk(encodeChunk('1', 'r', 5, 5, 'x'))).toBeNull();
		expect(decodeChunk('\u0001broken')).toBeNull();
	});

	test('never splits a surrogate pair and reassembles to the original', () => {
		const text = 'ab😀'.repeat(1000);
		const slices = sliceText(text, 7);
		for (const slice of slices) {
			const last = slice.charCodeAt(slice.length - 1);
			expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
			expect(slice.length).toBeLessThanOrEqual(7);
		}
		expect(slices.join('')).toBe(text);
	});
});
