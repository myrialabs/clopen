/**
 * Page Inspection Handlers
 */

import { browserPreviewServiceManager, type BrowserPreviewService } from "$backend/lib/preview";
import { browserMcpControl } from "$backend/lib/preview";
import { projectContextService } from "$backend/lib/mcp/project-context";
import { getActiveTabSession } from "./browser";
import { debug } from "$shared/utils/logger";

/**
 * Get BrowserPreviewService for current MCP execution context
 */
function getPreviewService(projectId?: string): BrowserPreviewService {
	// 1. Use explicit projectId if provided
	if (projectId) {
		debug.log('mcp', `Using explicit projectId: ${projectId}`);
		return browserPreviewServiceManager.getService(projectId);
	}

	// 2. Try to get projectId from current execution context
	const contextProjectId = projectContextService.getCurrentProjectId();
	if (contextProjectId) {
		debug.log('mcp', `Using projectId from context: ${contextProjectId}`);
		return browserPreviewServiceManager.getService(contextProjectId);
	}

	// 3. Fallback: Get first available project's service
	const activeProjects = browserPreviewServiceManager.getActiveProjects();
	if (activeProjects.length > 0) {
		const fallbackProjectId = activeProjects[0];
		debug.warn('mcp', `⚠️ No project context found, falling back to first active project: ${fallbackProjectId}`);
		return browserPreviewServiceManager.getService(fallbackProjectId);
	}

	throw new Error('No active browser preview service found. Project isolation requires projectId.');
}

export async function getConsoleLogsHandler(args: {
	limit?: number;
	projectId?: string;
}) {
	try {
		// Get active tab and session
		const { tab } = await getActiveTabSession(args.projectId);
		const sessionId = tab.id;

		// Get preview service
		const previewService = getPreviewService(args.projectId);
		const logs = previewService.getConsoleLogs(sessionId);

		// Update last action to keep control alive
		browserMcpControl.updateLastAction();

		if (logs.length === 0) {
			return {
				content: [{
					type: "text" as const,
					text: "No console logs available."
				}]
			};
		}

		const limit = Math.min(args.limit || 20, 100);
		const limitedLogs = logs.slice(-limit);
		const formattedLogs = limitedLogs.map((log: any) => {
			const timestamp = new Date(log.timestamp).toLocaleTimeString();
			const type = log.type.toUpperCase().padEnd(5);
			return `[${timestamp}] ${type} ${log.text}`;
		}).join('\n');

		return {
			content: [{
				type: "text" as const,
				text: `Console Logs (${limitedLogs.length} of ${logs.length} total):\n\n${formattedLogs}`
			}]
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		return {
			content: [{
				type: "text" as const,
				text: `Failed to get console logs: ${errorMessage}`
			}],
			isError: true
		};
	}
}

export async function clearConsoleLogsHandler(args: { projectId?: string } = {}) {
	try {
		// Get active tab and session
		const { tab } = await getActiveTabSession(args.projectId);
		const sessionId = tab.id;

		// Get preview service
		const previewService = getPreviewService(args.projectId);
		const success = previewService.clearConsoleLogs(sessionId);

		// Update last action to keep control alive
		browserMcpControl.updateLastAction();

		if (!success) {
			return {
				content: [{
					type: "text" as const,
					text: `Failed to clear console logs.`
				}],
				isError: true
			};
		}

		return {
			content: [{
				type: "text" as const,
				text: "Console logs cleared successfully."
			}]
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		return {
			content: [{
				type: "text" as const,
				text: `Failed to clear console logs: ${errorMessage}`
			}],
			isError: true
		};
	}
}

export async function executeConsoleHandler(args: {
	command: string;
	projectId?: string;
}) {
	try {
		// Get active tab and session
		const { tab } = await getActiveTabSession(args.projectId);
		const sessionId = tab.id;

		// Get preview service
		const previewService = getPreviewService(args.projectId);
		const result = await previewService.executeConsoleCommand(sessionId, args.command);

		// Update last action to keep control alive
		browserMcpControl.updateLastAction();

		return {
			content: [{
				type: "text" as const,
				text: `Execution successful.\n\nCommand: ${args.command}\n\nResult:\n${JSON.stringify(result, null, 2)}`
			}]
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		return {
			content: [{
				type: "text" as const,
				text: `Console execution failed: ${errorMessage}`
			}],
			isError: true
		};
	}
}

export async function analyzeDomHandler(args: {
	include?: ('navigation' | 'structure' | 'content' | 'forms' | 'summary')[];
} = {}) {
	try {
		// Get active tab and session
		const { session } = await getActiveTabSession();

		// Execute comprehensive DOM analysis
		const analysis = await session.page.evaluate(() => {
			// Helper: Get visible text with proper spacing
			const getVisibleText = (el: Element, maxLength: number = 500): string => {
				// Helper to check if element is block-level
				const isBlockElement = (elem: Element): boolean => {
					const style = window.getComputedStyle(elem);
					return style.display === 'block' ||
					       style.display === 'flex' ||
					       style.display === 'grid' ||
					       style.display === 'list-item' ||
					       style.display === 'table';
				};

				// Helper to check if element is visible
				const isVisible = (elem: Element): boolean => {
					const style = window.getComputedStyle(elem);
					if (style.display === 'none' || style.visibility === 'hidden') {
						return false;
					}
					const tagName = elem.tagName.toLowerCase();
					return tagName !== 'script' && tagName !== 'style';
				};

				// Recursively extract text with proper separators
				const extractText = (node: Node): string[] => {
					const parts: string[] = [];

					if (node.nodeType === Node.TEXT_NODE) {
						const text = node.textContent?.trim();
						if (text && text.length > 0) {
							parts.push(text);
						}
					} else if (node.nodeType === Node.ELEMENT_NODE) {
						const elem = node as Element;

						if (!isVisible(elem)) {
							return parts;
						}

						const isBlock = isBlockElement(elem);
						const childParts: string[] = [];

						// Process all children
						for (let i = 0; i < node.childNodes.length; i++) {
							const childResults = extractText(node.childNodes[i]);
							if (childResults.length > 0) {
								childParts.push(...childResults);
							}
						}

						if (childParts.length > 0) {
							// Join child parts and add to results
							const joined = childParts.join(' ');
							parts.push(joined);

							// Add block separator marker if this is a block element
							if (isBlock && node.nextSibling) {
								parts.push('|BLOCK|');
							}
						}
					}

					return parts;
				};

				// Extract all text parts
				const textParts = extractText(el);

				// Join parts and handle block separators
				let result = textParts.join(' ');

				// Replace block separator markers with ' || '
				result = result.replace(/\s*\|BLOCK\|\s*/g, ' || ');

				// Normalize whitespace (collapse multiple spaces)
				result = result.replace(/\s+/g, ' ').trim();

				// Clean up any remaining separator artifacts
				// result = result.replace(/\|\s+\|/g, '').replace(/^\|\s*|\s*\|$/g, '');
				result = result.replace(/\|\s+\|/g, '').replace(/\|\s+\|/g, '').replace(/^\|\s*|\s*\|$/g, '').replace(/^\|\s*|\s*\|$/g, '');

				return result.substring(0, maxLength);
			};

			// Helper: Check if in viewport
			// const inViewport = (el: Element): boolean => {
			// 	const rect = el.getBoundingClientRect();
			// 	return rect.top >= 0 && rect.left >= 0 &&
			// 		rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
			// };

			// Summary
			const summary = {
				url: window.location.href,
				title: document.title,
				hasIframes: document.querySelectorAll('iframe').length > 0,
				hasCaptcha: !!(
					// reCAPTCHA
					document.querySelector('iframe[src*="recaptcha"]') ||
					document.querySelector('iframe[title*="recaptcha" i]') ||
					document.querySelector('.g-recaptcha') ||
					document.querySelector('[data-sitekey]') ||
					// hCaptcha
					document.querySelector('iframe[src*="hcaptcha"]') ||
					document.querySelector('.h-captcha') ||
					// Cloudflare
					document.querySelector('.cf-challenge-running') ||
					document.querySelector('#challenge-running') ||
					document.querySelector('div[id*="cf-challenge"]') ||
					// Turnstile
					document.querySelector('iframe[src*="turnstile"]') ||
					document.querySelector('.cf-turnstile') ||
					// FunCaptcha/ArkoseLabs
					document.querySelector('iframe[src*="funcaptcha"]') ||
					document.querySelector('iframe[src*="arkoselabs"]') ||
					// Generic captcha indicators
					document.querySelector('[class*="captcha" i]') ||
					document.querySelector('[id*="captcha" i]') ||
					// Image/text based captchas
					document.querySelector('img[alt*="captcha" i]') ||
					document.querySelector('img[src*="captcha" i]')
				),
				scrollableHeight: Math.max(
					document.body.scrollHeight,
					document.documentElement.scrollHeight
				),
				viewportHeight: window.innerHeight
			};

			// Forms structure
			const forms: any[] = [];
			document.querySelectorAll('form').forEach((form, formIdx) => {
				const fields: any[] = [];

				form.querySelectorAll('input, textarea, select').forEach((field) => {
					const tagName = field.tagName.toLowerCase();
					const type = tagName === 'input' ? (field as HTMLInputElement).type : tagName;

					let label = '';
					const id = field.id;
					if (id) {
						const labelEl = document.querySelector(`label[for="${id}"]`);
						if (labelEl) label = getVisibleText(labelEl);
					}

					if (!label) {
						label = (field as any).placeholder || (field as any).name || '(no label)';
					}

					fields.push({
						label,
						type,
						name: (field as any).name || '',
						placeholder: (field as any).placeholder || '',
						required: (field as any).required || false,
						currentValue: (field as any).value || ''
					});
				});

				forms.push({
					formId: form.id || `form-${formIdx}`,
					action: form.action || '',
					fields
				});
			});

			// Navigation - collect ALL links (not just nav), then deduplicate
			const navigation = {
				menus: [] as any[],
				links: [] as any[]
			};

			// Collect all links with href
			const seenHrefs = new Set<string>();
			document.querySelectorAll('a[href]').forEach((link) => {
				const href = (link as HTMLAnchorElement).href;
				const text = getVisibleText(link, 150);

				// Skip if: empty href, empty text, already seen, or anchor-only link
				if (!href || !text || seenHrefs.has(href) || href.startsWith('#')) {
					return;
				}

				seenHrefs.add(href);
				navigation.links.push({
					text,
					href
				});
			});

			// Page structure
			const structure = {
				headings: [] as any[],
				sections: [] as any[]
			};

			// Collect headings
			document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
				structure.headings.push({
					level: parseInt(heading.tagName.substring(1)),
					text: getVisibleText(heading),
					id: heading.id || ''
				});
			});

			// Collect sections
			document.querySelectorAll('section, article, main').forEach((section, idx) => {
				const heading = section.querySelector('h1, h2, h3, h4, h5, h6');
				const headingText = heading ? getVisibleText(heading, 200) : `Section ${idx + 1}`;
				const summary = getVisibleText(section, 400);

				structure.sections.push({
					heading: headingText,
					summary
				});
			});

			// Text content - collect from various element types
			const content = {
				paragraphs: [] as string[]
			};

			// Collect text from paragraphs, divs, list items, table cells, spans
			const seenTexts = new Set<string>();
			const textSelectors = 'p, div:not(:has(p)):not(:has(div)), li, td, span:not(:has(span))';

			document.querySelectorAll(textSelectors).forEach((el) => {
				const text = getVisibleText(el, 800);

				// Skip if: too short, already seen, or likely navigation/UI element
				if (text.length < 10 || seenTexts.has(text)) {
					return;
				}

				// Limit to 100 text items to avoid overflow
				if (content.paragraphs.length >= 100) {
					return;
				}

				seenTexts.add(text);
				content.paragraphs.push(text);
			});

			return {
				navigation,
				structure,
				content,
				forms,
				summary
			};
		});

		// Filter sections if include provided
		const includeSet = args.include ? new Set(args.include) : null;
		let filtered: any = {};

		if (includeSet) {
			// Only include requested sections (in priority order)
			if (includeSet.has('navigation')) filtered.navigation = analysis.navigation;
			if (includeSet.has('structure')) filtered.structure = analysis.structure;
			if (includeSet.has('content')) filtered.content = analysis.content;
			if (includeSet.has('forms')) filtered.forms = analysis.forms;
			if (includeSet.has('summary')) filtered.summary = analysis.summary;
		} else {
			// Include all sections
			filtered = analysis;
		}

		// Update last action to keep control alive
		browserMcpControl.updateLastAction();

		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify(filtered, null, 2)
			}]
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		return {
			content: [{
				type: "text" as const,
				text: `DOM analysis failed: ${errorMessage}`
			}],
			isError: true
		};
	}
}

export async function takeScreenshotHandler() {
	try {
		// Get active tab and session
		const { session } = await getActiveTabSession();

		// ALWAYS capture viewport only (cost-efficient, fast)
		const screenshot = await session.page.screenshot({
			encoding: 'base64',
			fullPage: false, // viewport only
			type: 'png'
		});

		// Update last action to keep control alive
		browserMcpControl.updateLastAction();

		return {
			content: [
				{
					type: "image" as const,
					data: screenshot,
					mimeType: "image/png"
				},
				{
					type: "text" as const,
					text: `Screenshot captured successfully (viewport only).`
				}
			]
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';

		return {
			content: [{
				type: "text" as const,
				text: `Screenshot failed: ${errorMessage}`
			}],
			isError: true
		};
	}
}
