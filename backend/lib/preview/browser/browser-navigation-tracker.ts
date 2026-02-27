import { EventEmitter } from 'events';
import type { Page, HTTPRequest, Frame } from 'puppeteer';
import type { BrowserTab } from './types';

export class BrowserNavigationTracker extends EventEmitter {
	constructor() {
		super();
	}

	async setupNavigationTracking(sessionId: string, page: Page, session: BrowserTab) {

		// Track navigation start (loading begins)
		page.on('request', (request: HTTPRequest) => {
			// Only track main frame document requests (not resources like images, CSS, etc.)
			// Puppeteer uses resourceType() instead of isNavigationRequest()
			if (request.resourceType() === 'document' && request.frame() === page.mainFrame()) {
				const targetUrl = request.url();

				// Emit navigation loading event to frontend
				this.emit('navigation-loading', {
					sessionId,
					type: 'navigation-loading',
					url: targetUrl,
					timestamp: Date.now()
				});
			}
		});

		// Track all navigation events - including redirects, link clicks, and hash changes
		page.on('framenavigated', (frame: Frame) => {
			// Only track main frame navigation (not iframes)
			if (frame === page.mainFrame()) {
				const newUrl = frame.url();

				// Update session URL
				session.url = newUrl;

				// Emit navigation completed event to frontend
				this.emit('navigation', {
					sessionId,
					type: 'navigation',
					url: newUrl,
					timestamp: Date.now()
				});
			}
		});

		// Also track URL changes via JavaScript (for single page applications)
		page.on('load', async () => {
			const currentUrl = page.url();
			if (currentUrl !== session.url) {
				
				session.url = currentUrl;
				
				this.emit('navigation', {
					sessionId,
					type: 'navigation',
					url: currentUrl,
					timestamp: Date.now()
				});
			}
		});

		// Track hash changes (fragment identifier changes like #contact-us)
		await page.evaluateOnNewDocument(() => {
			let lastUrl = window.location.href;

			// Monitor for hash changes and other URL changes
			const checkUrlChange = () => {
				const currentUrl = window.location.href;
				if (currentUrl !== lastUrl) {
					lastUrl = currentUrl;

					// Store the new URL for the backend to detect
					(window as any).__urlChanged = {
						url: currentUrl,
						timestamp: Date.now()
					};
				}
			};

			// Listen to various events that might change URL
			window.addEventListener('hashchange', checkUrlChange);
			window.addEventListener('popstate', checkUrlChange);

			// Periodically check for URL changes (for SPA navigation)
			setInterval(checkUrlChange, 500);
		});
	}

	async navigateSession(sessionId: string, session: BrowserTab, url: string): Promise<string> {
		
		await session.page.goto(url);
		
		// Get the final URL after any redirects
		const finalUrl = session.page.url();
		session.url = finalUrl;
		
		// Update current URL tracking
		session.currentUrl = finalUrl;
		
		return finalUrl;
	}
}