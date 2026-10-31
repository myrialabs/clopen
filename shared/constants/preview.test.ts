import { describe, expect, test } from 'bun:test';
import {
	DEVICE_PRESETS,
	DEVICE_VIEWPORTS,
	VIEWPORT_LIMITS,
	clampViewport,
	getDeviceEmulation,
	getFrameLayout,
	orient,
	planDevice,
	resolveDevicePreset,
	resolveViewport,
	type DeviceState
} from './preview';

describe('resolveViewport', () => {
	test('falls back to the class default, turned to the rotation', () => {
		expect(resolveViewport('mobile', 'landscape', null)).toEqual({ width: 874, height: 402 });
		expect(resolveViewport('laptop', 'landscape')).toEqual({ width: 1440, height: 900 });
	});

	test('an exact size wins over the class default', () => {
		expect(resolveViewport('mobile', 'portrait', { width: 375, height: 667 })).toEqual({ width: 375, height: 667 });
	});

	test('ignores incomplete sizes from older saves', () => {
		expect(resolveViewport('tablet', 'portrait', { width: 500 })).toEqual({ width: 834, height: 1194 });
	});
});

describe('clampViewport', () => {
	test('keeps sizes inside the limits and whole', () => {
		expect(clampViewport({ width: 10, height: 99999 })).toEqual({
			width: VIEWPORT_LIMITS.min,
			height: VIEWPORT_LIMITS.max
		});
		expect(clampViewport({ width: 400.6, height: 800.2 })).toEqual({ width: 401, height: 800 });
	});
});

describe('presets', () => {
	test('each class default is its first preset', () => {
		for (const size of ['desktop', 'laptop', 'tablet', 'mobile'] as const) {
			const first = DEVICE_PRESETS.find((preset) => preset.deviceSize === size);
			expect(first).toMatchObject(DEVICE_VIEWPORTS[size]);
		}
	});

	test('a model of another class falls back to the class default', () => {
		expect(resolveDevicePreset('mobile', 'galaxy-s24')?.id).toBe('galaxy-s24');
		expect(resolveDevicePreset('tablet', 'galaxy-s24')?.id).toBe('ipad-pro-11');
		expect(resolveDevicePreset('responsive', 'galaxy-s24')).toBeUndefined();
	});
});

describe('planDevice', () => {
	const phone: DeviceState = {
		deviceSize: 'mobile',
		rotation: 'portrait',
		viewport: { width: 402, height: 874 },
		deviceModel: 'iphone-16'
	};

	test('a new model starts from its own size, keeping the orientation within a class', () => {
		expect(planDevice({ ...phone, rotation: 'landscape', viewport: { width: 874, height: 402 } }, {
			deviceSize: 'mobile',
			deviceModel: 'galaxy-s24'
		})).toEqual({ deviceSize: 'mobile', rotation: 'landscape', viewport: { width: 780, height: 360 }, deviceModel: 'galaxy-s24' });
	});

	test('a new class lands on its default model in its natural orientation', () => {
		expect(planDevice(phone, { deviceSize: 'laptop' })).toEqual({
			deviceSize: 'laptop',
			rotation: 'landscape',
			viewport: { width: 1440, height: 900 },
			deviceModel: 'macbook-air-13'
		});
	});

	test('rotation turns a custom size around without resetting it', () => {
		const custom = { ...phone, viewport: { width: 390, height: 700 } };
		expect(planDevice(custom, { deviceSize: 'mobile', rotation: 'landscape' }).viewport).toEqual({ width: 700, height: 390 });
	});

	test('an exact size wins and decides the orientation, keeping the model', () => {
		const next = planDevice(phone, { deviceSize: 'mobile', size: { width: 900, height: 500 } });
		expect(next).toEqual({ deviceSize: 'mobile', rotation: 'landscape', viewport: { width: 900, height: 500 }, deviceModel: 'iphone-16' });
	});

	test('a laptop stays landscape', () => {
		const laptop = planDevice(phone, { deviceSize: 'laptop' });
		expect(planDevice(laptop, { deviceSize: 'laptop', rotation: 'portrait' }).rotation).toBe('landscape');
	});

	test('responsive keeps the size the page had', () => {
		expect(planDevice(phone, { deviceSize: 'responsive' })).toEqual({
			deviceSize: 'responsive',
			rotation: 'portrait',
			viewport: { width: 402, height: 874 },
			deviceModel: null
		});
	});
});

describe('getDeviceEmulation', () => {
	test('only handheld classes are emulated as touch devices', () => {
		expect(getDeviceEmulation('mobile')).toEqual({ isMobile: true, hasTouch: true });
		expect(getDeviceEmulation('tablet')).toEqual({ isMobile: true, hasTouch: true });
		expect(getDeviceEmulation('laptop')).toEqual({ isMobile: false, hasTouch: false });
		expect(getDeviceEmulation('responsive')).toEqual({ isMobile: false, hasTouch: false });
	});
});

describe('getFrameLayout', () => {
	const inside = (inner: { x: number; y: number; width: number; height: number }, outer: typeof inner) =>
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.width <= outer.x + outer.width &&
		inner.y + inner.height <= outer.y + outer.height;

	test('the screen is always exactly the viewport', () => {
		for (const size of ['desktop', 'laptop', 'tablet', 'mobile'] as const) {
			for (const rotation of ['portrait', 'landscape'] as const) {
				const viewport = orient(DEVICE_VIEWPORTS[size], rotation);
				const layout = getFrameLayout(size, viewport);
				expect(layout.screen.width).toBe(viewport.width);
				expect(layout.screen.height).toBe(viewport.height);
			}
		}
	});

	test('layers nest from the body inwards and stay inside the footprint', () => {
		for (const size of ['desktop', 'laptop', 'tablet', 'mobile'] as const) {
			for (const rotation of ['portrait', 'landscape'] as const) {
				const layout = getFrameLayout(size, orient(DEVICE_VIEWPORTS[size], rotation));
				const footprint = { x: 0, y: 0, ...layout.footprint };
				expect(inside(layout.body, footprint)).toBe(true);
				expect(inside(layout.glass, layout.body)).toBe(true);
				expect(inside(layout.display, layout.glass)).toBe(true);
				expect(inside(layout.screen, layout.display)).toBe(true);
				for (const part of [layout.base, layout.neck, layout.foot, ...layout.buttons]) {
					if (part) expect(inside(part, footprint)).toBe(true);
				}
			}
		}
	});

	test('the orientation is read off the viewport, not assumed', () => {
		expect(getFrameLayout('mobile', { width: 874, height: 402 }).orientation).toBe('landscape');
		// Phone landscape puts the island on the left.
		const landscape = getFrameLayout('mobile', { width: 874, height: 402 });
		expect(landscape.island!.height).toBeGreaterThan(landscape.island!.width);
	});

	test('responsive and a hidden frame collapse onto the page', () => {
		for (const layout of [
			getFrameLayout('responsive', { width: 900, height: 700 }),
			getFrameLayout('mobile', { width: 402, height: 874 }, false)
		]) {
			expect(layout.kind).toBe('none');
			expect(layout.footprint).toEqual({ width: layout.screen.width, height: layout.screen.height });
			expect(layout.screen.x).toBe(0);
			expect(layout.screen.y).toBe(0);
		}
	});

	test('every model lays out cleanly in both orientations', () => {
		const footprintOf = (layout: ReturnType<typeof getFrameLayout>) => ({ x: 0, y: 0, ...layout.footprint });
		for (const preset of DEVICE_PRESETS) {
			for (const rotation of ['portrait', 'landscape'] as const) {
				const viewport = orient(preset, rotation);
				const layout = getFrameLayout(preset.deviceSize, viewport, true, preset.id);
				expect(layout.model).toBe(preset.id);
				expect(layout.os).toBe(preset.os);
				expect(layout.screen.width).toBe(viewport.width);
				expect(inside(layout.screen, layout.display)).toBe(true);
				for (const part of [layout.base, layout.neck, layout.foot, ...layout.buttons, ...layout.feet]) {
					if (part) expect(inside(part, footprintOf(layout))).toBe(true);
				}
			}
		}
	});

	test('phones of the same class are different hardware', () => {
		const iphone = getFrameLayout('mobile', { width: 402, height: 874 }, true, 'iphone-16');
		const galaxy = getFrameLayout('mobile', { width: 402, height: 874 }, true, 'galaxy-s24');
		const se = getFrameLayout('mobile', { width: 375, height: 667 }, true, 'iphone-se');
		expect(iphone.island).not.toBeNull();
		expect(iphone.punchHole).toBeNull();
		expect(galaxy.island).toBeNull();
		expect(galaxy.punchHole).not.toBeNull();
		expect(galaxy.bodyRadius).not.toEqual(iphone.bodyRadius);
		expect(galaxy.buttons.every((b) => b.edge === 'right')).toBe(true);
		expect(se.homeButton).not.toBeNull();
		expect(se.earpiece).not.toBeNull();
		expect(se.island).toBeNull();
	});

	test('the page never sits under a status bar, cutout or home indicator', () => {
		for (const preset of DEVICE_PRESETS) {
			for (const rotation of ['portrait', 'landscape'] as const) {
				const layout = getFrameLayout(preset.deviceSize, orient(preset, rotation), true, preset.id);
				for (const part of [layout.statusBar, layout.bottomBar, layout.navBar, layout.island, layout.punchHole, layout.notch, layout.homeIndicator]) {
					if (!part) continue;
					const overlapsX = part.x < layout.screen.x + layout.screen.width && layout.screen.x < part.x + part.width;
					const overlapsY = part.y < layout.screen.y + layout.screen.height && layout.screen.y < part.y + part.height;
					expect(overlapsX && overlapsY).toBe(false);
				}
			}
		}
	});

	test('a computer keeps its menu bar beside the page', () => {
		const mac = getFrameLayout('laptop', { width: 1440, height: 900 }, true, 'macbook-air-13');
		expect(mac.screen.y).toBe(mac.statusBar!.y + mac.statusBar!.height);
	});

	test('Android phones use button navigation, moved to the side when turned', () => {
		for (const model of ['pixel-9', 'galaxy-s24']) {
			const upright = getFrameLayout('mobile', { width: 412, height: 923 }, true, model);
			expect(upright.navBar?.direction).toBe('horizontal');
			expect(upright.homeIndicator).toBeNull();

			const turned = getFrameLayout('mobile', { width: 923, height: 412 }, true, model);
			expect(turned.navBar?.direction).toBe('vertical');
			expect(turned.bottomBar).toBeNull();
			// Nothing below the page: it reaches the bottom of the display.
			expect(turned.screen.y + turned.screen.height).toBe(turned.display.y + turned.display.height);
			expect(turned.navBar!.x).toBe(turned.screen.x + turned.screen.width);
		}
	});

	test('an Android tablet keeps its buttons along the bottom', () => {
		const tablet = getFrameLayout('tablet', { width: 1280, height: 800 }, true, 'galaxy-tab-s9');
		expect(tablet.navBar?.direction).toBe('horizontal');
	});

	test('iPhones keep the home indicator', () => {
		expect(getFrameLayout('mobile', { width: 874, height: 402 }, true, 'iphone-16').homeIndicator).not.toBeNull();
	});

	test('Windows devices put their system UI at the bottom', () => {
		const laptop = getFrameLayout('laptop', { width: 1366, height: 768 }, true, 'windows-laptop');
		expect(laptop.statusBar).toBeNull();
		expect(laptop.bottomBar).not.toBeNull();
		expect(laptop.notch).toBeNull();
		expect(laptop.homeIndicator).toBeNull();
	});

	test('a laptop has a deck wider than its lid, a monitor a stand', () => {
		const laptop = getFrameLayout('laptop', DEVICE_VIEWPORTS.laptop);
		expect(laptop.base!.width).toBeGreaterThan(laptop.body.width);
		expect(laptop.notch).not.toBeNull();
		const desktop = getFrameLayout('desktop', DEVICE_VIEWPORTS.desktop);
		expect(desktop.standStyle).toBe('pedestal');
		expect(desktop.neck).not.toBeNull();
		expect(desktop.foot).not.toBeNull();
	});
});
