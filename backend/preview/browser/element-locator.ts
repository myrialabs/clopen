/**
 * Element Locator
 *
 * Turns a CSS selector or a piece of visible text into page coordinates.
 *
 * Coordinates are what every input primitive ultimately needs — CDP dispatches
 * mouse and touch events at a point, not at an element. Resolving here means an
 * agent can say "click the Login button" without first taking a screenshot and
 * guessing pixels from it, and means the same query keeps working after the
 * page reflows.
 *
 * Every lookup sweeps all frames, not just the main one. `boundingBox()` is
 * already reported relative to the main frame, so an element inside an iframe
 * resolves to a directly clickable point with no offset arithmetic.
 */

import type { ElementHandle, Frame, Page } from 'puppeteer';
import type { BrowserActionTarget } from './types';

export interface LocatedElement {
	/** Centre of the element, in page coordinates — where input is aimed. */
	x: number;
	y: number;
	box: { x: number; y: number; width: number; height: number };
	tag: string;
	/** Trimmed visible text, capped for readability. */
	text: string;
	/** A selector that addresses this element again, when one can be built. */
	selector: string;
	role?: string;
	name?: string;
	href?: string;
	value?: string;
	placeholder?: string;
	type?: string;
	enabled: boolean;
	visible: boolean;
	/** True when the element lives inside an iframe. */
	inFrame: boolean;
	frameUrl?: string;
}

export interface LocateQuery {
	selector?: string;
	text?: string;
	/** Filter by ARIA role or input type, e.g. "button", "link", "textbox". */
	role?: string;
	nth?: number;
	visibleOnly?: boolean;
	limit?: number;
	/** Scroll the first match into view before measuring (default true). */
	scrollIntoView?: boolean;
}

/** Metadata read out of the page for one element. */
interface ElementMeta {
	tag: string;
	text: string;
	selector: string;
	role?: string;
	name?: string;
	href?: string;
	value?: string;
	placeholder?: string;
	type?: string;
	enabled: boolean;
	visible: boolean;
}

/**
 * XPath that matches the *innermost* elements containing the text.
 *
 * Without the `not(.//*[...])` guard every ancestor up to <body> matches too,
 * and the first hit would be the whole document rather than the button the
 * agent meant.
 */
function innermostTextXPath(text: string): string {
	const escaped = xpathLiteral(text.toLowerCase());
	const lower = `translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
	return `xpath///*[contains(${lower}, ${escaped}) and not(.//*[contains(${lower}, ${escaped})])]`;
}

/** XPath has no escape character; a mixed-quote string must be built with concat(). */
function xpathLiteral(value: string): string {
	if (!value.includes("'")) return `'${value}'`;
	if (!value.includes('"')) return `"${value}"`;
	const parts = value.split("'").map((part) => `'${part}'`);
	return `concat(${parts.join(`, "'", `)})`;
}

/** Read everything the caller might want to show, in one round trip per element. */
async function readMeta(handle: ElementHandle<Element>): Promise<ElementMeta> {
	return handle.evaluate((el) => {
		const style = window.getComputedStyle(el);
		const rect = el.getBoundingClientRect();
		const visible =
			style.display !== 'none' &&
			style.visibility !== 'hidden' &&
			Number(style.opacity) !== 0 &&
			rect.width > 0 &&
			rect.height > 0;

		// Prefer a stable hook (id, test id, name) over a positional path so the
		// selector survives re-renders.
		const buildSelector = (node: Element): string => {
			if (node.id) return `#${CSS.escape(node.id)}`;
			const testId = node.getAttribute('data-testid') || node.getAttribute('data-test-id');
			if (testId) return `[data-testid="${testId}"]`;
			const name = node.getAttribute('name');
			if (name) return `${node.tagName.toLowerCase()}[name="${name}"]`;

			const path: string[] = [];
			let current: Element | null = node;
			while (current && current.nodeType === 1 && path.length < 5) {
				let part = current.tagName.toLowerCase();
				const parent: Element | null = current.parentElement;
				if (parent) {
					const siblings = Array.from(parent.children).filter((c) => c.tagName === current!.tagName);
					if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
				}
				path.unshift(part);
				if (current.id) {
					path[0] = `#${CSS.escape(current.id)}`;
					break;
				}
				current = parent;
			}
			return path.join(' > ');
		};

		const input = el as HTMLInputElement;
		const anchor = el as HTMLAnchorElement;

		return {
			tag: el.tagName.toLowerCase(),
			text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
			selector: buildSelector(el),
			role: el.getAttribute('role') || undefined,
			name:
				el.getAttribute('aria-label') ||
				el.getAttribute('name') ||
				el.getAttribute('title') ||
				undefined,
			href: anchor.href || undefined,
			value: typeof input.value === 'string' ? input.value.slice(0, 120) : undefined,
			placeholder: input.placeholder || undefined,
			type: input.type || undefined,
			enabled: !(el as HTMLButtonElement).disabled,
			visible
		};
	});
}

/** Collect candidate handles for a query, main frame first. */
async function collectHandles(page: Page, query: LocateQuery): Promise<Array<{ handle: ElementHandle<Element>; frame: Frame }>> {
	const found: Array<{ handle: ElementHandle<Element>; frame: Frame }> = [];

	for (const frame of page.frames()) {
		if (frame.isDetached()) continue;

		try {
			const handles: ElementHandle<Element>[] = [];

			if (query.selector) {
				handles.push(...(await frame.$$(query.selector)));
			} else if (query.text) {
				handles.push(...(await frame.$$(innermostTextXPath(query.text))));
			} else if (query.role) {
				// A role is expressed either explicitly or by the element itself:
				// `<button>` carries the button role without saying so. Both are
				// tried, and an invalid tag selector simply yields nothing.
				for (const selector of [`[role="${query.role}"]`, query.role]) {
					try {
						handles.push(...(await frame.$$(selector)));
					} catch {
						continue;
					}
				}
			}

			for (const handle of handles) found.push({ handle, frame });
		} catch {
			// A bad selector or a frame that navigated mid-sweep — neither should
			// abort the other frames' results.
		}
	}

	return found;
}

/**
 * Find every element matching a query, ordered as the document does.
 * Handles are disposed before returning; only plain data escapes.
 */
export async function findElements(page: Page, query: LocateQuery): Promise<LocatedElement[]> {
	const limit = query.limit ?? 20;
	const visibleOnly = query.visibleOnly !== false;
	const candidates = await collectHandles(page, query);
	const results: LocatedElement[] = [];
	// The role query runs two selectors, so `<button role="button">` can match
	// twice; geometry plus tag identifies the element well enough to drop the
	// repeat.
	const seen = new Set<string>();

	try {
		for (const { handle, frame } of candidates) {
			if (results.length >= limit) break;

			const meta = await readMeta(handle).catch(() => null);
			if (!meta) continue;
			if (visibleOnly && !meta.visible) continue;
			if (query.role && meta.role !== query.role && meta.tag !== query.role) continue;
			// Both a selector and text narrows: matches must satisfy both.
			if (query.selector && query.text && !meta.text.toLowerCase().includes(query.text.toLowerCase())) continue;

			const box = await handle.boundingBox().catch(() => null);
			if (!box && visibleOnly) continue;

			const signature = `${meta.tag}@${box ? `${box.x},${box.y},${box.width}x${box.height}` : meta.selector}`;
			if (seen.has(signature)) continue;
			seen.add(signature);

			results.push({
				x: box ? Math.round(box.x + box.width / 2) : 0,
				y: box ? Math.round(box.y + box.height / 2) : 0,
				box: box
					? { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
					: { x: 0, y: 0, width: 0, height: 0 },
				tag: meta.tag,
				text: meta.text,
				selector: meta.selector,
				role: meta.role,
				name: meta.name,
				href: meta.href,
				value: meta.value,
				placeholder: meta.placeholder,
				type: meta.type,
				enabled: meta.enabled,
				visible: meta.visible,
				inFrame: frame !== page.mainFrame(),
				frameUrl: frame !== page.mainFrame() ? frame.url() : undefined
			});
		}
	} finally {
		for (const { handle } of candidates) {
			await handle.dispose().catch(() => {});
		}
	}

	return results;
}

/**
 * Resolve the handle for a target, scrolled into view.
 * The caller owns the handle and must dispose it.
 */
export async function resolveHandle(
	page: Page,
	target: BrowserActionTarget,
	opts: { scrollIntoView?: boolean } = {}
): Promise<ElementHandle<Element> | null> {
	const candidates = await collectHandles(page, { selector: target.selector, text: target.text });
	if (candidates.length === 0) return null;

	const wanted = target.nth ?? 0;
	let picked: ElementHandle<Element> | null = null;
	let seen = 0;

	for (const { handle } of candidates) {
		const visible = await handle.evaluate((el) => {
			const style = window.getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
		}).catch(() => false);

		if (!visible) continue;
		if (seen === wanted) {
			picked = handle;
			break;
		}
		seen++;
	}

	for (const { handle } of candidates) {
		if (handle !== picked) await handle.dispose().catch(() => {});
	}

	if (!picked) return null;

	if (opts.scrollIntoView !== false) {
		// A point outside the viewport cannot receive input, so scrolling is part
		// of resolving rather than something the agent has to remember to do.
		await picked.scrollIntoView().catch(() => {});
	}

	return picked;
}

/**
 * Resolve a target to a point. Explicit coordinates win; otherwise the element
 * is located, scrolled into view and aimed at its centre.
 */
export async function resolveTarget(
	page: Page,
	target: BrowserActionTarget | undefined,
	opts: { scrollIntoView?: boolean } = {}
): Promise<{ x: number; y: number; described: string }> {
	if (!target) throw new Error('No target given');

	if (typeof target.x === 'number' && typeof target.y === 'number') {
		return { x: target.x, y: target.y, described: `(${target.x}, ${target.y})` };
	}

	if (!target.selector && !target.text) {
		throw new Error('Target needs either x/y coordinates, a selector, or text');
	}

	const handle = await resolveHandle(page, target, opts);
	const label = target.selector ? `selector "${target.selector}"` : `text "${target.text}"`;
	if (!handle) throw new Error(`No visible element matched ${label}`);

	try {
		const box = await handle.boundingBox();
		if (!box) throw new Error(`${label} matched an element with no layout box (hidden or zero-sized)`);

		return {
			x: Math.round(box.x + box.width / 2),
			y: Math.round(box.y + box.height / 2),
			described: `${label} at (${Math.round(box.x + box.width / 2)}, ${Math.round(box.y + box.height / 2)})`
		};
	} finally {
		await handle.dispose().catch(() => {});
	}
}

/** Whether the element at a target uses the HTML5 drag-and-drop protocol. */
export async function isNativeDraggable(page: Page, target: BrowserActionTarget): Promise<boolean> {
	if (!target.selector && !target.text) return false;

	const handle = await resolveHandle(page, target, { scrollIntoView: false });
	if (!handle) return false;

	try {
		return await handle.evaluate((el) => {
			let node: Element | null = el;
			while (node) {
				if ((node as HTMLElement).draggable === true) return true;
				node = node.parentElement;
			}
			return false;
		});
	} catch {
		return false;
	} finally {
		await handle.dispose().catch(() => {});
	}
}
