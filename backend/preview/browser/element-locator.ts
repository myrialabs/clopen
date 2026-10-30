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
 * Rank the elements of one frame that a piece of visible text could mean.
 *
 * Runs inside the page, in a single round trip. Text alone is ambiguous in
 * exactly the place agents use it most: "Click **Continue** to verify" sits
 * right above a Continue button in the same modal, and taking the first match
 * in document order clicked the bold word in the sentence. So every match is
 * scored, the way a person picks the thing they meant:
 *
 * - **Exact** text beats a match that merely contains the words.
 * - **Clickable** beats inert. A match inside a button, link, labelled
 *   control or `cursor: pointer` element is aimed at that element, not at
 *   the span holding the text.
 * - **On top** beats covered: the element actually under its own centre is
 *   reachable; one behind a modal's backdrop is not.
 * - Inside an open **dialog** beats the page behind it.
 *
 * Also matches what has no text node — `<input type=submit value=…>`,
 * icon buttons named by `aria-label` or `title` — which a text search used to
 * miss entirely.
 *
 * Self-contained on purpose: it is serialised into the page.
 */
function rankTextMatches(query: string, includeHidden: boolean, limit: number) {
	const needle = query.replace(/\s+/g, ' ').trim().toLowerCase();
	if (!needle) return [];

	const norm = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

	const CLICKABLE_ROLES = new Set([
		'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option',
		'checkbox', 'radio', 'switch', 'treeitem', 'gridcell'
	]);

	const isClickable = (el: Element): boolean => {
		const tag = el.tagName;
		if (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'SELECT' || tag === 'LABEL') return true;
		if (tag === 'A' && (el as HTMLAnchorElement).hasAttribute('href')) return true;
		if (tag === 'INPUT') {
			const type = ((el as HTMLInputElement).type || '').toLowerCase();
			return ['button', 'submit', 'reset', 'checkbox', 'radio', 'image'].includes(type);
		}
		const role = el.getAttribute('role');
		if (role && CLICKABLE_ROLES.has(role)) return true;
		if (el.hasAttribute('onclick')) return true;
		return false;
	};

	const isVisible = (el: Element): boolean => {
		const rect = el.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return false;
		const style = window.getComputedStyle(el);
		return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
	};

	/** The control a click on this text would actually be aimed at. */
	const actionableFor = (el: Element): { target: Element; clickable: boolean } => {
		let node: Element | null = el;
		for (let depth = 0; node && depth < 6; depth++) {
			if (isClickable(node)) return { target: node, clickable: true };
			node = node.parentElement ?? ((node.getRootNode() as ShadowRoot).host || null);
		}
		// No semantic control — a styled div with a click handler still shows a
		// pointer cursor, which is the only hint the page gives.
		node = el;
		for (let depth = 0; node && depth < 4; depth++) {
			if (window.getComputedStyle(node).cursor === 'pointer') return { target: node, clickable: true };
			node = node.parentElement;
		}
		return { target: el, clickable: false };
	};

	/** Deepest element under a point, through open shadow roots. */
	const hitAt = (x: number, y: number): Element | null => {
		let hit = document.elementFromPoint(x, y);
		while (hit && (hit as HTMLElement).shadowRoot) {
			const inner = (hit as HTMLElement).shadowRoot!.elementFromPoint(x, y);
			if (!inner || inner === hit) break;
			hit = inner;
		}
		return hit;
	};

	const inDialog = (el: Element): boolean =>
		!!el.closest('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]');

	// Innermost elements whose text contains the query: descend only into
	// branches that contain it, and stop where no child does.
	const textMatches: Element[] = [];
	const visit = (root: Element | ShadowRoot) => {
		for (const child of Array.from(root.children)) {
			const tag = child.tagName;
			if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
			const shadow = (child as HTMLElement).shadowRoot;
			const contains = norm(child.textContent).includes(needle);
			if (shadow) visit(shadow);
			if (!contains) continue;
			const deeper = Array.from(child.children).some((grand) => norm(grand.textContent).includes(needle));
			if (deeper) visit(child);
			else textMatches.push(child);
		}
	};
	if (document.body) visit(document.body);

	// Elements named by an attribute rather than by text.
	const named: Element[] = [];
	for (const el of Array.from(document.querySelectorAll('input[type=submit], input[type=button], input[type=reset], [aria-label], [title]'))) {
		const label = norm(
			el.tagName === 'INPUT' ? (el as HTMLInputElement).value || el.getAttribute('aria-label') : el.getAttribute('aria-label') || el.getAttribute('title')
		);
		if (label.includes(needle)) named.push(el);
	}

	const order = new Map<Element, number>();
	const scored = new Map<Element, { el: Element; score: number }>();
	let position = 0;

	for (const candidate of [...textMatches, ...named]) {
		const { target, clickable } = actionableFor(candidate);
		if (!order.has(target)) order.set(target, position++);
		if (!includeHidden && !isVisible(target)) continue;

		const ownText = norm(candidate.textContent) || norm(candidate.getAttribute('aria-label')) || norm((candidate as HTMLInputElement).value) || norm(candidate.getAttribute('title'));
		const targetText = norm((target as HTMLElement).innerText ?? target.textContent);

		let score = 0;
		if (ownText === needle || targetText === needle) score += 100;
		else if (ownText.startsWith(needle) || targetText.startsWith(needle)) score += 40;
		else score += 10;

		if (clickable) score += 50;
		if ((target as HTMLButtonElement).disabled) score -= 30;
		if (inDialog(target)) score += 20;

		const rect = target.getBoundingClientRect();
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		if (cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight) {
			const hit = hitAt(cx, cy);
			if (hit && (target === hit || target.contains(hit))) score += 60;
			else if (hit && !hit.contains(target)) score -= 80;
		}

		const previous = scored.get(target);
		if (!previous || score > previous.score) scored.set(target, { el: target, score });
	}

	return Array.from(scored.values())
		.sort((a, b) => b.score - a.score || (order.get(a.el) ?? 0) - (order.get(b.el) ?? 0))
		.slice(0, limit);
}

/** Ranked text matches from every frame, best first. Caller disposes the handles. */
async function rankedTextHandles(
	page: Page,
	text: string,
	opts: { includeHidden?: boolean; limit?: number } = {}
): Promise<Array<{ handle: ElementHandle<Element>; frame: Frame; score: number }>> {
	const found: Array<{ handle: ElementHandle<Element>; frame: Frame; score: number; frameIndex: number }> = [];
	const frames = page.frames();

	for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
		const frame = frames[frameIndex];
		if (frame.isDetached()) continue;

		try {
			const list = await frame.evaluateHandle(rankTextMatches, text, !!opts.includeHidden, opts.limit ?? 20);
			try {
				const entries = await list.getProperties();
				for (const entry of entries.values()) {
					const el = (await entry.getProperty('el')) as ElementHandle<Element>;
					const score = Number(await (await entry.getProperty('score')).jsonValue());
					found.push({ handle: el, frame, score, frameIndex });
					await entry.dispose().catch(() => {});
				}
			} finally {
				await list.dispose().catch(() => {});
			}
		} catch {
			// A frame that navigated mid-sweep must not abort the others.
		}
	}

	// Best score wins across frames; the main frame breaks ties, then page order.
	found.sort((a, b) => b.score - a.score || a.frameIndex - b.frameIndex);
	return found.map(({ handle, frame, score }) => ({ handle, frame, score }));
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
	// Text is ranked, not listed in document order — see rankTextMatches.
	if (query.text && !query.selector) {
		return rankedTextHandles(page, query.text, {
			includeHidden: query.visibleOnly === false,
			limit: Math.max(query.limit ?? 20, (query.nth ?? 0) + 1)
		});
	}

	const found: Array<{ handle: ElementHandle<Element>; frame: Frame }> = [];

	for (const frame of page.frames()) {
		if (frame.isDetached()) continue;

		try {
			const handles: ElementHandle<Element>[] = [];

			if (query.selector) {
				handles.push(...(await frame.$$(query.selector)));
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
	const candidates = await collectHandles(page, { selector: target.selector, text: target.text, nth: target.nth });
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
