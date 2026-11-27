/**
 * Everything worth telling a model about one element of a preview page.
 *
 * The element is found the way the screenshot picker finds it — under a
 * viewport point, `depth` ancestors up — so what the user highlighted is what
 * is described. Runs in a single round trip into the page.
 */

import type { Page } from 'puppeteer';

export interface DescribedElement {
	tag: string;
	/** A selector that matches this element, unique on the page when one could be built. */
	selector: string;
	/** `tag#id.class` of each ancestor, outermost first. */
	ancestors: string[];
	attributes: Record<string, string>;
	text: string;
	html: string;
	htmlTruncated: boolean;
	rect: { x: number; y: number; width: number; height: number };
	styles: Record<string, string>;
	url: string;
	title: string;
}

/** Largest outerHTML carried; a whole app's root element can be megabytes. */
const MAX_HTML = 200_000;
const MAX_TEXT = 20_000;

/** Computed styles that explain how an element looks and is laid out. */
const STYLE_PROPERTIES = [
	'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
	'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
	'margin', 'padding', 'box-sizing', 'overflow',
	'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-self', 'gap', 'flex',
	'grid-template-columns', 'grid-template-rows',
	'color', 'background-color', 'background-image', 'opacity',
	'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'white-space',
	'border', 'border-radius', 'box-shadow', 'outline',
	'cursor', 'pointer-events', 'visibility', 'transform', 'transition'
];

export async function describeElementAt(page: Page, x: number, y: number, depth = 0): Promise<DescribedElement | null> {
	return page.evaluate(
		(input: { x: number; y: number; depth: number; maxHtml: number; maxText: number; properties: string[] }) => {
			let element = document.elementFromPoint(input.x, input.y);
			if (!element) return null;
			for (let reached = 0; reached < input.depth && element.parentElement; reached++) element = element.parentElement;

			const label = (el: Element) => {
				const classes = Array.from(el.classList).slice(0, 3);
				return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (classes.length ? `.${classes.join('.')}` : '');
			};
			const escape = (value: string) => (window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, '\\$&'));
			const unique = (selector: string) => {
				try {
					return document.querySelectorAll(selector).length === 1;
				} catch {
					return false;
				}
			};

			// Shortest path of steps from the nearest id (or the root) that
			// matches only this element.
			const selectorFor = (target: Element): string => {
				if (target.id && unique(`#${escape(target.id)}`)) return `#${escape(target.id)}`;
				const steps: string[] = [];
				let node: Element | null = target;
				while (node && node !== document.documentElement) {
					let step = node.tagName.toLowerCase();
					if (node.id && unique(`#${escape(node.id)}`)) {
						steps.unshift(`#${escape(node.id)}`);
						break;
					}
					const stable = Array.from(node.classList).filter((name) => !/\d{3,}|^svelte-|^css-|^_/.test(name)).slice(0, 2);
					if (stable.length) step += stable.map((name) => `.${escape(name)}`).join('');
					const parent: Element | null = node.parentElement;
					if (parent) {
						const same = Array.from(parent.children).filter((child) => child.tagName === node!.tagName);
						if (same.length > 1) step += `:nth-of-type(${same.indexOf(node) + 1})`;
					}
					steps.unshift(step);
					const candidate = steps.join(' > ');
					if (unique(candidate)) return candidate;
					node = parent;
				}
				return steps.join(' > ');
			};

			const ancestors: string[] = [];
			for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
				ancestors.unshift(label(node));
			}

			const attributes: Record<string, string> = {};
			for (const attribute of Array.from(element.attributes)) attributes[attribute.name] = attribute.value.slice(0, 2000);

			const computed = window.getComputedStyle(element);
			const styles: Record<string, string> = {};
			for (const property of input.properties) {
				const value = computed.getPropertyValue(property);
				if (value && value !== 'none' && value !== 'normal' && value !== 'auto' && value !== '0px') styles[property] = value;
			}

			const html = element.outerHTML;
			const text = ((element as HTMLElement).innerText ?? element.textContent ?? '').trim();
			const box = element.getBoundingClientRect();
			return {
				tag: element.tagName.toLowerCase(),
				selector: selectorFor(element),
				ancestors,
				attributes,
				text: text.slice(0, input.maxText),
				html: html.slice(0, input.maxHtml),
				htmlTruncated: html.length > input.maxHtml,
				rect: { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) },
				styles,
				url: location.href,
				title: document.title
			};
		},
		{ x, y, depth: Math.max(0, Math.floor(depth)), maxHtml: MAX_HTML, maxText: MAX_TEXT, properties: STYLE_PROPERTIES }
	);
}
