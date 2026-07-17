/**
 * Browser Interact WebSocket Handler
 * Handles mouse/keyboard interactions with browser
 * **PROJECT ISOLATION**: Uses project-specific BrowserPreviewService instances
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import type { KeyInput } from 'puppeteer';
import { debug } from '$shared/utils/logger';
import { sleep } from '$shared/utils/async';
import { requireBrowserPreviewAccess } from '../access';

// Throttle cursor detection evaluate calls per session (100ms = ~10/sec is plenty)
const lastCursorEvalTime = new Map<string, number>();

// Helper function to check if error is navigation-related
function isNavigationError(error: Error): boolean {
	const msg = error.message.toLowerCase();
	return msg.includes('execution context was destroyed') ||
		msg.includes('target closed') ||
		msg.includes('page is loading') ||
		msg.includes('waiting for navigation') ||
		msg.includes('inspected target navigated') ||
		msg.includes('cannot find context');
}

export const interactPreviewHandler = createRouter()
	// Action: Client requests browser interaction
	.on('preview:browser-interact', {
		data: t.Object({
			action: t.Object({
				type: t.String(),
				x: t.Optional(t.Number()),
				y: t.Optional(t.Number()),
				startX: t.Optional(t.Number()),
				startY: t.Optional(t.Number()),
				endX: t.Optional(t.Number()),
				endY: t.Optional(t.Number()),
				currentX: t.Optional(t.Number()),
				currentY: t.Optional(t.Number()),
				text: t.Optional(t.String()),
				key: t.Optional(t.String()),
				button: t.Optional(t.String()),
				delay: t.Optional(t.Number()),
				steps: t.Optional(t.Number()),
				deltaX: t.Optional(t.Number()),
				deltaY: t.Optional(t.Number()),
				selector: t.Optional(t.String()),
				value: t.Optional(t.String()),
				optionIndex: t.Optional(t.Number()),
				ctrlKey: t.Optional(t.Boolean()),
				metaKey: t.Optional(t.Boolean()),
				altKey: t.Optional(t.Boolean()),
				shiftKey: t.Optional(t.Boolean()),
				clearFirst: t.Optional(t.Boolean()),
				scale: t.Optional(t.Number()),
				width: t.Optional(t.Number()),
				height: t.Optional(t.Number()),
				deviceSize: t.Optional(t.String()),
				rotation: t.Optional(t.String())
			}),
		})
	}, async ({ data, conn }) => {
		const { userId, projectId, previewService } = requireBrowserPreviewAccess(conn);

		try {
			const { action } = data;

			// Get active tab (mirip MCP pattern)
			const tab = previewService.getActiveTab();
			if (!tab) {
				debug.error('preview', `❌ NO ACTIVE TAB for project ${projectId} - Available tabs: ${previewService.getTabCount()}`);
				ws.emit.user(userId, 'preview:browser-error', {
					message: 'No active tab. Please open or switch to a tab first.'
				});
				return;
			}

			const session = tab;
			const tabId = tab.id;

			// Check if page is still open and valid
			if (!session.page || session.page.isClosed()) {
				debug.warn('preview', `⚠️ Cannot execute interaction: page is closed for tab ${tabId}`);
				ws.emit.user(userId, 'preview:browser-error', {
					message: 'Browser page is closed'
				});
				return;
			}

			// Check if browser is still connected
			if (!session.browser || !session.browser.connected) {
				debug.warn('preview', `⚠️ Cannot execute interaction: browser disconnected for tab ${tabId}`);
				ws.emit.user(userId, 'preview:browser-error', {
					message: 'Browser is disconnected'
				});
				return;
			}

			// Mark tab activity to prevent automatic cleanup
			previewService.markActiveTabActivity();

			// Execute the interaction based on type with navigation-safe error handling
			try {
				switch (action.type) {
					case 'mousedown':
						try {
							// Fire-and-forget reset — CDP processes commands in FIFO order so
							// this completes before move/down even though we skip the await.
							session.page.mouse.up().catch(() => {});
							// Move to position and press button
							await session.page.mouse.move(action.x!, action.y!, { steps: 1 });
							await session.page.mouse.down({ button: action.button === 'right' ? 'right' : 'left' });
						} catch (error) {
							if (error instanceof Error && isNavigationError(error)) {
								ws.emit.user(userId, 'preview:browser-interacted', { action: action.type, message: 'Action deferred (navigation)', deferred: true });
								return;
							}
							throw error;
						}
						break;

					case 'mouseup':
						try {
							await session.page.mouse.up({ button: action.button === 'right' ? 'right' : 'left' });
						} catch (error) {
							if (error instanceof Error && isNavigationError(error)) {
								ws.emit.user(userId, 'preview:browser-interacted', { action: action.type, message: 'Action deferred (navigation)', deferred: true });
								return;
							}
							// Ignore "not pressed" errors - might have been released already
							if (error instanceof Error && error.message.includes('not pressed')) {
								break;
							}
							throw error;
						}
						break;

					case 'click':
						try {
							// Check for select element BEFORE clicking.
							// Skip the mouse.up() reset: page.mouse.click() is atomic (down+up),
							// and Canvas.svelte always sends mouseup before sending click, so the
							// mouse state is already clean at this point.
							const selectInfo = await previewService.checkForSelectElement(session.id, action.x!, action.y!);
							if (selectInfo) {
								// Select element detected - event emitted by checkForSelectElement
								// Don't perform regular click, frontend will show dropdown overlay
								debug.log('preview', `✅ Select element detected at (${action.x}, ${action.y}), skipping regular click`);
								break;
							}

							// Perform the click - this does down + up atomically
							await session.page.mouse.click(action.x!, action.y!);
						} catch (error) {
							if (error instanceof Error) {
								if (isNavigationError(error)) {
									ws.emit.user(userId, 'preview:browser-interacted', { action: action.type, message: 'Click triggered navigation', deferred: true });
									return;
								}
								// These errors are recoverable - the click likely worked
								if (error.message.includes('already pressed') || error.message.includes('not pressed')) {
									// Mouse state errors are recoverable, continue without fallback
									break;
								}
							}
							throw error;
						}
						break;

					case 'type':
						if (action.text) {
							try {
								// For user manual typing, clearFirst defaults to false (append behavior)
								// User can explicitly set clearFirst: true if they want to clear
								const shouldClear = action.clearFirst === true; // default false for user

								if (shouldClear) {
									// Select all text first (Ctrl+A), then type will overwrite
									await session.page.keyboard.down('Control');
									await session.page.keyboard.press('KeyA');
									await session.page.keyboard.up('Control');
									await sleep(50); // Small delay for selection
								}

								await session.page.keyboard.type(action.text, {
									delay: action.delay || 50
								});
							} catch (error) {
								if (error instanceof Error && isNavigationError(error)) {
									ws.emit.user(userId, 'preview:browser-interacted', { action: action.type, message: 'Action deferred (navigation)', deferred: true });
									return;
								}
								throw error;
							}
						}
						break;

					case 'key':
						if (action.key) {
							try {
								// Handle modifier keys (Ctrl+C, Ctrl+V, etc.)
								const modifiers: string[] = [];
								if (action.ctrlKey) modifiers.push('Control');
								if (action.metaKey) modifiers.push('Meta');
								if (action.altKey) modifiers.push('Alt');
								if (action.shiftKey) modifiers.push('Shift');

								if (modifiers.length > 0) {
									// Press modifiers first
									for (const mod of modifiers) {
										await session.page.keyboard.down(mod as KeyInput);
									}
									// Press the main key
									await session.page.keyboard.press(action.key as KeyInput);
									// Release modifiers in reverse order
									for (const mod of modifiers.reverse()) {
										await session.page.keyboard.up(mod as KeyInput);
									}
								} else {
									// No modifiers, just press the key
									await session.page.keyboard.press(action.key as KeyInput);
								}
							} catch (error) {
								if (error instanceof Error && isNavigationError(error)) {
									ws.emit.user(userId, 'preview:browser-interacted', { action: action.type, message: 'Action deferred (navigation)', deferred: true });
									return;
								}
								throw error;
							}
						}
						break;

					case 'mousemove':
						try {
							// Use minimal steps for smoother, faster mouse movement
							await session.page.mouse.move(action.x!, action.y!, {
								steps: action.steps || 1 // Reduced from 5 to 1 for faster response
							});
							// Cursor detection via page.evaluate — throttled to ~10/sec per session.
							// Running it on every mousemove queues extra CDP commands that delay clicks/keypresses.
							const nowMs = Date.now();
							const lastEval = lastCursorEvalTime.get(session.id) ?? 0;
							if (nowMs - lastEval >= 100) {
								lastCursorEvalTime.set(session.id, nowMs);
								session.page.evaluate((data) => {
									const { x, y } = data;
									let cursor = 'default';
									try {
										const el = document.elementFromPoint(x, y);
										if (el) {
											cursor = window.getComputedStyle(el).cursor || 'default';
										}
									} catch {}

									const existing = (window as any).__cursorInfo;
									if (existing) {
										existing.cursor = cursor;
										existing.x = x;
										existing.y = y;
										existing.timestamp = Date.now();
										existing.hasRecentInteraction = true;
									} else {
										(window as any).__cursorInfo = {
											cursor,
											x,
											y,
											timestamp: Date.now(),
											hasRecentInteraction: true
										};
									}
								}, { x: action.x!, y: action.y! }).catch(() => { /* Ignore evaluation errors */ });
							}
						} catch (error) {
							if (error instanceof Error && isNavigationError(error)) {
								ws.emit.user(userId, 'preview:browser-interacted', { action: action.type, message: 'Action deferred (navigation)', deferred: true });
								return;
							}
							throw error;
						}
						break;

					case 'scroll':
						try {
							await session.page.mouse.wheel({ deltaX: action.deltaX || 0, deltaY: action.deltaY || 0 });
						} catch (error) {
							if (error instanceof Error && isNavigationError(error)) {
								ws.emit.user(userId, 'preview:browser-interacted', { action: action.type, message: 'Action deferred (navigation)', deferred: true });
								return;
							}
							throw error;
						}
						break;

					case 'doubleclick':
						try {
							await session.page.mouse.click(action.x!, action.y!, { clickCount: 2 });
						} catch (error) {
							if (error instanceof Error) {
								if (isNavigationError(error)) {
									ws.emit.user(userId, 'preview:browser-interacted', { action: action.type, message: 'Action deferred (navigation)', deferred: true });
									return;
								}
								if (error.message.includes('already pressed') || error.message.includes('not pressed')) break;
							}
							throw error;
						}
						break;

					case 'rightclick':
						try {
							// Fire-and-forget reset (see mousedown comment for rationale)
							session.page.mouse.up().catch(() => {});

							// IMPORTANT: Check for context menu
							// We'll emit context menu event to frontend for custom overlay
							const menuInfo = await previewService.checkForContextMenu(session.id, action.x!, action.y!);
							if (menuInfo) {
								// Context menu detected - event emitted by checkForContextMenu
								debug.log('preview', `✅ Context menu detected at (${action.x}, ${action.y})`);
								// Don't perform regular right-click, frontend will show context menu overlay
								break;
							}

							await session.page.mouse.click(action.x!, action.y!, { button: 'right' });
						} catch (error) {
							if (error instanceof Error) {
								if (isNavigationError(error)) {
									ws.emit.user(userId, 'preview:browser-interacted', { action: action.type, message: 'Action deferred (navigation)', deferred: true });
									return;
								}
								if (error.message.includes('already pressed') || error.message.includes('not pressed')) break;
							}
							throw error;
						}
						break;

					case 'drag':
						try {
							// Ensure clean state before drag
							try { await session.page.mouse.up(); } catch { }

							// Move to start, press, drag, release
							await session.page.mouse.move(action.startX!, action.startY!, { steps: 1 });
							await session.page.mouse.down();
							await session.page.mouse.move(action.endX!, action.endY!, { steps: 3 });
							await session.page.mouse.up();
						} catch (error) {
							try { await session.page.mouse.up(); } catch { }
							if (error instanceof Error && isNavigationError(error)) {
								ws.emit.user(userId, 'preview:browser-interacted', { action: action.type, message: 'Drag during navigation', deferred: true });
								return;
							}
						}
						break;

					case 'dragmove':
						try {
							await session.page.mouse.move(action.currentX!, action.currentY!, { steps: 1 });
						} catch { }
						break;

					case 'keynav':
						if (action.key) {
							const modifiers: string[] = [];
							if (action.ctrlKey) modifiers.push('Control');
							if (action.metaKey) modifiers.push('Meta');
							if (action.altKey) modifiers.push('Alt');
							if (action.shiftKey) modifiers.push('Shift');

							if (modifiers.length > 0) {
								for (const mod of modifiers) {
									await session.page.keyboard.down(mod as KeyInput);
								}
								await session.page.keyboard.press(action.key as KeyInput);
								for (const mod of modifiers.reverse()) {
									await session.page.keyboard.up(mod as KeyInput);
								}
							} else {
								await session.page.keyboard.press(action.key as KeyInput);
							}

					}
						break;

					case 'checkselectoptions':
						if (action.x && action.y) {
							try {
								await session.page.evaluate((coordinates) => {
									const { x, y } = coordinates;
									const element = document.elementFromPoint(x, y);

									if (!element) return null;

									const isSelect = element.tagName === 'SELECT';
									const isOption = element.tagName === 'OPTION' || element.getAttribute('role') === 'option';
									const isDropdown = element.classList.contains('dropdown') ||
										element.classList.contains('select') ||
										element.getAttribute('role') === 'listbox';

									let options: Array<{ index: number, value: string, text: string, selected: boolean }> = [];
									if (isSelect || isDropdown || isOption) {
										const selectElement = isSelect ? element :
											element.closest('select') ||
											element.closest('[role="listbox"]') ||
											element.closest('.dropdown');

										if (selectElement) {
											if (selectElement.tagName === 'SELECT') {
												options = Array.from(selectElement.querySelectorAll('option')).map((opt, index) => ({
													index,
													value: opt.value || '',
													text: opt.textContent || '',
													selected: opt.selected
												}));
											} else {
												options = Array.from(selectElement.querySelectorAll('[role="option"], .option, .dropdown-item')).map((opt, index) => ({
													index,
													value: opt.getAttribute('data-value') || opt.textContent || '',
													text: opt.textContent || '',
													selected: opt.getAttribute('aria-selected') === 'true' || opt.classList.contains('selected')
												}));
											}
										}
									}

									return {
										elementType: element.tagName,
										isSelect,
										isOption,
										isDropdown,
										hasOptions: options.length > 0,
										options: options.slice(0, 10),
										elementId: element.id,
										elementClass: element.className,
										elementText: element.textContent?.slice(0, 100)
									};
								}, { x: action.x, y: action.y });
							} catch (error) {
								debug.error('preview', 'Error checking for select options:', error);
							}
						}
						break;

					case 'scale-update':
						// Display fit-scale changed on the frontend (CSS-only concern).
						// Capture stays at native viewport resolution — restart the
						// screencast as a refresh so a stuck stream recovers (the
						// frontend also uses this action as its refresh path).
						if (action.scale && action.scale > 0 && action.scale <= 1) {
							session.scale = action.scale;
							debug.log('preview', `📐 Scale updated for tab ${tabId}: ${action.scale} (display-only), refreshing screencast`);

							const updated = await previewService.refreshWebCodecsScreencast(session.id);
							if (!updated) {
								debug.warn('preview', `⚠️ Screencast refresh failed, falling back to restart`);
								// Fallback: restart if refresh fails
								await previewService.stopWebCodecsStreaming(session.id);
								await previewService.startWebCodecsStreaming(session.id);
							}
						}
						break;

					case 'viewport-update':
						// Handle viewport change (device/rotation) without reconnection
						if (action.width && action.height && action.scale && action.scale > 0 && action.scale <= 1) {
							session.scale = action.scale;
							if (action.deviceSize) session.deviceSize = action.deviceSize as any;
							if (action.rotation) session.rotation = action.rotation as any;

							debug.log('preview', `📱 Viewport updated for tab ${tabId}: ${action.width}x${action.height}`);

							// Hot-swap viewport without reconnection
							const updated = await previewService.updateWebCodecsViewport(session.id, action.width, action.height);
							if (!updated) {
								debug.warn('preview', `⚠️ Viewport hot-swap failed`);
							}
						}
						break;

					default:
						ws.emit.user(userId, 'preview:browser-error', {
							message: `Unknown action type: ${action.type}`
						});
						return;
				}
			} catch (interactionError) {
				if (interactionError instanceof Error) {
					const errorMsg = interactionError.message.toLowerCase();

					if (errorMsg.includes('execution context was destroyed') ||
						errorMsg.includes('target closed') ||
						errorMsg.includes('page is loading') ||
						errorMsg.includes('waiting for navigation')) {

						ws.emit.user(userId, 'preview:browser-interacted', {
							action: action.type,
							message: `Action ${action.type} deferred due to page loading`,
							deferred: true
						});
						return;
					}
				}
				throw interactionError;
			}

			ws.emit.user(userId, 'preview:browser-interacted', {
				action: action.type,
				message: `Action ${action.type} executed successfully`
			});
		} catch (error) {
			debug.error('preview', 'Error executing browser interaction:', error);
			ws.emit.user(userId, 'preview:browser-error', {
				message: error instanceof Error ? error.message : 'Unknown error'
			});
		}
	})

	// Server → Client Events (independent declarations)
	.emit('preview:browser-interacted', t.Object({
		action: t.String(),
		message: t.String(),
		deferred: t.Optional(t.Boolean())
	}))
	.emit('preview:browser-error', t.Object({
		message: t.String()
	}));
