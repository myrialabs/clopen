/**
 * Notification icon.
 *
 * `/favicon.svg` cannot be handed to the Notification API directly: Chromium
 * decodes notification images with its raster decoders, which have no SVG
 * support, so on Windows and Linux the toast renders with no icon at all.
 * Firefox does render it — which is why the gap is invisible while
 * developing and only shows up on the platform users report.
 *
 * The same file is rasterised once into a PNG data URL, keeping the icon a
 * single source of truth instead of duplicating the artwork as a checked-in
 * bitmap. A data URL also spares the browser a resource fetch on the path
 * that has to display a toast promptly.
 */

const ICON_SOURCE = '/favicon.svg';

/** Large enough for the Windows Action Center, which renders icons at 48-96px. */
const ICON_SIZE = 192;

/**
 * Cached as a promise, not a value: notifications can be created in bursts,
 * and this keeps a burst to one rasterisation rather than one per toast.
 */
let cachedIcon: Promise<string> | null = null;

async function rasterise(): Promise<string> {
	if (typeof document === 'undefined' || typeof Image === 'undefined') {
		return ICON_SOURCE;
	}

	// Width/height matter: the source SVG carries a viewBox but no intrinsic
	// size, and an <img> would otherwise default to 300x150 and rasterise
	// the icon stretched.
	const image = new Image(ICON_SIZE, ICON_SIZE);
	await new Promise<void>((resolve, reject) => {
		image.onload = () => resolve();
		image.onerror = () => reject(new Error(`Failed to load ${ICON_SOURCE}`));
		image.src = ICON_SOURCE;
	});

	const canvas = document.createElement('canvas');
	canvas.width = ICON_SIZE;
	canvas.height = ICON_SIZE;
	const context = canvas.getContext('2d');
	if (!context) return ICON_SOURCE;

	context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE);
	return canvas.toDataURL('image/png');
}

/**
 * Resolve the icon to use for a native notification. Never rejects: on any
 * failure it falls back to the SVG, which is no worse than the previous
 * behaviour.
 */
export function notificationIcon(): Promise<string> {
	cachedIcon ??= rasterise().catch(() => ICON_SOURCE);
	return cachedIcon;
}

/**
 * Rasterise ahead of the first notification so that one does not pay for it.
 * Best-effort — callers do not wait on this.
 */
export function warmNotificationIcon(): void {
	void notificationIcon();
}
