import { describe, expect, test } from 'bun:test';
import { elementToClip, readImageSize, regionToClip } from './browser-screenshot';

/** The smallest valid PNG header: signature plus an IHDR with the given size. */
function pngHeader(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(33);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const view = new DataView(bytes.buffer);
	view.setUint32(8, 13);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

/** SOI, an APP0 segment to skip, then a baseline start-of-frame. */
function jpegHeader(width: number, height: number): Uint8Array {
	return new Uint8Array([
		0xff, 0xd8,
		0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46,
		0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
		0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01
	]);
}

describe('readImageSize', () => {
	test('reads a PNG header', () => {
		expect(readImageSize(pngHeader(1440, 900))).toEqual({ width: 1440, height: 900 });
	});

	test('reads a JPEG frame header past the segments before it', () => {
		expect(readImageSize(jpegHeader(402, 874))).toEqual({ width: 402, height: 874 });
	});

	test('a full-page height past 65535 still reads from a PNG', () => {
		expect(readImageSize(pngHeader(1440, 70_000))).toEqual({ width: 1440, height: 70_000 });
	});

	test('anything else is not an image it can size', () => {
		expect(readImageSize(new Uint8Array([1, 2, 3, 4]))).toBeNull();
		expect(readImageSize(new Uint8Array())).toBeNull();
	});
});

describe('regionToClip', () => {
	const viewport = { width: 1000, height: 800 };

	test('moves a viewport rectangle into the document by the scroll offset', () => {
		expect(regionToClip({ x: 10, y: 20, width: 300, height: 200 }, viewport, { x: 0, y: 1500 })).toEqual({
			x: 10,
			y: 1520,
			width: 300,
			height: 200
		});
	});

	test('a drag made right-to-left or bottom-to-top is the same rectangle', () => {
		expect(regionToClip({ x: 310, y: 220, width: -300, height: -200 }, viewport, { x: 0, y: 0 })).toEqual({
			x: 10,
			y: 20,
			width: 300,
			height: 200
		});
	});

	test('stays inside the viewport when the drag ran past its edge', () => {
		expect(regionToClip({ x: -50, y: 700, width: 200, height: 400 }, viewport, { x: 0, y: 0 })).toEqual({
			x: 0,
			y: 700,
			width: 150,
			height: 100
		});
	});

	test('an empty selection is no clip', () => {
		expect(regionToClip({ x: 50, y: 50, width: 0, height: 100 }, viewport, { x: 0, y: 0 })).toBeNull();
		expect(regionToClip({ x: 1200, y: 50, width: 100, height: 100 }, viewport, { x: 0, y: 0 })).toBeNull();
	});
});

describe('elementToClip', () => {
	const page = {
		label: 'div',
		depth: 0,
		hasParent: true,
		scrollX: 0,
		scrollY: 400,
		viewportWidth: 1000,
		viewportHeight: 800,
		documentWidth: 1000,
		documentHeight: 5000
	};

	test('an element on screen is captured without leaving the viewport', () => {
		const result = elementToClip({ ...page, rect: { x: 100, y: 50, width: 200, height: 100 } });
		expect(result).toEqual({ clip: { x: 100, y: 450, width: 200, height: 100 }, beyondViewport: false });
	});

	test('an element taller than the screen asks for the capture beyond it', () => {
		const result = elementToClip({ ...page, rect: { x: 0, y: -100, width: 1000, height: 2000 } });
		expect(result?.beyondViewport).toBe(true);
		expect(result?.clip).toEqual({ x: 0, y: 300, width: 1000, height: 2000 });
	});

	test('is kept inside the document', () => {
		const result = elementToClip({ ...page, scrollY: 0, rect: { x: 900, y: 4900, width: 300, height: 300 } });
		expect(result?.clip).toEqual({ x: 900, y: 4900, width: 100, height: 100 });
	});

	test('an element with no size is no clip', () => {
		expect(elementToClip({ ...page, rect: { x: 10, y: 10, width: 0, height: 0 } })).toBeNull();
	});
});
