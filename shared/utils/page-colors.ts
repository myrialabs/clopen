/**
 * Ink for system UI painted in a page's colours: the status bar text and the
 * home indicator go dark on a light page and light on a dark one, as iOS and
 * Android draw them.
 */

/** Parse `#rgb`, `#rrggbb` or `rgb()/rgba()` into channels, or null. */
function channels(colour: string): [number, number, number] | null {
	const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(colour.trim());
	if (hex) {
		const digits = hex[1].length === 3 ? hex[1].replace(/./g, (d) => d + d) : hex[1];
		return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as [number, number, number];
	}
	const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(colour);
	return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

export function foregroundFor(colour: string | null | undefined): string {
	const rgb = colour ? channels(colour) : null;
	if (!rgb) return '#111113';
	const [r, g, b] = rgb;
	const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
	return luminance > 0.6 ? '#111113' : '#fff';
}
