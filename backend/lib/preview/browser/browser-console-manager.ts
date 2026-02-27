import { EventEmitter } from 'events';
import type { Page, ConsoleMessage as PuppeteerConsoleMessage, HTTPResponse } from 'puppeteer';
import type { BrowserConsoleMessage, BrowserTab } from './types';

import { debug } from '$shared/utils/logger';
export class BrowserConsoleManager extends EventEmitter {
	constructor() {
		super();
	}

	async setupConsoleLogging(sessionId: string, page: Page, session: BrowserTab) {

		// Clear any existing console logs for this session
		session.consoleLogs = [];

		// Listen to ALL console events from the page
		page.on('console', async (consoleMessage: PuppeteerConsoleMessage) => {
			// Always log to server console for debugging
			if (!session.consoleEnabled) {
				return;
			}

			try {
				const messageId = `console-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
				const text = consoleMessage.text();
				const type = consoleMessage.type() as BrowserConsoleMessage['type'];

				// Get location information (Puppeteer uses location() method)
				const location = consoleMessage.location();
				const messageLocation = location ? {
					url: location.url || '',
					lineNumber: location.lineNumber || 0,
					columnNumber: location.columnNumber || 0
				} : undefined;

				// Extract arguments with improved error handling
				let args: any[] = [];
				try {
					const messageArgs = consoleMessage.args();
					if (messageArgs && messageArgs.length > 0) {
						args = await Promise.all(
							messageArgs.map(async (arg) => {
								try {
									// Try to get JSON value first
									const jsonValue = await arg.jsonValue();
									return jsonValue;
								} catch {
									try {
										// Fallback to string representation
										return arg.toString();
									} catch {
										// Final fallback
										return '[Unable to serialize]';
									}
								}
							})
						);
					}
				} catch (error) {
					debug.warn('preview', 'Could not extract console message args:', error);
					args = [];
				}

				const consoleLog: BrowserConsoleMessage = {
					id: messageId,
					type,
					text,
					args,
					location: messageLocation,
					timestamp: Date.now()
				};

				// Add to session logs (with limit to prevent memory issues)
				session.consoleLogs.push(consoleLog);
				if (session.consoleLogs.length > 1000) {
					session.consoleLogs = session.consoleLogs.slice(-500); // Keep last 500 logs
				}

				// Emit console message event for real-time streaming
				this.emit('console-message', {
					sessionId: session.id,
					message: consoleLog
				});


			} catch (error) {
				debug.error('preview', '❌ Error processing console message:', error);
			}
		});

		// Listen to page errors (uncaught JavaScript errors)
		page.on('pageerror', (err) => {
			if (!session.consoleEnabled) {
				return;
			}

			try {
				const error = err as Error;
				const messageId = `error-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
				const consoleLog: BrowserConsoleMessage = {
					id: messageId,
					type: 'error',
					text: `Uncaught ${error.message || String(err)}`,
					stackTrace: error.stack,
					timestamp: Date.now()
				};

				session.consoleLogs.push(consoleLog);
				if (session.consoleLogs.length > 1000) {
					session.consoleLogs = session.consoleLogs.slice(-500);
				}

				this.emit('console-message', {
					sessionId: session.id,
					message: consoleLog
				});


			} catch (err) {
				debug.error('preview', '❌ Error processing page error:', err);
			}
		});

		// Listen to response failures (network errors)
		page.on('response', (response: HTTPResponse) => {
			if (!session.consoleEnabled) return;

			if (!response.ok() && response.status() >= 400) {

				
				try {
					const messageId = `network-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
					const consoleLog: BrowserConsoleMessage = {
						id: messageId,
						type: 'error',
						text: `Network error: ${response.status()} ${response.statusText()} - ${response.url()}`,
						location: {
							url: response.url(),
							lineNumber: 0,
							columnNumber: 0
						},
						timestamp: Date.now()
					};

					session.consoleLogs.push(consoleLog);
					if (session.consoleLogs.length > 1000) {
						session.consoleLogs = session.consoleLogs.slice(-500);
					}

					this.emit('console-message', {
						sessionId: session.id,
						message: consoleLog
					});


				} catch (err) {
					debug.error('preview', '❌ Error processing network error:', err);
				}
			}
		});

		// Console monitoring is handled automatically by Puppeteer's console event listener
		// No additional injection needed


	}

	getConsoleLogs(session: BrowserTab): BrowserConsoleMessage[] {
		return session ? session.consoleLogs : [];
	}

	clearConsoleLogs(session: BrowserTab): boolean {
		if (!session) return false;

		session.consoleLogs = [];
		
		// Add a clear message to console logs
		const clearMessage: BrowserConsoleMessage = {
			id: `clear-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
			type: 'clear',
			text: 'Console was cleared',
			timestamp: Date.now()
		};

		session.consoleLogs.push(clearMessage);

		// Emit clear event
		this.emit('console-clear', {
			sessionId: session.id,
			timestamp: Date.now()
		});


		return true;
	}

	toggleConsoleLogging(session: BrowserTab, enabled: boolean): boolean {
		if (!session) return false;

		session.consoleEnabled = enabled;

		return true;
	}

	async executeConsoleCommand(session: BrowserTab, command: string): Promise<any> {
		if (!session) throw new Error('Session not found');

		try {

			
			// Execute the command in the browser context
			const result = await session.page.evaluate((cmd: string) => {
				// Create a safe evaluation context
				try {
					// Use Function constructor for safer evaluation than eval
					const func = new Function('return ' + cmd);
					return func();
				} catch (error) {
					return { error: error instanceof Error ? error.message : String(error) };
				}
			}, command);

			// Log the command execution as a console message
			const commandMessage: BrowserConsoleMessage = {
				id: `command-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
				type: 'log',
				text: `> ${command}`,
				args: [result],
				timestamp: Date.now()
			};

			session.consoleLogs.push(commandMessage);

			// Emit the command result
			this.emit('console-message', {
				sessionId: session.id,
				message: commandMessage
			});

			return result;
		} catch (error) {
			debug.error('preview', 'Error executing console command:', error);
			
			// Log the error as a console message
			const errorMessage: BrowserConsoleMessage = {
				id: `command-error-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
				type: 'error',
				text: `Error executing command: ${command}`,
				args: [error instanceof Error ? error.message : String(error)],
				timestamp: Date.now()
			};

			session.consoleLogs.push(errorMessage);

			this.emit('console-message', {
				sessionId: session.id,
				message: errorMessage
			});

			throw error;
		}
	}
}