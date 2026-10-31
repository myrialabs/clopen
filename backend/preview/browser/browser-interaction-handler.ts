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
import type { CDPSession, ElementHandle, Frame, KeyInput, Page } from 'puppeteer';
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
import { isPasteChord, parseChord, pressChord, selectAll } from './keyboard-chords';
import { pasteText } from './paste';
import type { PendingDialogInfo } from './browser-dialog-handler';

export interface AutonomousRunOutcome {
	results: BrowserActionResult[];
	/** True when the run stopped early because the tab or the stream went away. */
	aborted: boolean;
	/**
	 * The dialog that stopped the run. A page with a dialog open runs no script,
	 * so nothing after it could have worked — the agent has to answer it first.
	 */
	blockedBy?: PendingDialogInfo;
}

export interface InteractionDeps {
	/** The workspace clipboard — what a paste pastes. */
	readClipboard(): string;
	getPendingDialog(tabId: string): PendingDialogInfo | null;
	waitForDialog(tabId: string): { promise: Promise<PendingDialogInfo>; dispose: () => void };
}

/** Thrown inside an action that a dialog cut short, so its loops stop. */
class DialogInterrupt extends Error {
	constructor() {
		super('interrupted by a dialog');
	}
}

/**
 * How long a new batch waits for the previous one's interrupted action to
 * unwind. That action is parked inside a CDP call the dialog blocked; once the
 * dialog is answered it resumes, hits its next checkpoint and stops — but it
 * must finish doing so before new input starts, or the two would interleave.
 */
const INFLIGHT_SETTLE_MS = 5_000;

/** What a focused editable reads, and where it lives. */
interface FocusedField {
	frame: Frame;
	kind: 'input' | 'textarea' | 'editable';
	value: string;
	secret: boolean;
}

export class BrowserInteractionHandler extends EventEmitter {
	// Track cursor positions per session
	private sessionCursorPositions: Map<string, { x: number; y: number }> = new Map();

	/** Per tab: whether the batch running on it was cut short by a dialog. */
	private runTokens = new Map<string, { interrupted: boolean }>();

	/** Per tab: the action still unwinding from an interrupted batch. */
	private inflight = new Map<string, Promise<unknown>>();

	private deps: InteractionDeps;

	constructor(deps: InteractionDeps) {
		super();
		this.deps = deps;
	}

	/** Stop here if a dialog has cut this tab's batch short. */
	private checkpoint(sessionId: string): void {
		if (this.runTokens.get(sessionId)?.interrupted) throw new DialogInterrupt();
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

	/**
	 * Announce a whole pointer movement at once.
	 *
	 * The overlay used to be fed one event per interpolation step, 16ms apart,
	 * and drew whatever arrived. Any delay on the way — a busy event loop, a
	 * congested socket — bunched those events up, and the pointer stuttered
	 * across the page. The viewer now gets the path and its duration and
	 * animates it locally, so the motion is smooth whatever the server is
	 * doing; the position the pointer comes to rest at still follows as a
	 * normal cursor event.
	 */
	private publishGlide(
		sessionId: string,
		glide: {
			from: { x: number; y: number };
			control: { x: number; y: number };
			to: { x: number; y: number };
			durationMs: number;
			pressed?: boolean;
			easing?: 'out' | 'linear';
		}
	) {
		this.updateCursorPosition(sessionId, glide.to.x, glide.to.y);
		browserMcpControl.emitCursorGlide(sessionId, {
			from: glide.from,
			control: glide.control,
			to: glide.to,
			durationMs: Math.max(0, Math.round(glide.durationMs)),
			pressed: !!glide.pressed,
			easing: glide.easing ?? 'out'
		});
	}

	/**
	 * A few words for the caption beside the agent's pointer.
	 *
	 * Written from the watcher's side of the screen, not the agent's: it answers
	 * "what is happening to my page right now", so it names the gesture rather
	 * than the action type, and never carries a selector or the text being typed
	 * — a password would end up on screen, and the caption has room for about
	 * three words before it stops being a caption.
	 */
	private describeActivity(action: BrowserAutonomousAction): string {
		switch (action.type) {
			case 'click':
				return action.button === 'right' ? 'Opening a menu' : 'Clicking';
			case 'long_press':
				return 'Holding';
			case 'move':
				return 'Moving';
			case 'drag':
				return 'Dragging';
			case 'scroll':
				return 'Scrolling';
			case 'type':
				return action.text !== undefined ? 'Typing' : 'Pressing a key';
			case 'press':
				return `Pressing ${action.keys || action.key}`;
			case 'paste':
				return 'Pasting';
			case 'focus':
				return 'Selecting a field';
			case 'clear':
				return 'Clearing a field';
			case 'select_option':
				return 'Choosing an option';
			case 'upload':
				return 'Attaching a file';
			case 'tap':
				return 'Tapping';
			case 'swipe':
				return 'Swiping';
			case 'pinch':
				return 'Zooming';
			case 'extract_data':
				return 'Reading the page';
			case 'wait':
				return 'Waiting';
			default:
				return 'Working';
		}
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
		const stepDelay = opts.totalMs ? Math.max(0, opts.totalMs / Math.max(1, steps)) : 20;

		// One announcement for the whole path; the viewer animates it.
		if (sessionId) {
			this.publishGlide(sessionId, {
				from: { x: fromX, y: fromY },
				control: { x: controlPointX, y: controlPointY },
				to: { x: toX, y: toY },
				durationMs: steps * stepDelay,
				pressed: opts.pressed
			});
		}

		for (let i = 0; i <= steps; i++) {
			if (sessionId) this.checkpoint(sessionId);
			const t = i / steps;

			// Apply ease-out cubic easing: starts fast, ends slow
			const easedT = 1 - Math.pow(1 - t, 3);

			// Quadratic Bezier curve for natural movement with ease-out easing
			const x = Math.round((1 - easedT) * (1 - easedT) * fromX + 2 * (1 - easedT) * easedT * controlPointX + easedT * easedT * toX);
			const y = Math.round((1 - easedT) * (1 - easedT) * fromY + 2 * (1 - easedT) * easedT * controlPointY + easedT * easedT * toY);

			await page.mouse.move(x, y);

			// Smooth delay between movements (15-25ms) for MCP automation
			await sleep(opts.totalMs ? stepDelay : 15 + Math.random() * 10);
		}
	}

	// MCP-optimized typing with fast, consistent speed
	private async mcpType(page: Page, text: string, baseDelay: number = 30) {
		const sessionId = (page as any).__sessionId;
		for (let i = 0; i < text.length; i++) {
			if (sessionId) this.checkpoint(sessionId);
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

	/**
	 * Where the agent's pointer stands on a tab, if it has ever moved there.
	 *
	 * Read when a viewer builds its state from scratch — a page reload, a
	 * project switch, a colleague opening the panel halfway through a run. The
	 * pointer only sends updates while it is moving, so without this a viewer
	 * that joins between two actions has a lock, a caption, and no idea where
	 * on the page any of it is happening.
	 */
	public getCursorPosition(sessionId: string): { x: number; y: number } | null {
		const stored = this.sessionCursorPositions.get(sessionId);
		return stored ? { ...stored } : null;
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

		// Already there. Animating anyway would still cost the full duration, and
		// a batch that works one control repeatedly pays that on every action.
		// Never skipped while the button is held: a drag needs its real moves.
		if (!opts.pressed && Math.abs(from.x - to.x) < 2 && Math.abs(from.y - to.y) < 2) {
			await page.mouse.move(to.x, to.y);
			this.publishCursor(sessionId, to.x, to.y);
			return;
		}

		await this.mcpMouseMove(page, from.x, from.y, to.x, to.y, opts.steps ?? 8, {
			pressed: opts.pressed,
			totalMs: opts.totalMs
		});
		this.publishCursor(sessionId, to.x, to.y, opts.pressed);
	}

	/**
	 * Walk the *overlay* pointer to a point, dispatching no real input.
	 *
	 * Half the actions never touch the mouse — keyboard chords, `focus`,
	 * `select_option`, touch gestures, reads — which left them with nothing on
	 * screen: the page changed and no cursor explained why. Driving the real
	 * pointer there instead would be worse than silent, because hovering is an
	 * input the agent never asked for: it opens menus, arms tooltips, and for a
	 * read it can change the very value being read.
	 */
	private async glideOverlay(sessionId: string, to: { x: number; y: number }, steps = 6) {
		const from = this.getCurrentMousePosition(sessionId);

		if (Math.abs(from.x - to.x) < 2 && Math.abs(from.y - to.y) < 2) {
			this.publishCursor(sessionId, to.x, to.y);
			return;
		}

		// Same ease-out as the real glide, so the two read as one pointer.
		const durationMs = steps * 16;
		this.publishGlide(sessionId, {
			from,
			control: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
			to,
			durationMs
		});
		await sleep(durationMs);
		this.checkpoint(sessionId);

		this.publishCursor(sessionId, to.x, to.y);
	}

	/**
	 * The same, for an element the action has already resolved. Preferred where
	 * a handle is at hand: re-resolving the target would sweep every frame a
	 * second time purely to draw a cursor.
	 */
	private async showHandle(
		sessionId: string,
		handle: ElementHandle<Element>,
		opts: { pulse?: boolean } = {}
	) {
		const box = await handle.boundingBox().catch(() => null);
		if (!box) return;

		const point = {
			x: Math.round(box.x + box.width / 2),
			y: Math.round(box.y + box.height / 2)
		};

		await this.glideOverlay(sessionId, point);
		if (opts.pulse) this.publishClick(sessionId, point.x, point.y);
	}

	/**
	 * Where the keyboard is aimed, in page coordinates.
	 *
	 * Keystrokes carry no coordinates, so the focused field is the only honest
	 * answer to "where is this going" — and without it typing is the one gesture
	 * that changes the page with the pointer parked somewhere unrelated.
	 */
	private async focusedPoint(page: Page): Promise<{ x: number; y: number } | null> {
		try {
			return await page.evaluate(() => {
				let element: Element | null = document.activeElement;

				// A shadow root keeps its own activeElement; the outer document only
				// names the host, whose box is the whole component rather than the
				// field inside it.
				while (element && (element as HTMLElement).shadowRoot?.activeElement) {
					element = (element as HTMLElement).shadowRoot!.activeElement;
				}

				if (!element || element === document.body || element === document.documentElement) return null;

				const rect = element.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) return null;
				// Scrolled out of sight — pointing off-viewport would draw the cursor
				// outside the frame entirely.
				if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return null;

				return {
					x: Math.round(rect.left + rect.width / 2),
					y: Math.round(rect.top + rect.height / 2)
				};
			});
		} catch {
			return null;
		}
	}

	/** Point the overlay at the focused field, for gestures that are pure keyboard. */
	private async showFocused(sessionId: string, page: Page, opts: { pulse?: boolean } = {}) {
		const point = await this.focusedPoint(page);
		if (!point) {
			// Nothing focused: keep the pointer asserted where it is, so the run
			// never goes dark mid-batch.
			const parked = this.getCurrentMousePosition(sessionId);
			this.publishCursor(sessionId, parked.x, parked.y);
			return;
		}

		await this.glideOverlay(sessionId, point);
		if (opts.pulse) this.publishClick(sessionId, point.x, point.y);
	}

	/**
	 * Touch has to be turned on before it can be dispatched: without emulation
	 * the renderer drops touch events and the page's own feature detection
	 * (`'ontouchstart' in window`) reports false, so mobile-only handlers never
	 * even get installed.
	 */
	private async withTouch<T>(page: Page, fn: (client: CDPSession) => Promise<T>): Promise<T> {
		const client = await page.createCDPSession();
		// A phone or tablet tab has touch on for good — its page was built
		// around it. Switching it off after the gesture would leave that page
		// believing it had lost its touchscreen.
		const touchIsPermanent = page.viewport()?.hasTouch === true;
		try {
			if (!touchIsPermanent) {
				await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
			}
			return await fn(client);
		} finally {
			if (!touchIsPermanent) {
				await client.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
			}
			await client.detach().catch(() => {});
		}
	}

	// ========================================================================
	// Field verification
	// ========================================================================

	/**
	 * The focused editable field and what it reads, in whichever frame has it.
	 * Null when focus is on something that is not a text field.
	 */
	private async readFocusedField(page: Page): Promise<FocusedField | null> {
		const frames = page.frames().filter((frame) => !frame.isDetached());
		// Child frames first: when focus is inside one, the main frame only
		// reports the <iframe> element.
		for (const frame of [...frames.slice(1), frames[0]].filter(Boolean)) {
			try {
				const field = await frame.evaluate(() => {
					let active: Element | null = document.activeElement;
					while (active && (active as HTMLElement).shadowRoot?.activeElement) {
						active = (active as HTMLElement).shadowRoot!.activeElement;
					}
					if (!active || active === document.body || active.tagName === 'IFRAME') return null;

					if (active.tagName === 'INPUT') {
						const type = ((active as HTMLInputElement).type || 'text').toLowerCase();
						const nonText = ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image'];
						if (nonText.includes(type)) return null;
						return { kind: 'input' as const, value: (active as HTMLInputElement).value, secret: type === 'password' };
					}
					if (active.tagName === 'TEXTAREA') {
						return { kind: 'textarea' as const, value: (active as HTMLTextAreaElement).value, secret: false };
					}
					if ((active as HTMLElement).isContentEditable) {
						return { kind: 'editable' as const, value: (active as HTMLElement).innerText, secret: false };
					}
					return null;
				});
				if (field) return { frame, ...field };
			} catch {
				// Frame navigated away mid-read.
			}
		}
		return null;
	}

	/**
	 * Confirm a fill replaced what was there, and make it so if it did not.
	 *
	 * Select-all is a keyboard shortcut, and a page can swallow it — a
	 * controlled React input that re-renders between the keystrokes, a widget
	 * that binds Ctrl/⌘+A to something else. When that happens the new text
	 * lands beside the old ("ABC" + "DEF" = "ABCDEF"), and the agent, told it
	 * typed six characters, carried on with a corrupted form. So the field is
	 * read back: if the old text is still in it, the value is set through the
	 * native setter with an input event (which is what frameworks bind to), and
	 * if even that does not hold, the action fails with what the field reads.
	 *
	 * A field that reformats its input (a phone mask, thousands separators) is
	 * not a failure: the agent is simply told what the field now reads.
	 */
	private async settleFill(page: Page, text: string, before: FocusedField | null, label?: string): Promise<string> {
		const done = label ?? `typed ${text.length} char(s)`;
		const after = await this.readFocusedField(page);
		if (!after || after.value === text) return done;

		const show = (field: FocusedField) =>
			field.secret ? '(hidden: password field)' : `"${field.value.length > 120 ? `${field.value.slice(0, 120)}…` : field.value}"`;

		const leftover = !!before?.value && after.value.includes(before.value);
		if (!leftover) return `${done} → the field reads ${show(after)}`;

		await after.frame
			.evaluate((value: string) => {
				let active: Element | null = document.activeElement;
				while (active && (active as HTMLElement).shadowRoot?.activeElement) {
					active = (active as HTMLElement).shadowRoot!.activeElement;
				}
				if (!active) return;

				if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') {
					const proto = active.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
					// The prototype's setter, not the element's: React shadows `value`
					// on the instance and would otherwise swallow the change.
					Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(active, value);
					active.dispatchEvent(new Event('input', { bubbles: true }));
					active.dispatchEvent(new Event('change', { bubbles: true }));
					return;
				}

				if ((active as HTMLElement).isContentEditable) {
					window.getSelection()?.selectAllChildren(active);
					if (value) document.execCommand('insertText', false, value);
					else document.execCommand('delete');
				}
			}, text)
			.catch(() => {});

		const fixed = await this.readFocusedField(page);
		if (!fixed || fixed.value === text) {
			return `${done} (select-all did not take in this field, so the value was set directly)`;
		}
		if (before?.value && fixed.value.includes(before.value)) {
			throw new Error(`could not replace the field's previous text — it reads ${show(fixed)}`);
		}
		return `${done} (value set directly) → the field reads ${show(fixed)}`;
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

		try {
			return await this.runBatch(sessionId, session, actions, isValidSession, results);
		} finally {
			// The agent keeps the tab between batches, so the pointer stays — but
			// it is no longer doing the last thing it said it was, and a caption
			// left reading "Typing" over a page nothing is typing into is worse
			// than no caption at all.
			browserMcpControl.emitActivity(sessionId, null);
		}
	}

	private async runBatch(
		sessionId: string,
		session: BrowserTab,
		actions: BrowserAutonomousAction[],
		isValidSession: () => boolean,
		results: BrowserActionResult[]
	): Promise<AutonomousRunOutcome> {
		const page = session.page;

		// Store session ID on page for cursor tracking
		(page as any).__sessionId = sessionId;

		// Show the pointer before the first gesture, parked where the last batch
		// left it. Otherwise the only cursor events in a run are the ones a glide
		// emits, so a batch that opens with a keystroke or a scroll moves the page
		// with nothing on screen to attribute it to.
		const parked = this.getCurrentMousePosition(sessionId);
		this.publishCursor(sessionId, parked.x, parked.y);

		// While the dialog is still open there is nothing to wait for: the
		// interrupted action stays parked behind it, so say so straight away.
		const stillOpen = this.deps.getPendingDialog(sessionId);
		if (stillOpen) return { results, aborted: false, blockedBy: stillOpen };

		// The previous batch's interrupted action has to have stopped before
		// this one moves the pointer or types anything.
		const previous = this.inflight.get(sessionId);
		if (previous) {
			await Promise.race([previous, sleep(INFLIGHT_SETTLE_MS)]);
			this.inflight.delete(sessionId);
		}
		const token = { interrupted: false };
		this.runTokens.set(sessionId, token);

		for (let i = 0; i < actions.length; i++) {
			// Check if session is still valid before each action
			if (!isValidSession()) {
				debug.warn('preview', `⚠️ Session ${sessionId} is no longer valid, stopping autonomous actions at ${i + 1}/${actions.length}`);
				return { results, aborted: true };
			}

			// A page with a dialog open runs nothing: no click lands, no read
			// returns. Saying so now beats every later action hanging on it.
			const open = this.deps.getPendingDialog(sessionId);
			if (open) return { results, aborted: false, blockedBy: open };

			const action = actions[i];
			browserMcpControl.emitActivity(sessionId, this.describeActivity(action));

			const run = this.runAction(sessionId, session, action);
			const dialog = this.deps.waitForDialog(sessionId);

			try {
				const winner = await Promise.race([
					run.then((outcome) => ({ kind: 'done' as const, outcome })),
					dialog.promise.then((info) => ({ kind: 'dialog' as const, info }))
				]);

				if (winner.kind === 'dialog') {
					// The action is parked inside a call the dialog blocked. Tell its
					// loops to stop at their next checkpoint, and remember it so the
					// next batch waits for it to unwind.
					token.interrupted = true;
					this.inflight.set(sessionId, run.catch(() => {}));

					results.push({
						action: action.type,
						ok: true,
						detail: `a ${winner.info.type} dialog opened during this action`,
						timestamp: Date.now()
					});
					return { results, aborted: false, blockedBy: winner.info };
				}

				const outcome = winner.outcome;
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
			} finally {
				dialog.dispose();
			}

			// Fast delay between actions for MCP automation (50-100ms)
			if (action.type !== 'wait') {
				await sleep(50 + Math.random() * 50);
			}
		}

		// Nothing is announced at the end of a batch. The agent still holds the
		// tab between batches, so "this batch finished" says nothing about
		// whether the pointer belongs on screen — that follows from the lock,
		// and only from the lock. The event that used to be emitted here fired
		// per tool call, so anything wired to it took the pointer away in the
		// middle of a run that was still going.
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

			// No pointer movement at all: a person reading something on screen
			// does not walk their mouse over to it first, they just look — the
			// caption already says "Reading the page", which is the only signal
			// this needs. Moving the overlay here would also risk firing hover
			// handlers that change what is about to be read.
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
				// A wait has nowhere to point, but it is often the longest step in a
				// batch — re-asserting the parked pointer keeps the overlay alive
				// rather than letting the run appear to have stopped.
				const parked = this.getCurrentMousePosition(sessionId);
				this.publishCursor(sessionId, parked.x, parked.y);
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
				} else {
					// A page scroll applies wherever the pointer already is, so that
					// is what the overlay should be showing while the page moves.
					const parked = this.getCurrentMousePosition(sessionId);
					this.publishCursor(sessionId, parked.x, parked.y);
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
				} else {
					// No target: the text goes wherever focus already is, so point at
					// that instead of leaving the pointer stranded elsewhere.
					await this.showFocused(sessionId, page, { pulse: true });
				}

				const shouldClear = action.clearFirst !== false;

				if (action.text !== undefined) {
					const before = shouldClear ? await this.readFocusedField(page) : null;
					if (shouldClear) {
						// Select all, then typing overwrites the selection.
						await selectAll(page);
						await sleep(30);
					}

					await this.mcpType(page, action.text, action.delay ?? 30);

					if (!shouldClear) return `typed ${action.text.length} char(s)`;
					return this.settleFill(page, action.text, before);
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

				const { modifiers, key } = parseChord(chord);
				if (!key) throw new Error(`press could not find a key in "${chord}"`);

				await this.showFocused(sessionId, page, { pulse: true });

				// A paste chord pastes the workspace clipboard: the headless
				// browser's own is not the one anything was copied into.
				if (isPasteChord(modifiers, key)) {
					const text = this.deps.readClipboard();
					if (!text) return `pressed ${chord} — the clipboard is empty, nothing pasted`;
					const how = await pasteText(page, text);
					return `pressed ${chord} → pasted ${text.length} char(s) from the clipboard${how === 'handled-by-page' ? ' (handled by the page)' : ''}`;
				}

				await pressChord(page, modifiers, key);
				return `pressed ${chord}`;
			}

			case 'paste': {
				// No text means "paste the clipboard" — what Ctrl/⌘+V does.
				const text = typeof action.text === 'string' ? action.text : this.deps.readClipboard();
				if (!text) throw new Error('paste needs `text`, and the clipboard is empty');

				await this.showFocused(sessionId, page, { pulse: true });

				// A real paste: the `paste` event first (spreadsheets and rich
				// editors only listen for that), then the text at the caret if the
				// page did not take care of it.
				const how = await pasteText(page, text);
				const origin = typeof action.text === 'string' ? '' : ' from the clipboard';
				return `pasted ${text.length} char(s)${origin}${how === 'handled-by-page' ? ' (handled by the page)' : ''}`;
			}

			case 'focus': {
				const target = action.target ?? (action.selector ? { selector: action.selector } : undefined);
				if (!target) throw new Error('focus needs a target');

				const handle = await resolveHandle(page, target, { scrollIntoView: !action.noScroll });
				if (!handle) throw new Error('focus found no visible element');
				try {
					await this.showHandle(sessionId, handle, { pulse: true });
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
					this.publishClick(sessionId, point.x, point.y);
					await page.mouse.click(point.x, point.y);
					await sleep(40);
				} else {
					await this.showFocused(sessionId, page, { pulse: true });
				}

				const before = await this.readFocusedField(page);
				await selectAll(page);
				await page.keyboard.press('Backspace');

				return this.settleFill(page, '', before, 'cleared field');
			}

			case 'select_option': {
				const target = action.target ?? (action.selector ? { selector: action.selector } : undefined);
				if (!target) throw new Error('select_option needs a target');

				const handle = await resolveHandle(page, target, { scrollIntoView: !action.noScroll });
				if (!handle) throw new Error('select_option found no visible <select>');

				try {
					// The <select> is driven through the DOM because its popup is
					// browser-owned, so the pointer is the only sign anything happened.
					await this.showHandle(sessionId, handle, { pulse: true });

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
					await this.showHandle(sessionId, handle, { pulse: true });
					await (handle as ElementHandle<HTMLInputElement>).uploadFile(...action.files);
					return `uploaded ${action.files.length} file(s)`;
				} finally {
					await handle.dispose().catch(() => {});
				}
			}

			case 'tap': {
				const point = await this.pointFor(page, action);
				// Overlay only — a real mouse move before a touch gesture would add
				// a hover the agent never asked for, on exactly the mobile layouts
				// where hover and touch take different code paths.
				await this.glideOverlay(sessionId, point);
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

				// Walk to where the finger lands first, or the pointer teleports and
				// the swipe reads as having started from nowhere.
				await this.glideOverlay(sessionId, from);

				await this.withTouch(page, async (client) => {
					await client.send('Input.dispatchTouchEvent', {
						type: 'touchStart',
						touchPoints: [{ x: from.x, y: from.y, id: 1 }]
					});
					this.publishGlide(sessionId, {
						from,
						control: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
						to,
						durationMs: totalMs,
						pressed: true,
						easing: 'linear'
					});

					for (let s = 1; s <= steps; s++) {
						const t = s / steps;
						const x = Math.round(from.x + (to.x - from.x) * t);
						const y = Math.round(from.y + (to.y - from.y) * t);
						this.checkpoint(sessionId);
						await client.send('Input.dispatchTouchEvent', {
							type: 'touchMove',
							touchPoints: [{ x, y, id: 1 }]
						});
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

				await this.glideOverlay(sessionId, centre);

				await this.withTouch(page, async (client) => {
					const points = (spread: number) => [
						{ x: Math.round(centre.x - spread), y: Math.round(centre.y), id: 1 },
						{ x: Math.round(centre.x + spread), y: Math.round(centre.y), id: 2 }
					];

					await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(startSpread) });
					// Two fingers, one overlay pointer: held at the centre for the
					// duration, which at least says where the gesture is anchored.
					this.publishCursor(sessionId, centre.x, centre.y, true);

					for (let s = 1; s <= steps; s++) {
						const spread = startSpread + (endSpread - startSpread) * (s / steps);
						await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(spread) });
						await sleep((action.durationMs ?? 300) / steps);
					}
					await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
				});
				this.publishCursor(sessionId, centre.x, centre.y, false);

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
