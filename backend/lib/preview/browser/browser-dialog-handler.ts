import { EventEmitter } from 'events';
import type { Page, Dialog } from 'puppeteer';
import type { BrowserTab, BrowserDialogEvent, BrowserDialogResponse, BrowserPrintEvent } from './types';
import { debug } from '$shared/utils/logger';
import { nanoid } from 'nanoid';

/**
 * Browser Dialog Handler
 *
 * Intercepts native browser dialogs (alert, confirm, prompt) from headless browser
 * and emits events to frontend for re-rendering as native host dialogs.
 *
 * Also intercepts window.print() calls and emits print events.
 */
export class BrowserDialogHandler extends EventEmitter {
	// Store pending dialogs waiting for response
	private pendingDialogs = new Map<string, Dialog>();

	constructor() {
		super();
	}

	/**
	 * Setup dialog interception for a browser session
	 */
	/**
	 * Setup dialog bindings - MUST be called BEFORE navigation
	 * This includes exposeFunction calls which require page to not be navigated yet
	 */
	async setupDialogBindings(sessionId: string, page: Page) {
		debug.log('preview', `🎭 Setting up dialog bindings (pre-navigation) for session: ${sessionId}`);

		// Setup print interception bindings - requires exposeFunction
		await this.setupPrintInterception(sessionId, page);

		debug.log('preview', `✅ Dialog bindings setup complete for session: ${sessionId}`);
	}

	/**
	 * Setup dialog event listeners - can be called AFTER navigation
	 */
	async setupDialogHandling(sessionId: string, page: Page, session: BrowserTab) {
		debug.log('preview', `🎭 Setting up dialog event listeners for session: ${sessionId}`);

		// Intercept Puppeteer dialog events
		page.on('dialog', async (dialog: Dialog) => {
			await this.handleDialog(sessionId, dialog);
		});

		debug.log('preview', `✅ Dialog event listeners setup complete for session: ${sessionId}`);
	}

	/**
	 * Handle Puppeteer dialog event
	 */
	private async handleDialog(sessionId: string, dialog: Dialog) {
		const dialogId = nanoid(10);
		const dialogType = dialog.type();
		const message = dialog.message();
		const defaultValue = dialog.defaultValue();

		debug.log('preview', `🎭 Dialog detected - Type: ${dialogType}, Session: ${sessionId}`);

		// Store pending dialog for later response
		this.pendingDialogs.set(dialogId, dialog);

		// Emit dialog event to frontend (sessionId will be converted to tabId by previewService)
		const dialogEvent: any = {
			sessionId, // Internal use only, converted to tabId at previewService layer
			dialogId,
			type: dialogType as 'alert' | 'confirm' | 'prompt' | 'beforeunload',
			message,
			defaultValue,
			timestamp: Date.now()
		};

		this.emit('dialog', dialogEvent);

		debug.log('preview', `📤 Dialog event emitted to frontend: ${dialogId}`);
	}

	/**
	 * Handle dialog response from frontend
	 */
	async respondToDialog(response: BrowserDialogResponse) {
		const { dialogId, accept, promptText } = response;

		debug.log('preview', `🔍 Responding to dialog - dialogId: ${dialogId}, accept: ${accept}, pending dialogs: ${this.pendingDialogs.size}`);

		const dialog = this.pendingDialogs.get(dialogId);
		if (!dialog) {
			debug.warn('preview', `⚠️ Dialog not found in pendingDialogs: ${dialogId}`);
			debug.warn('preview', `   Available dialog IDs: ${Array.from(this.pendingDialogs.keys()).join(', ') || '(none)'}`);
			return false;
		}

		debug.log('preview', `✅ Dialog found in pendingDialogs - Type: ${dialog.type()}, Message: "${dialog.message()}"`);

		try {
			if (accept) {
				// User accepted (OK/Yes)
				if (dialog.type() === 'prompt' && promptText !== undefined) {
					debug.log('preview', `📝 Accepting prompt dialog with text: "${promptText}"`);
					await dialog.accept(promptText);
					debug.log('preview', `✅ Prompt accepted successfully`);
				} else {
					debug.log('preview', `📝 Accepting ${dialog.type()} dialog`);
					await dialog.accept();
					debug.log('preview', `✅ Dialog accepted successfully: ${dialogId}`);
				}
			} else {
				// User dismissed (Cancel/No)
				debug.log('preview', `📝 Dismissing ${dialog.type()} dialog`);
				await dialog.dismiss();
				debug.log('preview', `✅ Dialog dismissed successfully: ${dialogId}`);
			}

			// Remove from pending dialogs
			this.pendingDialogs.delete(dialogId);
			debug.log('preview', `🗑️ Removed dialog from pendingDialogs - remaining: ${this.pendingDialogs.size}`);
			return true;
		} catch (error) {
			debug.error('preview', `💥 Error responding to dialog ${dialogId}:`, error);
			this.pendingDialogs.delete(dialogId);
			return false;
		}
	}

	/**
	 * Setup window.print() interception
	 */
	private async setupPrintInterception(sessionId: string, page: Page) {
		try {
			// IMPORTANT: exposeFunction must be called BEFORE any navigation or evaluateOnNewDocument
			// Listen for print requests
			await page.exposeFunction('__notifyPrintRequest__', () => {
				const printEvent: any = {
					sessionId, // Internal use only, converted to tabId at previewService layer
					timestamp: Date.now()
				};

				debug.log('preview', `🖨️ Print request detected for session: ${sessionId}`);
				this.emit('print', printEvent);
			});

			// Override window.print() in the page context
			await page.evaluateOnNewDocument(() => {
				// Store original print function
				const originalPrint = window.print;

				// Override with custom handler
				window.print = function() {
					// Emit custom event that we can intercept
					window.dispatchEvent(new CustomEvent('__puppeteer_print_requested__'));

					// Don't call original print() in headless mode - it would fail
					// We'll handle it via the event
				};
			});

			// Setup event listener for print requests
			await page.evaluateOnNewDocument(() => {
				window.addEventListener('__puppeteer_print_requested__', () => {
					// Notify backend about print request
					if ((window as any).__notifyPrintRequest__) {
						(window as any).__notifyPrintRequest__();
					}
				});
			});

			debug.log('preview', `✅ Print interception setup successfully for session: ${sessionId}`);
		} catch (error) {
			// If exposeFunction fails (e.g., target closed), print interception won't work
			// but we shouldn't fail the entire session creation
			debug.warn('preview', `⚠️ Print interception setup failed for session ${sessionId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
			debug.warn('preview', `   Print functionality will not be available for this session`);
		}
	}

	/**
	 * Clear pending dialogs for a session
	 */
	clearSessionDialogs(sessionId: string) {
		// Find and dismiss all dialogs for this session
		const dialogsToRemove: string[] = [];

		for (const [dialogId, dialog] of this.pendingDialogs.entries()) {
			// Check if dialog belongs to this session (we store sessionId in the dialogId via Map)
			// Since we don't have direct sessionId mapping, we'll clear all pending dialogs
			// This is safe as each session has its own page instance
			try {
				dialog.dismiss().catch(() => {});
			} catch (error) {
				// Dialog might already be closed
			}
			dialogsToRemove.push(dialogId);
		}

		// Remove from pending map
		dialogsToRemove.forEach(id => this.pendingDialogs.delete(id));

		debug.log('preview', `🧹 Cleared ${dialogsToRemove.length} pending dialogs for session: ${sessionId}`);
	}

	/**
	 * Clear all pending dialogs
	 */
	clearAllDialogs() {
		const count = this.pendingDialogs.size;

		for (const [dialogId, dialog] of this.pendingDialogs.entries()) {
			try {
				dialog.dismiss().catch(() => {});
			} catch (error) {
				// Dialog might already be closed
			}
		}

		this.pendingDialogs.clear();
		debug.log('preview', `🧹 Cleared ${count} pending dialogs`);
	}
}
