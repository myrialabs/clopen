import { EventEmitter } from 'events';
import type { Page, KeyInput } from 'puppeteer';
import type { BrowserAutonomousAction, BrowserTab } from './types';
import { debug } from '$shared/utils/logger';
import { sleep } from '$shared/utils/async';
import { browserMcpControl } from './browser-mcp-control';

export class BrowserInteractionHandler extends EventEmitter {
	// Track cursor positions per session
	private sessionCursorPositions: Map<string, {x: number, y: number}> = new Map();

	constructor() {
		super();
	}

	// MCP-optimized mouse movement with smooth curves and ease-out easing
	private async mcpMouseMove(page: Page, fromX: number, fromY: number, toX: number, toY: number, steps: number = 8) {
		const controlPointX = fromX + (toX - fromX) * 0.5 + (Math.random() - 0.5) * 50;
		const controlPointY = fromY + (toY - fromY) * 0.5 + (Math.random() - 0.5) * 50;

		// Get session for emitting cursor position
		const sessionId = (page as any).__sessionId;

		for (let i = 0; i <= steps; i++) {
			const t = i / steps;

			// Apply ease-out cubic easing: starts fast, ends slow
			const easedT = 1 - Math.pow(1 - t, 3);

			// Quadratic Bezier curve for natural movement with ease-out easing
			const x = Math.round((1 - easedT) * (1 - easedT) * fromX + 2 * (1 - easedT) * easedT * controlPointX + easedT * easedT * toX);
			const y = Math.round((1 - easedT) * (1 - easedT) * fromY + 2 * (1 - easedT) * easedT * controlPointY + easedT * easedT * toY);

			await page.mouse.move(x, y);

			// Emit cursor position for visual tracking
			if (sessionId) {
				this.updateCursorPosition(sessionId, x, y);

				// Emit to WebSocket for frontend virtual cursor
				browserMcpControl.emitCursorPosition(sessionId, x, y);

				this.emit('cursor-position', {
					sessionId,
					x,
					y,
					timestamp: Date.now()
				});
			}

			// Smooth delay between movements (15-25ms) for MCP automation
			const moveDelay = 15 + Math.random() * 10;
			await sleep(moveDelay);
		}
	}

	// MCP-optimized typing with fast, consistent speed
	private async mcpType(page: Page, text: string, baseDelay: number = 30) {
		for (let i = 0; i < text.length; i++) {
			const char = text[i];

			// Fast typing with slight variance (20-40ms) for MCP automation
			const delay = baseDelay + Math.random() * 10;

			await page.keyboard.type(char, { delay });
		}
	}

	// Get current mouse position from session tracking
	private getCurrentMousePosition(sessionId: string): {x: number, y: number} {
		const stored = this.sessionCursorPositions.get(sessionId);
		if (stored) {
			return stored;
		}

		// Default to center of viewport for first action
		const defaultPos = { x: 400, y: 300 };
		this.sessionCursorPositions.set(sessionId, defaultPos);
		return defaultPos;
	}

	// Update and persist cursor position for session
	private updateCursorPosition(sessionId: string, x: number, y: number) {
		const position = { x, y };
		this.sessionCursorPositions.set(sessionId, position);
	}

	// Clear cursor position for session (when session ends)
	public clearSessionCursor(sessionId: string) {
		this.sessionCursorPositions.delete(sessionId);
	}

	// Clear all session cursors (when cleaning up all sessions)
	public clearAllSessionCursors() {
		const sessionCount = this.sessionCursorPositions.size;
		this.sessionCursorPositions.clear();
	}

	async performAutonomousActions(
		sessionId: string,
		session: BrowserTab,
		actions: BrowserAutonomousAction[],
		isValidSession: () => boolean
	) {
		let currentMousePos = this.getCurrentMousePosition(sessionId);
		const results: any[] = [];

		// Store session ID on page for cursor tracking
		(session.page as any).__sessionId = sessionId;

		for (let i = 0; i < actions.length; i++) {
			// Check if session is still valid before each action
			if (!isValidSession()) {
				debug.warn('preview', `⚠️ Session ${sessionId} is no longer valid, stopping autonomous actions at ${i + 1}/${actions.length}`);
				return;
			}

			const action = actions[i];

			try {
				switch (action.type) {
					case 'wait':
						await sleep(action.delay || 1000);
						break;

					case 'move':
						if (action.x !== undefined && action.y !== undefined) {
							// Always use MCP-optimized movement
							await this.mcpMouseMove(
								session.page,
								currentMousePos.x,
								currentMousePos.y,
								action.x,
								action.y,
								action.steps || 8
							);
							currentMousePos = { x: action.x, y: action.y };
							this.updateCursorPosition(sessionId, action.x, action.y);

							// Emit to WebSocket for frontend virtual cursor
							browserMcpControl.emitCursorPosition(sessionId, action.x, action.y);

							this.emit('cursor-position', {
								sessionId: session.id,
								x: action.x,
								y: action.y,
								timestamp: Date.now()
							});
						}
						break;

					case 'type': {
						// Clear existing input first if specified (default: true for MCP autonomous)
						const shouldClear = action.clearFirst !== false; // default true

						if (shouldClear && action.text) {
							// Select all text first (Ctrl+A), then type will overwrite
							await session.page.keyboard.down('Control');
							await session.page.keyboard.press('KeyA');
							await session.page.keyboard.up('Control');
							await sleep(30); // Fast delay for MCP automation
						}

						// Native keyboard: type text OR press single key
						if (action.text) {
							// Always use MCP-optimized typing
							await this.mcpType(session.page, action.text, action.delay || 30);
						} else if (action.key) {
							await session.page.keyboard.press(action.key as KeyInput);
						}
						break;
					}

					case 'click': {
						// Native mouse click at coordinates
						if (action.x === undefined || action.y === undefined) break;

						const button = action.click || 'left';

						// Move mouse to target position with MCP-optimized movement
						await this.mcpMouseMove(
							session.page,
							currentMousePos.x,
							currentMousePos.y,
							action.x,
							action.y,
							8
						);

						currentMousePos = { x: action.x, y: action.y };
						this.updateCursorPosition(sessionId, action.x, action.y);

						// Emit cursor position to WebSocket for frontend virtual cursor
						browserMcpControl.emitCursorPosition(sessionId, action.x, action.y);

						this.emit('cursor-position', {
							sessionId: session.id,
							x: action.x,
							y: action.y,
							timestamp: Date.now()
						});

						await sleep(30);

						// Emit click event to WebSocket for frontend virtual cursor
						browserMcpControl.emitCursorClick(sessionId, action.x, action.y);

						this.emit('cursor-click', {
							sessionId: session.id,
							x: action.x,
							y: action.y,
							timestamp: Date.now()
						});

						// Native mouse click with slight variance for MCP automation
						const finalX = action.x + (Math.random() - 0.5) * 2;
						const finalY = action.y + (Math.random() - 0.5) * 2;
						await session.page.mouse.click(finalX, finalY, { button });
						break;
					}

					case 'scroll':
						// Move cursor to target area first if coordinates provided
						// This ensures scroll happens in the correct scrollable container (like human behavior)
						if (action.x !== undefined && action.y !== undefined) {
							await session.page.mouse.move(action.x, action.y, { steps: 1 });
							currentMousePos = { x: action.x, y: action.y };
							this.updateCursorPosition(sessionId, action.x, action.y);

							// Emit cursor position for visual tracking
							browserMcpControl.emitCursorPosition(sessionId, action.x, action.y);
							this.emit('cursor-position', {
								sessionId: session.id,
								x: action.x,
								y: action.y,
								timestamp: Date.now()
							});

							await sleep(50); // Small delay after positioning
						}

						// Perform scroll using deltaX/deltaY
						if (action.deltaX !== undefined || action.deltaY !== undefined) {
							if (action.smooth) {
								const steps = 5;
								const stepX = (action.deltaX || 0) / steps;
								const stepY = (action.deltaY || 0) / steps;

								for (let s = 0; s < steps; s++) {
									await session.page.mouse.wheel({ deltaX: stepX, deltaY: stepY });
									await sleep(50);
								}
							} else {
								await session.page.mouse.wheel({
									deltaX: action.deltaX || 0,
									deltaY: action.deltaY || 0
								});
							}
						}
						break;

					case 'extract_data': {
						// Extract data from DOM element - fully automatic selector and attribute detection
						if (!action.selector) {
							debug.warn('preview', `⚠️ extract_data action requires selector`);
							results.push({
								action: 'extract_data',
								selector: undefined,
								data: null,
								error: 'selector is required',
								timestamp: Date.now()
							});
							break;
						}

						const identifier = action.selector;

						try {
							// Smart extraction - try all selector patterns and all attributes automatically
							const result = await session.page.evaluate((id: string) => {
								// Try multiple selector patterns
								const selectors = [
									id,                              // exact (user might already include # or .)
									`#${id}`,                        // ID selector
									`.${id}`,                        // class selector
									`[id="${id}"]`,                  // attribute exact match
									`[id*="${id}"]`,                 // ID contains
									`[class*="${id}"]`,              // class contains
									`[data-testid="${id}"]`,         // test ID
									`[name="${id}"]`,                // name attribute
									id.toLowerCase(),                // lowercase tag
									`#${id.toLowerCase()}`,          // lowercase ID
									`.${id.toLowerCase()}`,          // lowercase class
								];

								let element: Element | null = null;
								let usedSelector = '';

								// Try each selector until one works
								for (const selector of selectors) {
									try {
										element = document.querySelector(selector);
										if (element) {
											usedSelector = selector;
											break;
										}
									} catch (e) {
										// Invalid selector, skip
										continue;
									}
								}

								if (!element) {
									return { data: null, selector: null, attribute: null, tried: selectors.slice(0, 5) };
								}

								// Smart attribute extraction - try all common attributes and return first non-empty
								const extractors = [
									{ name: 'value', fn: () => (element as HTMLInputElement).value },
									{ name: 'textContent', fn: () => element!.textContent?.trim() },
									{ name: 'innerText', fn: () => (element as HTMLElement).innerText?.trim() },
									{ name: 'innerHTML', fn: () => element!.innerHTML?.trim() },
								];

								let data = null;
								let usedAttribute = '';

								for (const extractor of extractors) {
									try {
										const extracted = extractor.fn();
										if (extracted && extracted.length > 0) {
											data = extracted;
											usedAttribute = extractor.name;
											break;
										}
									} catch (e) {
										// Attribute doesn't exist or failed, continue
										continue;
									}
								}

								return {
									data,
									selector: usedSelector,
									attribute: usedAttribute,
									tried: data ? [usedSelector] : selectors.slice(0, 5)
								};
							}, identifier);

							if (result.data !== null) {
								results.push({
									action: 'extract_data',
									selector: result.selector,
									attribute: result.attribute,
									data: result.data,
									timestamp: Date.now()
								});
							} else {
								results.push({
									action: 'extract_data',
									selector: identifier,
									attribute: null,
									data: null,
									error: `Element not found or empty. Tried selectors: ${result.tried.join(', ')}`,
									timestamp: Date.now()
								});
							}
						} catch (extractError) {
							debug.error('preview', `❌ Error extracting data from ${identifier}:`, extractError);
							results.push({
								action: 'extract_data',
								selector: identifier,
								attribute: null,
								data: null,
								error: (extractError as Error)?.message || 'Unknown error',
								timestamp: Date.now()
							});
						}
						break;
					}

					default:
						debug.warn('preview', `⚠️ Unknown action type: ${(action as any).type}`);
				}

				// Fast delay between actions for MCP automation (50-100ms)
				const betweenActionDelay = 50 + Math.random() * 50;

				// Don't add delay after explicit wait actions
				if (action.type !== 'wait') {
					await sleep(betweenActionDelay);
				}

			} catch (error) {
				debug.error('preview', `❌ Error performing action ${action.type}:`, error);

				// Check if error is due to closed page/browser
				const errorMessage = (error as Error)?.message || '';
				if (errorMessage.includes('Target page, context or browser has been closed') ||
					errorMessage.includes('Browser has been closed') ||
					errorMessage.includes('Page has been closed')) {

					debug.warn('preview', `⚠️ Browser/page closed during action ${i + 1}/${actions.length}, stopping autonomous actions`);
					return;
				}

				// Continue with next action for other errors
			}
		}


		// Emit test completed event to hide virtual cursor
		this.emit('test-completed', {
			sessionId: session.id,
			timestamp: Date.now()
		});

		return results;
	}

}
