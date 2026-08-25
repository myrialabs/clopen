/**
 * Frame Targeting
 *
 * Everything the preview inspects at a coordinate — the select under a click,
 * the element under a right-click, the field a paste lands in — used to run
 * `page.evaluate`, which only ever sees the **main frame**. Inside an iframe
 * `document.elementFromPoint()` returns the `<iframe>` element itself, so every
 * one of those features silently did nothing there.
 *
 * This walks the frame tree to find the frame that actually owns a point and
 * converts the coordinate into that frame's own viewport space, so the caller
 * can evaluate against the real element.
 *
 * `ElementHandle.boundingBox()` reports **main-frame** coordinates at every
 * depth, which is what makes the walk simple: the containment test always runs
 * against the original point, and only the returned offset accumulates.
 */

import type { Frame, Page } from 'puppeteer';

export interface FrameTarget {
	frame: Frame;
	/** The point, in `frame`'s own viewport coordinates. */
	x: number;
	y: number;
}

/**
 * Depth cap. Real pages nest an ad in a widget in a consent wrapper and stop;
 * anything deeper is far more likely to be a frame loop than a real target.
 */
const MAX_FRAME_DEPTH = 8;

/**
 * Resolve which frame owns a point, and where the point sits inside it.
 * Falls back to the main frame whenever the tree cannot be walked.
 */
export async function resolveFrameTarget(page: Page, x: number, y: number): Promise<FrameTarget> {
	let frame: Frame = page.mainFrame();
	let localX = x;
	let localY = y;

	for (let depth = 0; depth < MAX_FRAME_DEPTH; depth += 1) {
		const children = frame.childFrames();
		if (children.length === 0) break;

		let descended = false;

		for (const child of children) {
			try {
				const element = await child.frameElement();
				if (!element) continue;

				const box = await element.boundingBox();
				if (!box) {
					await element.dispose();
					continue;
				}

				const contains = x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
				if (!contains) {
					await element.dispose();
					continue;
				}

				// The frame's viewport starts inside its border and padding, so the
				// element box alone would be off by however thick those are.
				const inset = await element.evaluate((node) => {
					const style = getComputedStyle(node);
					return {
						left: parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
						top: parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop)
					};
				});
				await element.dispose();

				localX = x - box.x - (inset.left || 0);
				localY = y - box.y - (inset.top || 0);
				frame = child;
				descended = true;
				break;
			} catch {
				// Detached mid-walk (frames come and go constantly on real pages) —
				// try the next sibling rather than abandoning the whole resolution.
			}
		}

		if (!descended) break;
	}

	return { frame, x: Math.round(localX), y: Math.round(localY) };
}
