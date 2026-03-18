import { EventEmitter } from 'events';
import type { Page, HTTPRequest, Frame, CDPSession } from 'puppeteer';
import type { BrowserTab } from './types';
import { debug } from '$shared/utils/logger';

export class BrowserNavigationTracker extends EventEmitter {
	private cdpSessions = new Map<string, CDPSession>();

	constructor() {
		super();
	}

	/**
	 * Check if two URLs differ only by hash/fragment.
	 * Hash-only changes are same-document navigations and should NOT trigger
	 * full page reload or streaming restart.
	 */
	private isHashOnlyChange(oldUrl: string, newUrl: string): boolean {
		try {
			const oldParsed = new URL(oldUrl);
			const newParsed = new URL(newUrl);
			// Compare URLs without hash — if identical, it's a hash-only change
			oldParsed.hash = '';
			newParsed.hash = '';
			return oldParsed.href === newParsed.href;
		} catch {
			return false;
		}
	}

	/**
	 * Check if two URLs share the same origin (protocol + host + port).
	 * Same-origin navigations are likely SPA internal navigations and should
	 * NOT show a progress bar — the streaming restart happens silently while
	 * the last rendered frame stays visible.
	 */
	private isSameOrigin(oldUrl: string, newUrl: string): boolean {
		try {
			return new URL(oldUrl).origin === new URL(newUrl).origin;
		} catch {
			return false;
		}
	}

	async setupNavigationTracking(sessionId: string, page: Page, session: BrowserTab) {

		// Track navigation start (loading begins) — only for cross-origin document navigations
		page.on('request', (request: HTTPRequest) => {
			// Only track main frame document requests (not resources like images, CSS, etc.)
			// Puppeteer uses resourceType() instead of isNavigationRequest()
			if (request.resourceType() === 'document' && request.frame() === page.mainFrame()) {
				const targetUrl = request.url();

				// Skip hash-only changes — they are same-document navigations
				// that don't need loading states or streaming restart
				if (this.isHashOnlyChange(session.url, targetUrl)) {
					debug.log('preview', `⏭️ Skipping navigation-loading for hash-only change: ${session.url} → ${targetUrl}`);
					return;
				}

				// Skip same-origin navigations — they are likely SPA internal navigations.
				// No progress bar is shown; the last rendered frame stays visible while
				// streaming restarts silently in the background. This makes SPA navigation
				// feel instant, similar to how a real browser shows the old page until
				// the new one is ready.
				if (this.isSameOrigin(session.url, targetUrl)) {
					debug.log('preview', `⏭️ Skipping navigation-loading for same-origin navigation: ${session.url} → ${targetUrl}`);
					return;
				}

				// Emit navigation loading event to frontend (cross-origin navigations only)
				this.emit('navigation-loading', {
					sessionId,
					type: 'navigation-loading',
					url: targetUrl,
					timestamp: Date.now()
				});
			}
		});

		// Track full page navigations (actual page loads, not SPA)
		page.on('framenavigated', async (frame: Frame) => {
			// Only track main frame navigation (not iframes)
			if (frame === page.mainFrame()) {
				const newUrl = frame.url();

				// Skip internal Chrome error/system pages — they indicate a failed navigation
				// and should not be surfaced to the frontend as a real URL change.
				if (newUrl.startsWith('chrome-error://') || newUrl.startsWith('chrome://')) return;

				// Skip if URL hasn't changed (already handled by navigatedWithinDocument)
				if (newUrl === session.url) return;

				// Hash-only changes should be treated as SPA navigations
				// (no streaming restart needed, page context is unchanged)
				if (this.isHashOnlyChange(session.url, newUrl)) {
					debug.log('preview', `🔄 Hash-only change detected, treating as SPA navigation: ${session.url} → ${newUrl}`);
					session.url = newUrl;
					this.emit('navigation-spa', {
						sessionId,
						type: 'navigation-spa',
						url: newUrl,
						timestamp: Date.now()
					});
					return;
				}

				// Same-origin navigation: check if the video encoder script survived.
				// SPA frameworks (SvelteKit, Next.js, etc.) often trigger framenavigated
				// for client-side routing even though the page context is NOT replaced.
				// If __webCodecsPeer still exists, the scripts are alive → SPA navigation.
				// If it's gone, the page was truly replaced → full navigation + stream restart.
				if (this.isSameOrigin(session.url, newUrl)) {
					try {
						const scriptAlive = await page.evaluate(() => !!(window as any).__webCodecsPeer);
						if (scriptAlive) {
							debug.log('preview', `🔄 Same-origin navigation with script alive (SPA): ${session.url} → ${newUrl}`);
							session.url = newUrl;
							this.emit('navigation-spa', {
								sessionId,
								type: 'navigation-spa',
								url: newUrl,
								timestamp: Date.now()
							});
							return;
						}
						debug.log('preview', `📄 Same-origin navigation with script dead (full reload): ${session.url} → ${newUrl}`);
					} catch {
						// page.evaluate failed — page context was replaced, fall through to full navigation
						debug.log('preview', `📄 Same-origin navigation evaluate failed (full reload): ${session.url} → ${newUrl}`);
					}
				}

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
			// Skip internal Chrome error/system pages
			if (currentUrl.startsWith('chrome-error://') || currentUrl.startsWith('chrome://')) return;
			if (currentUrl !== session.url) {

				// Hash-only changes on load — treat as SPA navigation
				if (this.isHashOnlyChange(session.url, currentUrl)) {
					session.url = currentUrl;
					this.emit('navigation-spa', {
						sessionId,
						type: 'navigation-spa',
						url: currentUrl,
						timestamp: Date.now()
					});
					return;
				}

				// Same-origin: check if video encoder script survived
				if (this.isSameOrigin(session.url, currentUrl)) {
					try {
						const scriptAlive = await page.evaluate(() => !!(window as any).__webCodecsPeer);
						if (scriptAlive) {
							session.url = currentUrl;
							this.emit('navigation-spa', {
								sessionId,
								type: 'navigation-spa',
								url: currentUrl,
								timestamp: Date.now()
							});
							return;
						}
					} catch {
						// Fall through to full navigation
					}
				}

				session.url = currentUrl;

				this.emit('navigation', {
					sessionId,
					type: 'navigation',
					url: currentUrl,
					timestamp: Date.now()
				});
			}
		});

		// Track SPA navigations (pushState/replaceState) via CDP
		// Uses Page.navigatedWithinDocument which fires for same-document navigations
		// This is purely CDP-level — no script injection, safe from CloudFlare detection
		try {
			const cdp = await page.createCDPSession();
			this.cdpSessions.set(sessionId, cdp);

			await cdp.send('Page.enable');

			// Get main frame ID via CDP (reliable across Puppeteer versions)
			const frameTree = await cdp.send('Page.getFrameTree');
			const mainFrameId = frameTree.frameTree.frame.id;

			cdp.on('Page.navigatedWithinDocument', (params: { frameId: string; url: string }) => {
				// Only track main frame SPA navigations (ignore iframe pushState)
				if (params.frameId !== mainFrameId) return;

				const newUrl = params.url;
				if (newUrl === session.url) return;

				debug.log('preview', `🔄 SPA navigation detected: ${session.url} → ${newUrl}`);

				// Update session URL
				session.url = newUrl;

				// Emit SPA navigation event — no loading state, no stream restart
				this.emit('navigation-spa', {
					sessionId,
					type: 'navigation-spa',
					url: newUrl,
					timestamp: Date.now()
				});
			});

			debug.log('preview', `✅ CDP SPA navigation tracking setup for session: ${sessionId}`);
		} catch (error) {
			debug.warn('preview', `⚠️ Failed to setup CDP SPA tracking for ${sessionId}:`, error);
		}
	}

	/**
	 * Cleanup CDP session for a tab
	 */
	async cleanupSession(sessionId: string) {
		const cdp = this.cdpSessions.get(sessionId);
		if (cdp) {
			try {
				await cdp.detach();
			} catch {
				// Ignore detach errors
			}
			this.cdpSessions.delete(sessionId);
		}
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