import { describe, expect, test } from 'bun:test';
import { mergeEmulation, viewportFor } from './viewport';

describe('mergeEmulation', () => {
	test('left-out fields keep their value, null hands them back to the device', () => {
		const current = { touch: false, colorScheme: 'dark' as const };
		expect(mergeEmulation(current, { reducedMotion: 'reduce', colorScheme: null })).toEqual({
			touch: false,
			reducedMotion: 'reduce'
		});
		expect(mergeEmulation(current, null)).toBe(current);
	});
});

describe('viewportFor', () => {
	test('handheld classes are touch and mobile by default', () => {
		expect(viewportFor({ deviceSize: 'mobile', viewport: { width: 402, height: 874 } })).toEqual({
			width: 402,
			height: 874,
			deviceScaleFactor: 1,
			isMobile: true,
			hasTouch: true,
			isLandscape: false
		});
	});

	test('overrides win over the class', () => {
		const touchLaptop = viewportFor({
			deviceSize: 'laptop',
			viewport: { width: 1440, height: 900 },
			emulation: { touch: true }
		});
		expect(touchLaptop.hasTouch).toBe(true);
		expect(touchLaptop.isMobile).toBe(false);
		expect(touchLaptop.isLandscape).toBe(true);

		const desktopModePhone = viewportFor({
			deviceSize: 'mobile',
			viewport: { width: 402, height: 874 },
			emulation: { mobile: false }
		});
		expect(desktopModePhone.isMobile).toBe(false);
		expect(desktopModePhone.hasTouch).toBe(true);
	});
});
