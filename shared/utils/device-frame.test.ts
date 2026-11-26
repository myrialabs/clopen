import { describe, expect, test } from 'bun:test';
import { drawDeviceFrame, frameDrawInput, hasDeviceFrame } from './device-frame';

/** A 2D context that accepts every call, for running the drawing without a browser. */
function fakeContext(): unknown {
	const gradient = { addColorStop() {} };
	return new Proxy(
		{},
		{
			get(_target, key) {
				if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => gradient;
				if (key === 'measureText') return () => ({ width: 10 });
				return () => {};
			},
			set: () => true
		}
	);
}

function withFakeDocument<T>(run: () => T): T {
	const scope = globalThis as unknown as { document?: unknown };
	const previous = scope.document;
	scope.document = {
		createElement: () => ({ width: 0, height: 0, getContext: () => fakeContext() })
	};
	try {
		return run();
	} finally {
		scope.document = previous;
	}
}

const phone = { deviceSize: 'mobile', viewport: { width: 402, height: 874 }, deviceModel: 'iphone-16' } as const;

describe('device frame', () => {
	test('only devices with a mockup get a frame', () => {
		expect(hasDeviceFrame(phone)).toBe(true);
		expect(hasDeviceFrame({ deviceSize: 'responsive', viewport: { width: 900, height: 700 }, deviceModel: null })).toBe(false);
		expect(frameDrawInput({ deviceSize: 'responsive', viewport: { width: 900, height: 700 }, deviceModel: null })).toBeNull();
	});

	test('ink follows the page colours it sits on', () => {
		const input = frameDrawInput({ ...phone, pageColors: { statusBar: '#0f172a', background: '#ffffff' } });
		expect(input?.statusInk).toBe('#fff');
		expect(input?.backgroundInk).toBe('#111113');
	});

	test('the canvas is the whole mockup, at the image’s scale', () => {
		const input = frameDrawInput(phone)!;
		const canvas = withFakeDocument(() => drawDeviceFrame({ width: 804, height: 1748 } as never, input));
		expect(canvas?.width).toBe(Math.round(input.layout.footprint.width * 2));
		expect(canvas?.height).toBe(Math.round(input.layout.footprint.height * 2));
	});

	// The server ships the function into a browser page as source text. Rebuilt
	// from that text alone, it must still run: anything it reached outside its
	// own body would be a ReferenceError there.
	test('runs from its source text alone, as the server sends it', () => {
		const rebuilt = new Function(`return (${drawDeviceFrame.toString()})`)() as typeof drawDeviceFrame;
		for (const spec of [
			phone,
			{ deviceSize: 'mobile', viewport: { width: 412, height: 923 }, deviceModel: 'pixel-9' },
			{ deviceSize: 'mobile', viewport: { width: 375, height: 667 }, deviceModel: 'iphone-se' },
			{ deviceSize: 'tablet', viewport: { width: 834, height: 1194 }, deviceModel: 'ipad-pro-11' },
			{ deviceSize: 'laptop', viewport: { width: 1440, height: 900 }, deviceModel: 'macbook-air-13' },
			{ deviceSize: 'desktop', viewport: { width: 1920, height: 1080 }, deviceModel: 'monitor-fhd' }
		] as const) {
			const input = frameDrawInput(spec)!;
			const canvas = withFakeDocument(() => rebuilt(spec.viewport as never, input));
			expect(canvas).not.toBeNull();
		}
	});
});
