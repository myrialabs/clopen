/**
 * Pieces every action group reuses: the targeting fields and the shared
 * per-action options.
 */

import { z } from 'zod';
import type { BrowserActionTarget } from '$backend/preview/browser/types';

/**
 * How an action says *where* to act.
 *
 * Flat rather than nested because a model fills flat fields far more reliably,
 * and because the three ways to aim are mutually exclusive in practice:
 * coordinates from a screenshot, a CSS selector, or visible text.
 */
// Kept terse on purpose: these five fields repeat across most actions, so every
// word here is paid for ~15 times in the JSON schema the engine receives. The
// tool description explains targeting once, in prose.
export const targetFields = {
	x: z.number().optional().describe('X in page viewport.'),
	y: z.number().optional().describe('Y in page viewport.'),
	selector: z.string().optional().describe('CSS selector; all frames.'),
	text: z.string().optional().describe('Visible text to match.'),
	nth: z.number().int().min(0).optional().describe('Which match (0-based).')
};

/**
 * Targeting for actions that already use `text` for content (type, paste).
 * Two different meanings on one key would be ambiguous for the model and
 * impossible to resolve at runtime.
 */
export const targetFieldsNoText = {
	x: targetFields.x,
	y: targetFields.y,
	selector: targetFields.selector,
	nth: targetFields.nth
};

/** Nested target, for actions with two endpoints (drag, swipe). */
export const pointSchema = z.object(targetFields).describe('A point: coordinates, a selector, or visible text.');

/** Options accepted by every action. Terse for the same reason as above. */
export const commonFields = {
	optional: z.boolean().optional().describe('Failure does not stop the batch.')
};

export function toTarget(args: {
	x?: number;
	y?: number;
	selector?: string;
	text?: string;
	nth?: number;
}): BrowserActionTarget {
	return { x: args.x, y: args.y, selector: args.selector, text: args.text, nth: args.nth };
}

/** True when an action named a place to act at all. */
export function hasTarget(args: { x?: number; y?: number; selector?: string; text?: string }): boolean {
	return (typeof args.x === 'number' && typeof args.y === 'number') || !!args.selector || !!args.text;
}
