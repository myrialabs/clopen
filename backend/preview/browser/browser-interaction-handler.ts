/**
 * Browser Interaction Handler
 *
 * Executes agent-driven input against a tab: mouse, keyboard, touch and the
 * few gestures that cannot be expressed as either (native drag, file upload,
 * <select>).
 *
 * Two rules shape everything here:
 *
 * 1. Drive real input, not the DOM. Clicks go through CDP mouse events at a
 *    point, so a page cannot tell an agent apart from a person — and handlers
 *    the page installed on the real event are the ones that run. The DOM is
 *    touched only where no input event exists (reading values, <select>,
 *    uploads).
 * 2. Report every action. A batch that stops halfway must say so, and say
 *    where, or the agent will happily plan its next step on top of a state
 *    that never happened.
 */

import { EventEmitter } from 'events';
import type { CDPSession, ElementHandle, KeyInput, Page } from 'puppeteer';
import type {
	BrowserActionResult,
	BrowserActionTarget,
	BrowserAutonomousAction,
	BrowserTab
} from './types';
import { debug } from '$shared/utils/logger';
import { sleep } from '$shared/utils/async';
import { browserMcpControl } from './browser-mcp-control';
import { isNativeDraggable, resolveHandle, resolveTarget } from './element-locator';

/** Modifier aliases an agent (or a model trained on other tools) might use. */
const MODIFIER_ALIASES: Record<string, 'Control' | 'Shift' | 'Alt' | 'Meta'> = {
	ctrl: 'Control',
	control: 'Control',
	shift: 'Shift',
	alt: 'Alt',
	option: 'Alt',
	meta: 'Meta',
	cmd: 'Meta',
	command: 'Meta',
	super: 'Meta',
	win: 'Meta'
};

export interface AutonomousRunOutcome {
	results: BrowserActionResult[];
	/** True when the run stopped early because the tab or the stream went away. */
	aborted: boolean;
}

export class BrowserInteractionHandler extends EventEmitter {
	// Track cursor positions per session
	private sessionCursorPositions: Map<string, { x: number; y: number }> = new Map();

	constructor() {
		super();
	}

	// ========================================================================
	// Cursor telemetry
	// ========================================================================

	/**
	 * Publish where the agent's pointer is.
	 *
	 * `pressed` is what makes a drag legible on screen: without it the overlay
	 * cursor glides across the page with no indication the button is down, and
	 * a drag looks identical to a move.
	 */
	private publishCursor(sessionId: string, x: number, y: number, pressed = false) {
		this.updateCursorPosition(sessionId, x, y);
		browserMcpControl.emitCursorPosition(sessionId, x, y, pressed);
	}

	private publishClick(sessionId: string, x: number, y: number, button: 'left' | 'right' | 'middle' = 'left') {
		browserMcpControl.emitCursorClick(sessionId, x, y, button);
	}

	// MCP-optimized mouse movement with smooth curves and ease-out easing
	private async mcpMouseMove(
		page: Page,
		fromX: number,
		fromY: number,
		toX: number,
		toY: number,
		steps: number = 8,
		opts: { pressed?: boolean; totalMs?: number } = {}
	) {
		const controlPointX = fromX + (toX - fromX) * 0.5 + (Math.random() - 0.5) * 50;
		const controlPointY = fromY + (toY - fromY) * 0.5 + (Math.random() - 0.5) * 50;

		// Get session for emitting cursor position
		const sessionId = (page as any).__sessionId;
		const perStepDelay = opts.totalMs ? Math.max(0, opts.totalMs / Math.max(1, steps)) : null;

		for (let i = 0; i <= steps; i++) {
			const t = i / steps;

			// Apply ease-out cubic easing: starts fast, ends slow
			const easedT = 1 - Math.pow(1 - t, 3);

			// Quadratic Bezier curve for natural movement with ease-out easing
			const x = Math.round((1 - easedT) * (1 - easedT) * fromX + 2 * (1 - easedT) * easedT * controlPointX + easedT * easedT * toX);
			const y = Math.round((1 - easedT) * (1 - easedT) * fromY + 2 * (1 - easedT) * easedT * controlPointY + easedT * easedT * toY);

			await page.mouse.move(x, y);

			// Emit cursor position for visual tracking
			if (sessionId) this.publishCursor(sessionId, x, y, opts.pressed);

			// Smooth delay between movements (15-25ms) for MCP automation
			await sleep(perStepDelay ?? 15 + Math.random() * 10);
		}
	}

	// MCP-optimized typing with fast, consistent speed
	private async mcpType(page: Page, text: string, baseDelay: number = 30) {
		for (let i = 0; i < text.length; i++) {
			const char = text[i];

			// Fast typing with slight variance (20-40ms) for MCP automation
			const delay = baseDelay + Math.random() * 10;

			await page.keyboard.type(char, { delay });
		}
	}

	// Get current mouse position from session tracking
	private getCurrentMousePosition(sessionId: string): { x: number; y: number } {
		const stored = this.sessionCursorPositions.get(sessionId);
		if (stored) {
			return stored;
		}

		// Default to center of viewport for first action
		const defaultPos = { x: 400, y: 300 };
		this.sessionCursorPositions.set(sessionId, defaultPos);
		return defaultPos;
	}

	// Update and persist cursor position for session
	private updateCursorPosition(sessionId: string, x: number, y: number) {
		const position = { x, y };
		this.sessionCursorPositions.set(sessionId, position);
	}

	// Clear cursor position for session (when session ends)
	public clearSessionCursor(sessionId: string) {
		this.sessionCursorPositions.delete(sessionId);
	}

	// Clear all session cursors (when cleaning up all sessions)
	public clearAllSessionCursors() {
		this.sessionCursorPositions.clear();
	}

	// ========================================================================
	// Helpers
	// ========================================================================

	/**
	 * Where should this action land?
	 *
	 * `target` (selector/text/coords) wins; bare x/y is the shorthand kept for
	 * coordinates read off a screenshot.
	 */
	private async pointFor(
		page: Page,
		action: BrowserAutonomousAction,
		target?: BrowserActionTarget
	): Promise<{ x: number; y: number; described: string }> {
		const resolved = target ?? action.target ??
			(typeof action.x === 'number' && typeof action.y === 'number'
				? { x: action.x, y: action.y }
				: action.selector
					? { selector: action.selector }
					: undefined);

		return resolveTarget(page, resolved, { scrollIntoView: !action.noScroll });
	}

	/** Move the pointer to a point, animating so the overlay cursor tracks it. */
	private async glideTo(
		sessionId: string,
		page: Page,
		to: { x: number; y: number },
		opts: { steps?: number; pressed?: boolean; totalMs?: number } = {}
	) {
		const from = this.getCurrentMousePosition(sessionId);
		await this.mcpMouseMove(page, from.x, from.y, to.x, to.y, opts.steps ?? 8, {
			pressed: opts.pressed,
			totalMs: opts.totalMs
		});
		this.publishCursor(sessionId, to.x, to.y, opts.pressed);
	}

	/** "Control+Shift+K" → modifiers to hold plus the key to press. */
	private parseChord(chord: string): { modifiers: Array<'Control' | 'Shift' | 'Alt' | 'Meta'>; key: string } {
		const parts = chord.split('+').map((p) => p.trim()).filter(Boolean);
		const modifiers: Array<'Control' | 'Shift' | 'Alt' | 'Meta'> = [];
		let key = '';

		for (const part of parts) {
			const modifier = MODIFIER_ALIASES[part.toLowerCase()];
			if (modifier) {
				if (!modifiers.includes(modifier)) modifiers.push(modifier);
			} else {
				key = part;
			}
		}

		return { modifiers, key };
	}

	/**
	 * Touch has to be turned on before it can be dispatched: without emulation
	 * the renderer drops touch events and the page's own feature detection
	 * (`'ontouchstart' in window`) reports false, so mobile-only handlers never
	 * even get installed.
	 */
	private async withTouch<T>(page: Page, fn: (client: CDPSession) => Promise<T>): Promise<T> {
		const client = await page.createCDPSession();
		try {
			await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
			return await fn(client);
		} finally {
			await client.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
			await client.detach().catch(() => {});
		}
	}

	// ========================================================================
	// Batch execution
	// ========================================================================

	async performAutonomousActions(
		sessionId: string,
		session: BrowserTab,
		actions: BrowserAutonomousAction[],
		isValidSession: () => boolean
	): Promise<AutonomousRunOutcome> {
		const results: BrowserActionResult[] = [];
		const page = session.page;

		// Store session ID on page for cursor tracking
		(page as any).__sessionId = sessionId;

		for (let i = 0; i < actions.length; i++) {
			// Check if session is still valid before each action
			if (!isValidSession()) {
				debug.warn('preview', `⚠️ Session ${sessionId} is no longer valid, stopping autonomous actions at ${i + 1}/${actions.length}`);
				return { results, aborted: true };
			}

			const action = actions[i];

			try {
				const outcome = await this.runAction(sessionId, session, action);
				results.push({
					action: action.type,
					ok: true,
					detail: outcome.detail,
					data: outcome.data,
					selector: outcome.selector,
					attribute: outcome.attribute,
					timestamp: Date.now()
				});
			} catch (error) {
				const message = (error as Error)?.message || 'Unknown error';
				debug.error('preview', `❌ Error performing action ${action.type}:`, error);

				results.push({ action: action.type, ok: false, error: message, timestamp: Date.now() });

				// A closed page cannot recover, and every later action would fail
				// with the same message — stop and let the caller report it.
				if (
					message.includes('Target page, context or browser has been closed') ||
					message.includes('Browser has been closed') ||
					message.includes('Page has been closed')
				) {
					debug.warn('preview', `⚠️ Browser/page closed during action ${i + 1}/${actions.length}, stopping autonomous actions`);
					return { results, aborted: true };
				}
			}

			// Fast delay between actions for MCP automation (50-100ms)
			if (action.type !== 'wait') {
				await sleep(50 + Math.random() * 50);
			}
		}

		// Emit test completed event to hide virtual cursor
		this.emit('test-completed', {
			sessionId: session.id,
			timestamp: Date.now()
		});

		return { results, aborted: false };
	}

	/**
	 * Run one action.
	 *
	 * Returns a one-line description for the report, plus whatever the action
	 * read back. Failure is signalled by throwing — every caller path then
	 * records it identically.
	 */
	private async runAction(
		sessionId: string,
		session: BrowserTab,
		action: BrowserAutonomousAction
	): Promise<{ detail: string; data?: unknown; selector?: string; attribute?: string }> {
		if (action.type === 'extract_data') {
			const identifier = action.selector ?? action.target?.selector;
			if (!identifier) throw new Error('extract_data needs a selector');

			const extracted = await this.extractData(session.page, identifier, action.attribute, action.all);
			if (extracted.error) throw new Error(extracted.error);

			return {
				detail: `extracted from "${extracted.selector ?? identifier}"`,
				data: extracted.data,
				selector: extracted.selector ?? identifier,
				attribute: extracted.attribute
			};
		}

		return { detail: await this.runGesture(sessionId, session, action) };
	}

	/** The gesture itself. Returns a one-line description for the report. */
	private async runGesture(
		sessionId: string,
		session: BrowserTab,
		action: BrowserAutonomousAction
	): Promise<string> {
		const page = session.page;

		switch (action.type) {
			case 'wait': {
				const ms = action.delay ?? 1000;
				await sleep(ms);
				return `waited ${ms}ms`;
			}

			case 'move': {
				const point = await this.pointFor(page, action);
				await this.glideTo(sessionId, page, point, { steps: action.steps ?? 8 });
				if (action.dwellMs) await sleep(action.dwellMs);
				return `moved to ${point.described}`;
			}

			case 'click': {
				const point = await this.pointFor(page, action);
				const button = action.button ?? 'left';
				const clickCount = action.clickCount ?? 1;

				await this.glideTo(sessionId, page, point, { steps: 8 });
				await sleep(30);
				this.publishClick(sessionId, point.x, point.y, button);

				// Native mouse click with slight variance for MCP automation
				const finalX = point.x + (Math.random() - 0.5) * 2;
				const finalY = point.y + (Math.random() - 0.5) * 2;
				await page.mouse.click(finalX, finalY, { button, count: clickCount });

				const label = clickCount > 1 ? `${clickCount}× click` : 'click';
				return `${label} (${button}) at ${point.described}`;
			}

			case 'long_press': {
				const point = await this.pointFor(page, action);
				const holdMs = action.holdMs ?? 700;

				await this.glideTo(sessionId, page, point, { steps: 8 });
				this.publishClick(sessionId, point.x, point.y, action.button ?? 'left');
				await page.mouse.down({ button: action.button ?? 'left' });
				this.publishCursor(sessionId, point.x, point.y, true);
				await sleep(holdMs);
				await page.mouse.up({ button: action.button ?? 'left' });
				this.publishCursor(sessionId, point.x, point.y, false);

				return `long press ${holdMs}ms at ${point.described}`;
			}

			case 'drag': {
				const fromTarget = action.from ?? action.target;
				const toTarget = action.to;
				if (!fromTarget || !toTarget) throw new Error('drag needs both `from` and `to`');

				const mode = action.mode ?? ((await isNativeDraggable(page, fromTarget)) ? 'native' : 'pointer');
				const from = await resolveTarget(page, fromTarget, { scrollIntoView: !action.noScroll });
				const to = await resolveTarget(page, toTarget, { scrollIntoView: !action.noScroll });

				if (mode === 'native') {
					// HTML5 drag-and-drop never sees plain mouse events — the browser
					// synthesises dragstart/dragover/drop itself, and only when drag
					// interception is on can CDP drive that protocol.
					await page.setDragInterception(true);
					try {
						await this.glideTo(sessionId, page, from, { steps: 6 });
						this.publishCursor(sessionId, from.x, from.y, true);

						const payload = await page.mouse.drag({ x: from.x, y: from.y }, { x: to.x, y: to.y });
						await this.glideTo(sessionId, page, to, { steps: action.steps ?? 12, pressed: true, totalMs: action.durationMs });
						await page.mouse.dragEnter({ x: to.x, y: to.y }, payload);
						await page.mouse.dragOver({ x: to.x, y: to.y }, payload);
						await page.mouse.drop({ x: to.x, y: to.y }, payload);
						await page.mouse.up();
					} finally {
						await page.setDragInterception(false).catch(() => {});
						this.publishCursor(sessionId, to.x, to.y, false);
					}
					return `native drag ${from.described} → ${to.described}`;
				}

				await this.glideTo(sessionId, page, from, { steps: 6 });
				await page.mouse.down({ button: action.button ?? 'left' });
				this.publishCursor(sessionId, from.x, from.y, true);
				// A pause after pressing is what most JS drag implementations wait
				// for before they consider the gesture started.
				await sleep(action.holdMs ?? 120);
				await this.glideTo(sessionId, page, to, {
					steps: action.steps ?? 16,
					pressed: true,
					totalMs: action.durationMs
				});
				await sleep(80);
				await page.mouse.up({ button: action.button ?? 'left' });
				this.publishCursor(sessionId, to.x, to.y, false);

				return `drag ${from.described} → ${to.described}`;
			}

			case 'scroll': {
				// Position over the intended scroll container first — the wheel
				// event applies to whatever is under the pointer, not to the page.
				let described = 'page';
				if (action.target || (typeof action.x === 'number' && typeof action.y === 'number')) {
					const point = await this.pointFor(page, action);
					await this.glideTo(sessionId, page, point, { steps: 4 });
					await sleep(50);
					described = point.described;
				}

				const deltaX = action.deltaX ?? 0;
				const deltaY = action.deltaY ?? 0;

				if (action.smooth) {
					const steps = 5;
					for (let s = 0; s < steps; s++) {
						await page.mouse.wheel({ deltaX: deltaX / steps, deltaY: deltaY / steps });
						await sleep(50);
					}
				} else {
					await page.mouse.wheel({ deltaX, deltaY });
				}

				return `scroll (${deltaX}, ${deltaY}) at ${described}`;
			}

			case 'type': {
				// Focus a field first when one was named, so a batch does not have
				// to interleave a click before every type.
				if (action.target || action.selector) {
					const point = await this.pointFor(page, action);
					await this.glideTo(sessionId, page, point, { steps: 6 });
					this.publishClick(sessionId, point.x, point.y);
					await page.mouse.click(point.x, point.y);
					await sleep(40);
				}

				const shouldClear = action.clearFirst !== false;
				if (shouldClear && action.text) {
					// Select all, then typing overwrites the selection.
					await page.keyboard.down('Control');
					await page.keyboard.press('KeyA');
					await page.keyboard.up('Control');
					await sleep(30);
				}

				if (action.text) {
					await this.mcpType(page, action.text, action.delay ?? 30);
					return `typed ${action.text.length} char(s)`;
				}
				if (action.key) {
					await page.keyboard.press(action.key as KeyInput);
					return `pressed ${action.key}`;
				}
				throw new Error('type needs either `text` or `key`');
			}

			case 'press': {
				const chord = action.keys || action.key;
				if (!chord) throw new Error('press needs `keys`');

				const { modifiers, key } = this.parseChord(chord);
				if (!key) throw new Error(`press could not find a key in "${chord}"`);

				for (const modifier of modifiers) await page.keyboard.down(modifier);
				try {
					await page.keyboard.press(key as KeyInput);
				} finally {
					for (const modifier of [...modifiers].reverse()) {
						await page.keyboard.up(modifier).catch(() => {});
					}
				}

				return `pressed ${chord}`;
			}

			case 'paste': {
				if (typeof action.text !== 'string') throw new Error('paste needs `text`');

				// Insert through CDP rather than synthesising Ctrl+V: the headless
				// browser's clipboard is not the agent's, and insertText raises the
				// same beforeinput/input events a real paste does.
				const client = await page.createCDPSession();
				try {
					await client.send('Input.insertText', { text: action.text });
				} finally {
					await client.detach().catch(() => {});
				}

				return `pasted ${action.text.length} char(s)`;
			}

			case 'focus': {
				const target = action.target ?? (action.selector ? { selector: action.selector } : undefined);
				if (!target) throw new Error('focus needs a target');

				const handle = await resolveHandle(page, target, { scrollIntoView: !action.noScroll });
				if (!handle) throw new Error('focus found no visible element');
				try {
					await handle.evaluate((el) => (el as HTMLElement).focus());
				} finally {
					await handle.dispose().catch(() => {});
				}

				return `focused ${target.selector ?? target.text}`;
			}

			case 'clear': {
				const target = action.target ?? (action.selector ? { selector: action.selector } : undefined);
				if (target) {
					const point = await this.pointFor(page, action, target);
					await this.glideTo(sessionId, page, point, { steps: 6 });
					await page.mouse.click(point.x, point.y);
					await sleep(40);
				}

				await page.keyboard.down('Control');
				await page.keyboard.press('KeyA');
				await page.keyboard.up('Control');
				await page.keyboard.press('Backspace');

				return 'cleared field';
			}

			case 'select_option': {
				const target = action.target ?? (action.selector ? { selector: action.selector } : undefined);
				if (!target) throw new Error('select_option needs a target');

				const handle = await resolveHandle(page, target, { scrollIntoView: !action.noScroll });
				if (!handle) throw new Error('select_option found no visible <select>');

				try {
					const chosen = await handle.evaluate(
						(el, value, label, index) => {
							const select = el as HTMLSelectElement;
							if (select.tagName !== 'SELECT') return null;

							const options = Array.from(select.options);
							const match =
								typeof index === 'number'
									? options[index]
									: value !== undefined
										? options.find((o) => o.value === value)
										: options.find((o) => o.textContent?.trim() === label) ??
											options.find((o) => o.textContent?.trim().toLowerCase().includes(String(label).toLowerCase()));

							if (!match) return null;

							select.value = match.value;
							// A programmatic value assignment fires nothing; frameworks
							// bind to these two events, so both have to be raised.
							select.dispatchEvent(new Event('input', { bubbles: true }));
							select.dispatchEvent(new Event('change', { bubbles: true }));
							return { value: match.value, label: match.textContent?.trim() ?? '' };
						},
						action.value,
						action.label,
						action.index
					);

					if (!chosen) throw new Error('No matching <option> (or the target was not a <select>)');
					return `selected "${chosen.label}" (${chosen.value})`;
				} finally {
					await handle.dispose().catch(() => {});
				}
			}

			case 'upload': {
				const target = action.target ?? (action.selector ? { selector: action.selector } : undefined);
				if (!target) throw new Error('upload needs a target');
				if (!action.files?.length) throw new Error('upload needs `files`');

				const handle = await resolveHandle(page, target, { scrollIntoView: !action.noScroll });
				if (!handle) throw new Error('upload found no visible file input');

				try {
					await (handle as ElementHandle<HTMLInputElement>).uploadFile(...action.files);
					return `uploaded ${action.files.length} file(s)`;
				} finally {
					await handle.dispose().catch(() => {});
				}
			}

			case 'tap': {
				const point = await this.pointFor(page, action);
				await this.withTouch(page, async (client) => {
					await client.send('Input.dispatchTouchEvent', {
						type: 'touchStart',
						touchPoints: [{ x: point.x, y: point.y, id: 1 }]
					});
					await sleep(action.holdMs ?? 60);
					await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
				});
				this.publishClick(sessionId, point.x, point.y);
				this.publishCursor(sessionId, point.x, point.y);

				return `tap at ${point.described}`;
			}

			case 'swipe': {
				const fromTarget = action.from ?? action.target;
				const toTarget = action.to;
				if (!fromTarget || !toTarget) throw new Error('swipe needs both `from` and `to`');

				const from = await resolveTarget(page, fromTarget, { scrollIntoView: !action.noScroll });
				const to = await resolveTarget(page, toTarget, { scrollIntoView: !action.noScroll });
				const steps = action.steps ?? 12;
				const totalMs = action.durationMs ?? 300;

				await this.withTouch(page, async (client) => {
					await client.send('Input.dispatchTouchEvent', {
						type: 'touchStart',
						touchPoints: [{ x: from.x, y: from.y, id: 1 }]
					});

					for (let s = 1; s <= steps; s++) {
						const t = s / steps;
						const x = Math.round(from.x + (to.x - from.x) * t);
						const y = Math.round(from.y + (to.y - from.y) * t);
						await client.send('Input.dispatchTouchEvent', {
							type: 'touchMove',
							touchPoints: [{ x, y, id: 1 }]
						});
						this.publishCursor(sessionId, x, y, true);
						await sleep(totalMs / steps);
					}

					await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
				});
				this.publishCursor(sessionId, to.x, to.y, false);

				return `swipe ${from.described} → ${to.described}`;
			}

			case 'pinch': {
				const centre = action.center ?? (await this.pointFor(page, action).catch(() => null)) ?? {
					x: page.viewport()?.width ? page.viewport()!.width / 2 : 400,
					y: page.viewport()?.height ? page.viewport()!.height / 2 : 300
				};
				const scale = action.scale ?? 2;
				const steps = action.steps ?? 10;
				const startSpread = 60;
				const endSpread = Math.max(10, startSpread * scale);

				await this.withTouch(page, async (client) => {
					const points = (spread: number) => [
						{ x: Math.round(centre.x - spread), y: Math.round(centre.y), id: 1 },
						{ x: Math.round(centre.x + spread), y: Math.round(centre.y), id: 2 }
					];

					await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(startSpread) });
					for (let s = 1; s <= steps; s++) {
						const spread = startSpread + (endSpread - startSpread) * (s / steps);
						await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(spread) });
						await sleep((action.durationMs ?? 300) / steps);
					}
					await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
				});

				return `pinch ×${scale} at (${Math.round(centre.x)}, ${Math.round(centre.y)})`;
			}

			default:
				throw new Error(`Unknown action type: ${(action as BrowserAutonomousAction).type}`);
		}
	}

	/**
	 * Read text or a value out of the page.
	 *
	 * The identifier is deliberately forgiving — agents pass `username`,
	 * `#username` and `[name="username"]` interchangeably — so every plausible
	 * spelling is tried before reporting a miss.
	 */
	private async extractData(
		page: Page,
		identifier: string,
		attribute?: string,
		all?: boolean
	): Promise<{ data: unknown; selector: string | null; attribute?: string; error?: string }> {
		const result = await page.evaluate(
			(id: string, attr: string | undefined, wantAll: boolean | undefined) => {
				const selectors = [
					id,
					`#${id}`,
					`.${id}`,
					`[id="${id}"]`,
					`[id*="${id}"]`,
					`[class*="${id}"]`,
					`[data-testid="${id}"]`,
					`[name="${id}"]`
				];

				let elements: Element[] = [];
				let usedSelector = '';

				for (const selector of selectors) {
					try {
						const found = Array.from(document.querySelectorAll(selector));
						if (found.length > 0) {
							elements = found;
							usedSelector = selector;
							break;
						}
					} catch {
						continue;
					}
				}

				if (elements.length === 0) {
					return { data: null, selector: null, attribute: null, tried: selectors.slice(0, 5) };
				}

				const readOne = (el: Element): { value: string | null; via: string } => {
					if (attr) return { value: el.getAttribute(attr), via: attr };

					const candidates: Array<{ name: string; read: () => string | undefined }> = [
						{ name: 'value', read: () => (el as HTMLInputElement).value },
						{ name: 'textContent', read: () => el.textContent?.trim() },
						{ name: 'innerText', read: () => (el as HTMLElement).innerText?.trim() },
						{ name: 'innerHTML', read: () => el.innerHTML?.trim() }
					];

					for (const candidate of candidates) {
						try {
							const value = candidate.read();
							if (value && value.length > 0) return { value, via: candidate.name };
						} catch {
							continue;
						}
					}
					return { value: null, via: '' };
				};

				if (wantAll) {
					const values = elements.map((el) => readOne(el).value).filter((v) => v !== null);
					return { data: values, selector: usedSelector, attribute: attr ?? 'auto', tried: [usedSelector] };
				}

				const single = readOne(elements[0]);
				return { data: single.value, selector: usedSelector, attribute: single.via, tried: [usedSelector] };
			},
			identifier,
			attribute,
			all
		);

		if (result.data === null || (Array.isArray(result.data) && result.data.length === 0)) {
			return {
				data: null,
				selector: result.selector,
				error: `Element not found or empty. Tried selectors: ${result.tried.join(', ')}`
			};
		}

		return { data: result.data, selector: result.selector, attribute: result.attribute ?? undefined };
	}
}
