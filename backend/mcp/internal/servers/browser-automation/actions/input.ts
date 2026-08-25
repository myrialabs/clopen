/**
 * Input gestures — everything a person does with a mouse, keyboard or finger.
 *
 * These are `kind: 'input'`, so the runner hands consecutive ones to the native
 * gesture engine in a single call: pointer movement stays continuous and the
 * pacing between them is the engine's, not a round trip per click.
 */

import { z } from 'zod';
import type { ActionDef } from './types';
import { commonFields, pointSchema, targetFields, targetFieldsNoText, toTarget } from './shared';
import { resolveProjectFiles } from '../paths';

export const click: ActionDef = {
	type: 'click',
	kind: 'input',
	doc: `click {selector|text|x,y, button?, clickCount?} — click an element or a point.
  Prefer selector/text: resolution scrolls the element into view and aims at its centre, so it survives reflow. Coordinates are for canvases and anything without a DOM handle.
  button: left (default) | right | middle. clickCount: 2 for double-click, 3 to select a line.`,
	schema: z.object({
		type: z.literal('click'),
		...targetFields,
		button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default: left).'),
		clickCount: z.number().int().min(1).max(3).optional().describe('1 = single (default), 2 = double, 3 = triple.'),
		...commonFields
	}),
	toInput: (a) => ({ type: 'click', target: toTarget(a), button: a.button, clickCount: a.clickCount })
};

export const type_: ActionDef = {
	type: 'type',
	kind: 'input',
	doc: `type {text, selector?|x,y?, clearFirst?, key?} — type into the focused field.
  Give a selector/coords to focus a field first, so one batch can fill a whole form without interleaving clicks.
  clearFirst defaults to true (selects all, then overwrites). Set false to append.
  For a single key use \`key\` (Enter, Tab, Escape, ArrowDown…); for a chord use the \`press\` action.`,
	schema: z.object({
		type: z.literal('type'),
		text: z.string().optional().describe('Text to type, character by character.'),
		key: z.string().optional().describe('A single key to press instead of typing text (Enter, Tab, Escape, ArrowDown, Backspace…).'),
		clearFirst: z.boolean().optional().describe('Clear the field before typing (default: true).'),
		delay: z.number().optional().describe('Milliseconds between keystrokes (default: 30).'),
		...targetFieldsNoText,
		...commonFields
	}),
	toInput: (a) => ({
		type: 'type',
		text: a.text,
		key: a.key,
		clearFirst: a.clearFirst,
		delay: a.delay,
		// `text` here is what to type, so targeting is by selector/coords only.
		target: a.selector || typeof a.x === 'number' ? toTarget({ x: a.x, y: a.y, selector: a.selector, nth: a.nth }) : undefined
	})
};

export const press: ActionDef = {
	type: 'press',
	kind: 'input',
	doc: `press {keys} — a key chord: "Control+A", "Meta+Shift+P", "Alt+ArrowLeft".
  Modifiers are held for the duration and released in reverse, which is what shortcuts and IDE-like pages expect.`,
	schema: z.object({
		type: z.literal('press'),
		keys: z.string().describe('Chord, e.g. "Control+Shift+K". Aliases: Ctrl, Cmd, Command, Option, Meta.'),
		...commonFields
	}),
	toInput: (a) => ({ type: 'press', keys: a.keys })
};

export const paste: ActionDef = {
	type: 'paste',
	kind: 'input',
	doc: `paste {text} — insert text into the focused field as a paste.
  Faster than \`type\` for long strings, and raises the same input events. Note this pastes the given text, not the user's clipboard.`,
	schema: z.object({
		type: z.literal('paste'),
		text: z.string().describe('Text to insert at the caret.'),
		...commonFields
	}),
	toInput: (a) => ({ type: 'paste', text: a.text })
};

export const move: ActionDef = {
	type: 'move',
	kind: 'input',
	doc: `move {selector|text|x,y, dwellMs?} — move the pointer without clicking.
  Use dwellMs to linger so hover menus and tooltips have time to appear; that delay is usually why a submenu "never opens".`,
	schema: z.object({
		type: z.literal('move'),
		...targetFields,
		dwellMs: z.number().optional().describe('Stay put for this long after arriving (hover reveals).'),
		steps: z.number().optional().describe('Interpolation steps for the movement (default: 8).'),
		...commonFields
	}),
	toInput: (a) => ({ type: 'move', target: toTarget(a), dwellMs: a.dwellMs, steps: a.steps })
};

export const scroll: ActionDef = {
	type: 'scroll',
	kind: 'input',
	doc: `scroll {deltaY, deltaX?, selector?|x,y?, smooth?} — wheel scroll.
  deltaY positive scrolls down. Give a selector/coords to scroll a specific pane: the wheel applies to whatever is under the pointer, so an inner scroller needs the pointer over it.`,
	schema: z.object({
		type: z.literal('scroll'),
		deltaX: z.number().optional().describe('Horizontal pixels (positive = right).'),
		deltaY: z.number().optional().describe('Vertical pixels (positive = down).'),
		smooth: z.boolean().optional().describe('Break the scroll into steps, as a trackpad would.'),
		...targetFields,
		...commonFields
	}),
	toInput: (a) => ({
		type: 'scroll',
		deltaX: a.deltaX,
		deltaY: a.deltaY,
		smooth: a.smooth,
		target: a.selector || a.text || typeof a.x === 'number' ? toTarget(a) : undefined
	})
};

export const drag: ActionDef = {
	type: 'drag',
	kind: 'input',
	doc: `drag {from, to, mode?, holdMs?, durationMs?} — press, move, release.
  Covers sliders, canvases, sortable lists, kanban cards and map panning.
  mode is detected from the source element: "pointer" (mouse events, what JS drag libraries listen for) or "native" (HTML5 draggable="true", which ignores plain mouse events and needs CDP drag interception). Override only when detection is wrong.`,
	schema: z.object({
		type: z.literal('drag'),
		from: pointSchema.describe('Where the drag starts.'),
		to: pointSchema.describe('Where it is dropped.'),
		mode: z.enum(['pointer', 'native']).optional().describe('Force a drag protocol instead of detecting it.'),
		holdMs: z.number().optional().describe('Pause after pressing before moving (default: 120). Many drag libraries need this to arm.'),
		durationMs: z.number().optional().describe('How long the movement itself takes.'),
		steps: z.number().optional().describe('Interpolation steps (default: 16). More steps = smoother for canvases.'),
		button: z.enum(['left', 'right', 'middle']).optional(),
		...commonFields
	}),
	toInput: (a) => ({
		type: 'drag',
		from: toTarget(a.from),
		to: toTarget(a.to),
		mode: a.mode,
		holdMs: a.holdMs,
		durationMs: a.durationMs,
		steps: a.steps,
		button: a.button
	})
};

export const longPress: ActionDef = {
	type: 'long_press',
	kind: 'input',
	doc: `long_press {selector|text|x,y, holdMs?} — press and hold (default 700ms).
  Raises context menus and triggers touch-style "press and hold" affordances.`,
	schema: z.object({
		type: z.literal('long_press'),
		...targetFields,
		holdMs: z.number().optional().describe('Hold duration in ms (default: 700).'),
		button: z.enum(['left', 'right', 'middle']).optional(),
		...commonFields
	}),
	toInput: (a) => ({ type: 'long_press', target: toTarget(a), holdMs: a.holdMs, button: a.button })
};

export const tap: ActionDef = {
	type: 'tap',
	kind: 'input',
	doc: `tap {selector|text|x,y} — a real touch tap.
  Touch emulation is switched on for the gesture, so the page's touch handlers fire and touch feature detection reports true. Use on mobile/tablet viewports where a mouse click takes a different code path.`,
	schema: z.object({
		type: z.literal('tap'),
		...targetFields,
		holdMs: z.number().optional().describe('Contact time before lifting (default: 60).'),
		...commonFields
	}),
	toInput: (a) => ({ type: 'tap', target: toTarget(a), holdMs: a.holdMs })
};

export const swipe: ActionDef = {
	type: 'swipe',
	kind: 'input',
	doc: `swipe {from, to, durationMs?} — a one-finger touch drag.
  This is how carousels, pull-to-refresh, bottom sheets and swipe-to-delete are tested; a wheel scroll does not exercise any of them.`,
	schema: z.object({
		type: z.literal('swipe'),
		from: pointSchema.describe('Where the finger lands.'),
		to: pointSchema.describe('Where it lifts.'),
		durationMs: z.number().optional().describe('Gesture duration (default: 300). Shorter reads as a fling.'),
		steps: z.number().optional().describe('Touch move samples (default: 12).'),
		...commonFields
	}),
	toInput: (a) => ({
		type: 'swipe',
		from: toTarget(a.from),
		to: toTarget(a.to),
		durationMs: a.durationMs,
		steps: a.steps
	})
};

export const pinch: ActionDef = {
	type: 'pinch',
	kind: 'input',
	doc: `pinch {scale, x?, y?, durationMs?} — two-finger pinch about a point.
  scale > 1 zooms in, < 1 zooms out. Defaults to the viewport centre.`,
	schema: z.object({
		type: z.literal('pinch'),
		scale: z.number().optional().describe('Zoom factor (default: 2). Below 1 pinches in.'),
		x: z.number().optional().describe('Centre X (default: viewport centre).'),
		y: z.number().optional().describe('Centre Y (default: viewport centre).'),
		durationMs: z.number().optional(),
		...commonFields
	}),
	toInput: (a) => ({
		type: 'pinch',
		scale: a.scale,
		center: typeof a.x === 'number' && typeof a.y === 'number' ? { x: a.x, y: a.y } : undefined,
		durationMs: a.durationMs
	})
};

export const wait: ActionDef = {
	type: 'wait',
	kind: 'input',
	doc: `wait {ms} — pause.
  A blunt instrument: prefer wait_for, which returns as soon as the condition holds instead of always costing the full delay.`,
	schema: z.object({
		type: z.literal('wait'),
		ms: z.number().describe('Milliseconds to pause.'),
		...commonFields
	}),
	toInput: (a) => ({ type: 'wait', delay: a.ms })
};

export const focus: ActionDef = {
	type: 'focus',
	kind: 'input',
	doc: `focus {selector|text} — focus an element without clicking it.
  Useful when a click would also trigger something (a link, a toggle).`,
	schema: z.object({
		type: z.literal('focus'),
		...targetFields,
		...commonFields
	}),
	toInput: (a) => ({ type: 'focus', target: toTarget(a) })
};

export const clear: ActionDef = {
	type: 'clear',
	kind: 'input',
	doc: `clear {selector?|x,y?} — empty a field (select all, delete).`,
	schema: z.object({
		type: z.literal('clear'),
		...targetFields,
		...commonFields
	}),
	toInput: (a) => ({ type: 'clear', target: toTarget(a) })
};

export const selectOption: ActionDef = {
	type: 'select_option',
	kind: 'input',
	doc: `select_option {selector, value|label|index} — choose from a native <select>.
  Clicking a <select> opens a browser-owned popup that is not part of the page, so it cannot be driven by clicks; this sets the value and raises input+change.`,
	schema: z.object({
		type: z.literal('select_option'),
		...targetFields,
		value: z.string().optional().describe('Match the option\'s value attribute.'),
		label: z.string().optional().describe('Match the option\'s visible text (exact, then substring).'),
		index: z.number().int().min(0).optional().describe('Match by position.'),
		...commonFields
	}),
	toInput: (a) => ({
		type: 'select_option',
		target: toTarget(a),
		value: a.value,
		label: a.label,
		index: a.index
	})
};

export const extract: ActionDef = {
	type: 'extract',
	kind: 'input',
	doc: `extract {selector, attribute?, all?} — read a value out of the page.
  The selector is forgiving: "email", "#email" and [name=email] all resolve. attribute reads a specific one; all returns every match.`,
	schema: z.object({
		type: z.literal('extract'),
		selector: z.string().describe('Element identifier: a CSS selector, an id, a name, or a test id.'),
		attribute: z.string().optional().describe('Read this attribute instead of auto-detecting value/text.'),
		all: z.boolean().optional().describe('Return every match instead of the first.'),
		...commonFields
	}),
	toInput: (a) => ({ type: 'extract_data', selector: a.selector, attribute: a.attribute, all: a.all })
};

export const upload: ActionDef = {
	type: 'upload',
	kind: 'input',
	doc: `upload {selector, files} — attach files to a file input.
  Paths are relative to the project directory and must stay inside it. A file chooser cannot be driven any other way: it is an OS dialog, not part of the page.`,
	schema: z.object({
		type: z.literal('upload'),
		...targetFieldsNoText,
		files: z.array(z.string()).min(1).describe('Project-relative file paths.'),
		...commonFields
	}),
	toInput: async (a, ctx) => ({
		type: 'upload',
		target: toTarget({ x: a.x, y: a.y, selector: a.selector, nth: a.nth }),
		files: await resolveProjectFiles(a.files, ctx.projectId)
	})
};

export const inputActions: ActionDef[] = [
	click,
	type_,
	press,
	paste,
	move,
	scroll,
	drag,
	longPress,
	tap,
	swipe,
	pinch,
	wait,
	focus,
	clear,
	selectOption,
	extract,
	upload
];
