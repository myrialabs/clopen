/**
 * Favicon Badge Service
 *
 * Dynamically renders a badge on the favicon showing the count of
 * non-idle status indicators across all projects (streaming, waiting
 * input, unread).
 */

import { debug } from '$shared/utils/logger';

const FAVICON_HREF = '/favicon.svg';
const BADGE_COLOR = '#000000';
const BADGE_TEXT_COLOR = '#FFFFFF';
const ICON_SIZE = 128; // canvas resolution — higher for crisp badge text

let originalIconUrl: string | null = null;
let currentCount = -1; // -1 = not yet rendered

/**
 * Update the favicon badge.
 * Renders the original SVG favicon with an optional numeric badge
 * in the bottom-right corner.
 *
 * @param count  Number of active indicators (0 = remove badge)
 */
export function updateFaviconBadge(count: number): void {
	// Avoid unnecessary re-renders
	if (count === currentCount) return;
	currentCount = count;

	if (count <= 0) {
		restoreOriginalFavicon();
		return;
	}

	const img = new Image();
	img.onload = () => {
		try {
			const canvas = document.createElement('canvas');
			canvas.width = ICON_SIZE;
			canvas.height = ICON_SIZE;
			const ctx = canvas.getContext('2d');
			if (!ctx) return;

			// Draw original favicon
			ctx.drawImage(img, 0, 0, ICON_SIZE, ICON_SIZE);

			// Badge text with outline (bottom-right)
			const displayText = count > 9 ? '9+' : String(count);
			const fontSize = count > 9 ? 56 : 64;
			const textX = ICON_SIZE - (count > 9 ? 32 : 24);
			const textY = ICON_SIZE - 20;

			ctx.font = `bold ${fontSize}px sans-serif`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';

			// Black outline
			ctx.strokeStyle = BADGE_COLOR;
			ctx.lineWidth = 14;
			ctx.lineJoin = 'round';
			ctx.strokeText(displayText, textX, textY);

			// White fill
			ctx.fillStyle = BADGE_TEXT_COLOR;
			ctx.fillText(displayText, textX, textY);

			// Apply to favicon
			const dataUrl = canvas.toDataURL('image/png');
			setFaviconHref(dataUrl);
		} catch (err) {
			debug.error('workspace', 'Failed to render favicon badge:', err);
		}
	};

	img.onerror = () => {
		debug.error('workspace', 'Failed to load favicon SVG for badge rendering');
	};

	img.src = FAVICON_HREF;
}

function setFaviconHref(href: string): void {
	let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
	if (!link) {
		link = document.createElement('link');
		link.rel = 'icon';
		document.head.appendChild(link);
	}
	if (!originalIconUrl) {
		originalIconUrl = FAVICON_HREF;
	}
	link.href = href;
}

function restoreOriginalFavicon(): void {
	if (originalIconUrl) {
		const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
		if (link) {
			link.href = originalIconUrl;
		}
	}
}
