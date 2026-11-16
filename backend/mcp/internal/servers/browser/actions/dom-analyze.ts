/**
 * Whole-page DOM extraction.
 *
 * Everything below the `page.evaluate` boundary runs in the page, so it can use
 * no imports and nothing from this module's scope. It is kept in its own file
 * because it is one large browser-side program, not because it is one action.
 */

import type { Page } from 'puppeteer';

export interface PageAnalysis {
	navigation: { links: Array<{ text: string; href: string }> };
	structure: {
		headings: Array<{ level: number; text: string; id: string }>;
		sections: Array<{ heading: string; summary: string }>;
	};
	content: { paragraphs: string[] };
	forms: Array<{
		formId: string;
		action: string;
		fields: Array<{
			label: string;
			type: string;
			name: string;
			placeholder: string;
			required: boolean;
			currentValue: string;
		}>;
	}>;
	summary: {
		url: string;
		title: string;
		hasIframes: boolean;
		hasCaptcha: boolean;
		scrollableHeight: number;
		viewportHeight: number;
	};
}

export async function analyzePage(page: Page): Promise<PageAnalysis> {
	return page.evaluate(() => {
		/**
		 * Text as a reader would see it: hidden subtrees dropped, block
		 * boundaries preserved as ` || ` so a card's fields do not run together
		 * into one unreadable sentence.
		 */
		const getVisibleText = (el: Element, maxLength: number = 500): string => {
			const isBlockElement = (elem: Element): boolean => {
				const style = window.getComputedStyle(elem);
				return (
					style.display === 'block' ||
					style.display === 'flex' ||
					style.display === 'grid' ||
					style.display === 'list-item' ||
					style.display === 'table'
				);
			};

			const isVisible = (elem: Element): boolean => {
				const style = window.getComputedStyle(elem);
				if (style.display === 'none' || style.visibility === 'hidden') return false;
				const tagName = elem.tagName.toLowerCase();
				return tagName !== 'script' && tagName !== 'style';
			};

			const extractText = (node: Node): string[] => {
				const parts: string[] = [];

				if (node.nodeType === Node.TEXT_NODE) {
					const text = node.textContent?.trim();
					if (text && text.length > 0) parts.push(text);
					return parts;
				}

				if (node.nodeType !== Node.ELEMENT_NODE) return parts;

				const elem = node as Element;
				if (!isVisible(elem)) return parts;

				const childParts: string[] = [];
				for (let i = 0; i < node.childNodes.length; i++) {
					const childResults = extractText(node.childNodes[i]);
					if (childResults.length > 0) childParts.push(...childResults);
				}

				if (childParts.length > 0) {
					parts.push(childParts.join(' '));
					if (isBlockElement(elem) && node.nextSibling) parts.push('|BLOCK|');
				}

				return parts;
			};

			let result = extractText(el).join(' ');
			result = result.replace(/\s*\|BLOCK\|\s*/g, ' || ');
			result = result.replace(/\s+/g, ' ').trim();
			result = result.replace(/\|\s+\|/g, '').replace(/^\|\s*|\s*\|$/g, '').trim();

			return result.substring(0, maxLength);
		};

		const summary = {
			url: window.location.href,
			title: document.title,
			hasIframes: document.querySelectorAll('iframe').length > 0,
			hasCaptcha: !!(
				document.querySelector('iframe[src*="recaptcha"]') ||
				document.querySelector('iframe[title*="recaptcha" i]') ||
				document.querySelector('.g-recaptcha') ||
				document.querySelector('[data-sitekey]') ||
				document.querySelector('iframe[src*="hcaptcha"]') ||
				document.querySelector('.h-captcha') ||
				document.querySelector('.cf-challenge-running') ||
				document.querySelector('#challenge-running') ||
				document.querySelector('div[id*="cf-challenge"]') ||
				document.querySelector('iframe[src*="turnstile"]') ||
				document.querySelector('.cf-turnstile') ||
				document.querySelector('iframe[src*="funcaptcha"]') ||
				document.querySelector('iframe[src*="arkoselabs"]') ||
				document.querySelector('[class*="captcha" i]') ||
				document.querySelector('[id*="captcha" i]') ||
				document.querySelector('img[alt*="captcha" i]') ||
				document.querySelector('img[src*="captcha" i]')
			),
			scrollableHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
			viewportHeight: window.innerHeight
		};

		const forms: PageAnalysis['forms'] = [];
		document.querySelectorAll('form').forEach((form, formIdx) => {
			const fields: PageAnalysis['forms'][number]['fields'] = [];

			form.querySelectorAll('input, textarea, select').forEach((field) => {
				const tagName = field.tagName.toLowerCase();
				const type = tagName === 'input' ? (field as HTMLInputElement).type : tagName;

				let label = '';
				if (field.id) {
					const labelEl = document.querySelector(`label[for="${field.id}"]`);
					if (labelEl) label = getVisibleText(labelEl);
				}
				if (!label) {
					label = (field as HTMLInputElement).placeholder || (field as HTMLInputElement).name || '(no label)';
				}

				fields.push({
					label,
					type,
					name: (field as HTMLInputElement).name || '',
					placeholder: (field as HTMLInputElement).placeholder || '',
					required: (field as HTMLInputElement).required || false,
					currentValue: (field as HTMLInputElement).value || ''
				});
			});

			forms.push({ formId: form.id || `form-${formIdx}`, action: form.action || '', fields });
		});

		// Every link on the page, not just <nav> — deduplicated by href, since a
		// header/footer pair would otherwise report the same destination twice.
		const navigation = { links: [] as Array<{ text: string; href: string }> };
		const seenHrefs = new Set<string>();
		document.querySelectorAll('a[href]').forEach((link) => {
			const href = (link as HTMLAnchorElement).href;
			const text = getVisibleText(link, 150);
			if (!href || !text || seenHrefs.has(href) || href.startsWith('#')) return;
			seenHrefs.add(href);
			navigation.links.push({ text, href });
		});

		const structure: PageAnalysis['structure'] = { headings: [], sections: [] };
		document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
			structure.headings.push({
				level: parseInt(heading.tagName.substring(1)),
				text: getVisibleText(heading),
				id: heading.id || ''
			});
		});
		document.querySelectorAll('section, article, main').forEach((section, idx) => {
			const heading = section.querySelector('h1, h2, h3, h4, h5, h6');
			structure.sections.push({
				heading: heading ? getVisibleText(heading, 200) : `Section ${idx + 1}`,
				summary: getVisibleText(section, 400)
			});
		});

		const content = { paragraphs: [] as string[] };
		const seenTexts = new Set<string>();
		// Leaf-ish containers only: matching every div would report each block of
		// text again for every ancestor that wraps it.
		const textSelectors = 'p, div:not(:has(p)):not(:has(div)), li, td, span:not(:has(span))';
		document.querySelectorAll(textSelectors).forEach((el) => {
			if (content.paragraphs.length >= 100) return;
			const text = getVisibleText(el, 800);
			if (text.length < 10 || seenTexts.has(text)) return;
			seenTexts.add(text);
			content.paragraphs.push(text);
		});

		return { navigation, structure, content, forms, summary };
	});
}
