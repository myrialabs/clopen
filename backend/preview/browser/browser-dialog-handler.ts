import { EventEmitter } from 'events';
import type { Page, Dialog } from 'puppeteer';
import type { BrowserDialogResponse } from './types';
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
/**
 * How long a dialog waits for the viewer before it is dismissed on its own.
 *
 * A JS dialog blocks the renderer, so an unanswered one freezes the page —
 * including the video stream. That is the correct behaviour while someone is
 * looking at the prompt, and a hang once nobody is (panel closed, browser tab
 * gone), which is what this bound exists for.
 */
const DIALOG_RESPONSE_TIMEOUT_MS = 120_000;

export class BrowserDialogHandler extends EventEmitter {
	// Store pending dialogs waiting for response, tagged with the tab that raised
	// them so closing one tab cannot dismiss another tab's prompt.
	private pendingDialogs = new Map<string, { sessionId: string; dialog: Dialog; timeout: NodeJS.Timeout }>();

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
	async setupDialogHandling(sessionId: string, page: Page) {
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

		// Store pending dialog for later response, with a deadline so an
		// unattended page cannot stay blocked indefinitely.
		const timeout = setTimeout(() => {
			this.pendingDialogs.delete(dialogId);
			debug.warn('preview', `⏱️ Dialog ${dialogId} unanswered, auto-dismissing`);
			// beforeunload is the one dialog where dismissing is the safe default
			// in both directions: it cancels the navigation rather than losing work.
			dialog.dismiss().catch(() => {});
			this.emit('dialog-closed', { sessionId, dialogId, timestamp: Date.now() });
		}, DIALOG_RESPONSE_TIMEOUT_MS);

		this.pendingDialogs.set(dialogId, { sessionId, dialog, timeout });

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

		const entry = this.pendingDialogs.get(dialogId);
		if (!entry) {
			debug.warn('preview', `⚠️ Dialog not found in pendingDialogs: ${dialogId}`);
			debug.warn('preview', `   Available dialog IDs: ${Array.from(this.pendingDialogs.keys()).join(', ') || '(none)'}`);
			return false;
		}

		const { dialog } = entry;
		clearTimeout(entry.timeout);

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
			// The page has one dialog and it is now answered, but every viewer of
			// this tab was shown a copy of it. Telling them all it is settled is
			// what stops the other devices holding a prompt that no longer exists.
			this.emit('dialog-closed', { sessionId: entry.sessionId, dialogId, timestamp: Date.now() });
			return true;
		} catch (error) {
			debug.error('preview', `💥 Error responding to dialog ${dialogId}:`, error);
			this.pendingDialogs.delete(dialogId);
			this.emit('dialog-closed', { sessionId: entry.sessionId, dialogId, timestamp: Date.now() });
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
		const dialogsToRemove: string[] = [];

		for (const [dialogId, entry] of this.pendingDialogs.entries()) {
			if (entry.sessionId !== sessionId) continue;

			clearTimeout(entry.timeout);
			try {
				entry.dialog.dismiss().catch(() => {});
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

		for (const entry of this.pendingDialogs.values()) {
			clearTimeout(entry.timeout);
			try {
				entry.dialog.dismiss().catch(() => {});
			} catch (error) {
				// Dialog might already be closed
			}
		}

		this.pendingDialogs.clear();
		debug.log('preview', `🧹 Cleared ${count} pending dialogs`);
	}
}
