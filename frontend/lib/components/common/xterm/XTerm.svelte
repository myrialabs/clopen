<!--
	Modular XTerm Component - xterm.js Integration
	Cleaner, more maintainable implementation using XTermService
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$frontend/lib/app-environment';
	import type { TerminalSession } from '$shared/types/terminal';
	import { XTermService } from './xterm-service';
	import type { XTermProps, XTermMethods } from './types';
	import { terminalStore } from '$frontend/lib/stores/features/terminal.svelte';
	import { backgroundTerminalService } from '$frontend/lib/services/terminal/background';
	import { terminalService } from '$frontend/lib/services/terminal';
	
	// Import CSS directly - Vite will handle it properly
	import 'xterm/css/xterm.css';

	// Props
	const { 
		session,
		class: className = '',
		hasActiveProject = false,
		projectPath = '',
		isExecuting = false,
		onExecuteCommand,
		onClearSession
	}: XTermProps = $props();

	// Track local execution state for this session
	let sessionExecuting = $state(false);
	let lastExecutingState = $state(false);

	// Local state
	let terminalContainer = $state<HTMLDivElement>();
	const xtermService = new XTermService();
	let lastProcessedIndex = $state(-1);
	let isInitialized = $state(false); // Reactive state for initialization
	const initialPromptShown = $state(false); // Track if initial prompt has been shown
	let isTerminalReady = $state(false); // Track if terminal is ready for input
	let isAfterClearOperation = $state(false); // Track if session was manually cleared
	let lastSessionId = $state(''); // Track last session to detect changes
	let promptShownForSession = $state(false); // Track if prompt shown for current session
	let justRestoredFromBuffer = $state(false); // Track if we just restored from buffer
	let isInitialMount = $state(true); // Track if this is the initial mount after restore
	let initRetryCount = $state(0); // Retry counter for initialization failures
	const MAX_INIT_RETRIES = 5; // Max retry attempts
	const keyboardEventHandler: ((e: KeyboardEvent) => void) | null = null; // Store event handler reference

	// Track which sessions have connected to PTY in this browser session (after refresh)
	// This prevents reconnection issues after browser refresh
	const connectedSessions = new Set<string>();
	
	// Initialize terminal
	async function initializeTerminal() {
		if (!terminalContainer) {
			return;
		}

		await xtermService.initialize(terminalContainer);

		if (xtermService.isInitialized && session) {
			// CRITICAL: Mark session as connected BEFORE setting isInitialized
			// This prevents the session change $effect from triggering a duplicate connection
			// because $effect checks connectedSessions.has(session.id)
			if (hasActiveProject && onExecuteCommand) {
				connectedSessions.add(session.id);
			}

			// Update reactive state AFTER marking connected
			isInitialized = xtermService.isInitialized;

			// Setup input handling - forwards all keystrokes to PTY
			xtermService.setupInput(
				session.id,
				onExecuteCommand,
				onClearSession,
				hasActiveProject,
				projectPath,
				session?.directory
			);

			// Focus terminal for immediate input
			xtermService.terminal?.focus();

			// Process existing session data first - but ONLY if not initial mount
			// On initial mount after restore, lines will be rendered by restoreSessionBuffer
			if (session && !isInitialMount) {
				processSessionLines();
			}

			// Mark terminal as ready immediately - shell handles prompts
			isTerminalReady = true;

			// CRITICAL: Auto-connect to PTY session right after initialization
			// This opens the SSE stream to persistent PTY
			if (hasActiveProject && onExecuteCommand && session) {
				// IMPORTANT: Get actual terminal dimensions and pass to PTY
				// This ensures PTY is created with correct size to prevent cursor positioning issues
				let terminalSize: { cols: number; rows: number } | undefined;
				if (xtermService.fitAddon && xtermService.terminal) {
					// First fit to get proper dimensions
					xtermService.fitAddon.fit();
					const dims = xtermService.fitAddon.proposeDimensions();
					if (dims) {
						terminalSize = { cols: dims.cols, rows: dims.rows };
					}
				}

				onExecuteCommand('', terminalSize).catch(() => {
					// Silently handle connection errors
				});
			}
		} else {
			// Update reactive state even if not fully initialized
			isInitialized = xtermService.isInitialized;
		}
	}

	// Process session lines and render to terminal
	function processSessionLines() {
		if (!isInitialized || !session) return;

		const lines = session.lines;
		const startIndex = Math.max(0, lastProcessedIndex + 1);
		const totalLines = sessionLinesLength;
		
		
		// Process new lines since last update
		for (let i = startIndex; i < totalLines; i++) {
			const line = lines[i];
			
			// Track when command starts (input line detected)
			if (line.type === 'input') {
				sessionExecuting = true;
			}
			
			// Track when command finishes (prompt-trigger detected)
			if (line.type === 'prompt-trigger') {
				// Only set to false if we were executing
				if (sessionExecuting) {
					sessionExecuting = false;
					// IMPORTANT: Also update xterm service execution state
					// This ensures prompt can be displayed properly
					xtermService.setExecuting(false);
				}
			}
			
			xtermService.renderLine(line);
		}

		lastProcessedIndex = totalLines - 1;

		// Auto scroll to bottom only if user is near the bottom
		// This prevents disrupting user's reading when they scroll up
		requestAnimationFrame(() => {
			xtermService.scrollToBottomIfNearEnd();
		});
	}

	// Handle resize events
	function setupResizeHandling() {
		const handleResize = () => {
			setTimeout(() => {
				xtermService.fit(session?.id);
			}, 100);
		};

		window.addEventListener('resize', handleResize);
		
		// Also fit when container size might change
		const resizeObserver = new ResizeObserver(() => {
			handleResize();
		});
		
		if (terminalContainer) {
			resizeObserver.observe(terminalContainer);
		}

		return () => {
			window.removeEventListener('resize', handleResize);
			resizeObserver.disconnect();
		};
	}

	// Handle right-click copy/paste functionality
	function setupRightClickCopy() {
		if (!terminalContainer || !xtermService.terminal) return;

		const handleRightClick = async (event: MouseEvent) => {
			event.preventDefault(); // Prevent default context menu
			
			// Get selected text from xterm.js
			const selectedText = xtermService.getSelectedText();
			
			if (selectedText && selectedText.trim()) {
				// Copy selected text to clipboard
				try {
					await navigator.clipboard.writeText(selectedText);
					
					// Clear selection after copy (like most terminals do)
					xtermService.clearSelection();
					
					// Show brief visual feedback
					showCopyFeedback();
				} catch (err) {
				}
			} else {
				// No text selected - paste from clipboard instead
				try {
					const clipboardText = await navigator.clipboard.readText();
					if (clipboardText && clipboardText.trim() && xtermService.isReady) {
						
						// Use terminal's built-in paste functionality
						// This simulates typing each character through the input handler
						if ((xtermService as any).inputHandler) {
							// Process each character through the input handler
							for (const char of clipboardText) {
								// Skip newlines - let user decide when to execute
								if (char !== '\n' && char !== '\r') {
									(xtermService as any).inputHandler(char);
								}
							}
						}
						
						// Show brief visual feedback
						showPasteFeedback();
					}
				} catch {
					// paste not supported
				}
			}
		};

		// Add right-click event listener to terminal container
		terminalContainer.addEventListener('contextmenu', handleRightClick);
		
		return () => {
			terminalContainer?.removeEventListener('contextmenu', handleRightClick);
		};
	}

	// Show brief visual feedback for copy action
	function showCopyFeedback() {
		if (!terminalContainer) return;
		
		// Create temporary feedback element
		const feedback = document.createElement('div');
		feedback.textContent = 'Copied!';
		feedback.style.cssText = `
			position: absolute;
			top: 10px;
			right: 10px;
			background: rgb(34 197 94 / 0.9);
			color: white;
			padding: 4px 8px;
			border-radius: 4px;
			font-size: 12px;
			font-family: system-ui, sans-serif;
			z-index: 1000;
			pointer-events: none;
		`;
		
		terminalContainer.style.position = 'relative';
		terminalContainer.appendChild(feedback);
		
		// Remove feedback after 1 second
		setTimeout(() => {
			if (feedback.parentNode) {
				feedback.parentNode.removeChild(feedback);
			}
		}, 1000);
	}

	// Show brief visual feedback for paste action
	function showPasteFeedback() {
		if (!terminalContainer) return;
		
		// Create temporary feedback element
		const feedback = document.createElement('div');
		feedback.textContent = 'Pasted!';
		feedback.style.cssText = `
			position: absolute;
			top: 10px;
			right: 10px;
			background: rgba(59, 130, 246, 0.9);
			color: white;
			padding: 4px 8px;
			border-radius: 4px;
			font-size: 12px;
			font-family: system-ui, sans-serif;
			z-index: 1000;
			pointer-events: none;
		`;
		
		terminalContainer.style.position = 'relative';
		terminalContainer.appendChild(feedback);
		
		// Remove feedback after 1 second
		setTimeout(() => {
			if (feedback.parentNode) {
				feedback.parentNode.removeChild(feedback);
			}
		}, 1000);
	}

	// Handle theme changes
	function setupThemeHandling() {
		xtermService.updateTheme();
		
		// Watch for theme changes
		const observer = new MutationObserver(() => {
			xtermService.updateTheme();
		});
		
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['class', 'data-theme']
		});

		return () => {
			observer.disconnect();
		};
	}

	// Reactive effects
	$effect(() => {
		// Initialize terminal when container is available
		// Track initRetryCount to enable retry on failure
		const currentRetry = initRetryCount;

		if (terminalContainer && !isInitialized) {
			// First attempt: short delay for DOM readiness
			// Retries: longer delay to allow layout/resize to settle
			const delay = currentRetry === 0 ? 10 : 500;
			const timeoutId = setTimeout(async () => {
				await initializeTerminal();

				// If still not initialized, schedule a retry
				if (!xtermService.isInitialized && currentRetry < MAX_INIT_RETRIES) {
					initRetryCount = currentRetry + 1;
				}
			}, delay);

			return () => clearTimeout(timeoutId);
		}
	});

	// Use $derived.by to properly track session.lines changes in Svelte 5
	const sessionLinesLength = $derived.by(() => {
		const length = session ? session.lines.length : 0;
		return length;
	});

	$effect(() => {
		// Process new session data when lines length changes
		// Skip if we just restored from buffer to avoid duplicates
		// Also skip if this is a session switch (lastSessionId !== session.id)
		if (isInitialized && session && !justRestoredFromBuffer && lastSessionId === session.id) {
			// Check if this is a clear operation (lines reduced and contains clear-screen marker)
			const hasClearMarker = session.lines.length > 0 && 
				session.lines[session.lines.length - 1].type === 'clear-screen';
			
			if (hasClearMarker && sessionLinesLength < lastProcessedIndex) {
				// This is a clear operation - handle it immediately
				xtermService.clear();
				lastProcessedIndex = -1;
				
				// Process the clear marker
				processSessionLines();
			} else if (sessionLinesLength > lastProcessedIndex) {
				// Normal case: process NEW lines
				processSessionLines();
			}
		}
	});

	// Track session execution state changes
	$effect(() => {
		// Check if execution state changed from true to false (command finished)
		// Also verify that terminal store agrees that execution is done
		if (session && lastExecutingState && !sessionExecuting && !isExecuting) {
			// Command just finished for this session

			// Trigger prompt display for this session regardless of whether it's active
			if (isInitialized && hasActiveProject) {
				setTimeout(() => {
					// Check if there's still an active stream before showing prompt
					// This prevents race condition after refresh where execution state changes
					// but stream is still being reconnected
					if (!backgroundTerminalService.hasActiveStream(session.id)) {
						xtermService.showPrompt();
						isTerminalReady = true;
					}
				}, 200);
			}
		}
		
		// Update last state for next comparison
		lastExecutingState = sessionExecuting;
	});

	// Save terminal buffer before switching away
	function saveCurrentBuffer(sessionId: string) {
		// No longer saving buffer since we re-render from session lines
		// This preserves ANSI colors when switching tabs
	}
	
	// Restore terminal buffer when switching to a session
	function restoreSessionBuffer(sessionId: string) {
		if (!isInitialized || !sessionId) return;
		
		
		// ALWAYS re-render from session lines to preserve ANSI colors
		// This ensures colors are preserved when switching tabs
		
		// Clear terminal first
		xtermService.clear();
		
		// Don't set the flag here - it's already set in the session change handler
		// justRestoredFromBuffer = true;
		
		// Reset processed index to re-render all lines
		lastProcessedIndex = -1;
		
		// Re-render all lines from the session (with ANSI colors intact)
		if (session && session.lines.length > 0) {
			// Check if the session was cleared (has clear-screen marker)
			const hasClearMarker = session.lines.some(line => line.type === 'clear-screen');
			
			if (hasClearMarker) {
				// Find the last clear-screen marker
				let lastClearIndex = -1;
				for (let i = session.lines.length - 1; i >= 0; i--) {
					if (session.lines[i].type === 'clear-screen') {
						lastClearIndex = i;
						break;
					}
				}
				
				// Only render lines after the last clear
				// This ensures the terminal stays clear when switching tabs
				for (let i = lastClearIndex; i < session.lines.length; i++) {
					const line = session.lines[i];
					
					// Track execution state while re-rendering
					if (line.type === 'input') {
						sessionExecuting = true;
					}
					if (line.type === 'prompt-trigger') {
						sessionExecuting = false;
						// Update xterm service execution state for proper prompt display
						xtermService.setExecuting(false);
					}
					
					// Render line with original ANSI codes preserved
					// Pass isRestoring=true to properly handle input lines
					xtermService.renderLine(line, true);
				}
				
				// After restoring, reset execution state for proper prompt display
				sessionExecuting = false;
				xtermService.setExecuting(false);
			} else {
				// No clear marker - render all lines as before
				for (let i = 0; i < session.lines.length; i++) {
					const line = session.lines[i];
					
					// Track execution state while re-rendering
					if (line.type === 'input') {
						sessionExecuting = true;
					}
					if (line.type === 'prompt-trigger') {
						sessionExecuting = false;
						// Update xterm service execution state for proper prompt display
						xtermService.setExecuting(false);
					}
					
					// Render line with original ANSI codes preserved
					// Pass isRestoring=true to properly handle input lines
					xtermService.renderLine(line, true);
				}
			}
			
			// After restoring all lines, ensure execution state is correct
			// If the last line wasn't a prompt-trigger, reset execution state
			// This ensures directory path is always shown for input lines during restore
			sessionExecuting = false;
			xtermService.setExecuting(false);
			
			// Update last processed index to current length
			lastProcessedIndex = session.lines.length - 1;
			
			// Only scroll to bottom if there's content after clear
			// If it was just cleared, keep at top
			if (!hasClearMarker || session.lines.length > 1) {
				requestAnimationFrame(() => {
					xtermService.scrollToBottom();
				});
			}
		}
		
		// Reset flag after rendering is complete
		// Use longer timeout to ensure effect doesn't trigger during restoration
		setTimeout(() => {
			justRestoredFromBuffer = false;
		}, 200);
	}
	
	$effect(() => {
		// Handle session changes
		if (isInitialized && session) {
			// Check if session ID changed
			if (lastSessionId !== session.id) {
				// Save buffer for previous session before switching
				if (lastSessionId) {
					saveCurrentBuffer(lastSessionId);
				}

				// Set flag BEFORE updating lastSessionId to prevent double processing
				justRestoredFromBuffer = true;
				
				lastSessionId = session.id;
				promptShownForSession = false; // Reset prompt flag for new session
				isAfterClearOperation = false;
				sessionExecuting = false; // Reset execution state for new session
				lastExecutingState = false; // Reset last state tracking
				
				// Update command history for the new session
				xtermService.updateCommandHistory(session.commandHistory);
				
				// IMPORTANT: Update context with new session directory BEFORE restore
				// This ensures sessionDirectory is correct when restoring input lines
				xtermService.updateContext(hasActiveProject, projectPath, session.directory);
				// Set session ID for active stream checking
				xtermService.setSessionId(session.id);
				
				// Restore terminal buffer for the new session
				// This will also update lastProcessedIndex
				restoreSessionBuffer(session.id);
				
				// Mark initial mount as complete after first restore
				if (isInitialMount) {
					setTimeout(() => {
						isInitialMount = false;
					}, 500); // Give enough time for restoration to complete
				}

				// CRITICAL: Auto-connect to PTY for session that hasn't connected yet
				// This ensures PTY session is created on server for:
				// 1. New tabs (session.lines.length === 0)
				// 2. Restored sessions after browser refresh that haven't connected yet
				const hasNotConnected = !connectedSessions.has(session.id);
				if (hasNotConnected && hasActiveProject && onExecuteCommand) {
					// Session hasn't connected to PTY yet - create connection
					connectedSessions.add(session.id);
					setTimeout(() => {
						// Get terminal dimensions for PTY size sync
						let terminalSize: { cols: number; rows: number } | undefined;
						if (xtermService.fitAddon && xtermService.terminal) {
							xtermService.fitAddon.fit();
							const dims = xtermService.fitAddon.proposeDimensions();
							if (dims) {
								terminalSize = { cols: dims.cols, rows: dims.rows };
							}
						}
						onExecuteCommand('', terminalSize).catch(() => {
							// Silently handle connection errors
						});
					}, 200); // Small delay to ensure session is ready
				}

				// Check if we need to show prompt after restore
				// Also check isExecuting prop from terminal store to avoid showing prompt during active execution
				if (!sessionExecuting && !isExecuting) {
					// IMPORTANT: Add delay to allow stream reconnection to complete
					// This prevents prompt from appearing before reconnected output
					setTimeout(() => {
						// Check again if there's an active stream after the delay
						const hasActiveStream = session ? backgroundTerminalService.hasActiveStream(session.id) : false;
						if (!hasActiveStream) {
							if (session.lines.length > 0) {
								// Session has history - check if we need prompt
								const lastLine = session.lines[session.lines.length - 1];
								if (lastLine.type === 'prompt-trigger' || lastLine.type === 'output') {
									xtermService.showPrompt();
									isTerminalReady = true;
								}
							} else {
								// Empty session - show prompt immediately
								// (prompt will be displayed before PTY connection completes)
								xtermService.showPrompt();
								isTerminalReady = true;
							}
						} else {
							// Active stream detected, mark as ready without prompt
							isTerminalReady = true;
						}
					}, 500); // Delay to ensure stream reconnection completes
				}
			} else if (lastProcessedIndex >= sessionLinesLength && sessionLinesLength === 0) {
				// Only clear if lines were actually removed (shouldn't happen anymore)
				// With new approach, clear command adds a clear-screen marker instead
				isAfterClearOperation = true;
				xtermService.clear();
				lastProcessedIndex = -1;
			}
		}
	});

	$effect(() => {
		// Handle execution state changes and context updates
		if (isInitialized) {
			// Update context whenever props change
			xtermService.updateContext(hasActiveProject, projectPath, session?.directory);
			// Update session ID for active stream checking
			if (session) {
				xtermService.setSessionId(session.id);
			}
			// Use session-specific execution state instead of global
			xtermService.setExecuting(sessionExecuting);
			
			// Update ready state only if becoming ready (don't go back to false during execution)
			// This prevents DOM blocking from re-activating during normal operation
			const serviceReady = xtermService.isReady;
			const serviceInit = xtermService.isInitialized;

			if (serviceReady) {
				isTerminalReady = true;
			}
			// Only set to false if terminal is genuinely not initialized
			else if (!serviceInit) {
				isTerminalReady = false;
			}
		}
	});

	// Update command history whenever it changes
	$effect(() => {
		if (isInitialized && session?.commandHistory) {
			xtermService.updateCommandHistory(session.commandHistory);
		}
	});

	// Setup event handlers
	$effect(() => {
		if (!isInitialized) return;

		const cleanupResize = setupResizeHandling();
		const cleanupTheme = setupThemeHandling();
		const cleanupRightClick = setupRightClickCopy();

		return () => {
			cleanupResize();
			cleanupTheme();
			cleanupRightClick?.();
		};
	});

	// Cleanup on destroy
	onDestroy(() => {
		// Remove keyboard event listener (must match capture phase)
		if (keyboardEventHandler && xtermService.terminal?.element) {
			xtermService.terminal.element.removeEventListener('keydown', keyboardEventHandler, true);
		}

		// CRITICAL: Clean up terminal service WebSocket listeners for the current session
		// This prevents stale listeners from accumulating when XTerm is destroyed
		// during project switches, which would cause duplicate output processing
		if (lastSessionId) {
			terminalService.cleanupListeners(lastSessionId);
		}

		xtermService.dispose();
	});

	// Expose methods for parent component (implementing XTermMethods)
	export function clear() {
		xtermService.clear();
		lastProcessedIndex = -1;
	}

	export function fit() {
		xtermService.fit(session?.id);
	}

	export function scrollToBottom() {
		xtermService.scrollToBottom();
	}

	export function scrollToBottomIfNearEnd() {
		xtermService.scrollToBottomIfNearEnd();
	}

	export function writeData(data: string) {
		xtermService.writeData(data);
	}

	export function getSelectedText(): string {
		return xtermService.getSelectedText();
	}

	export function clearSelection() {
		xtermService.clearSelection();
	}
</script>

<!-- Pure xterm.js terminal container -->
<div
	bind:this={terminalContainer}
	class="w-full h-full overflow-hidden bg-slate-50 dark:bg-slate-900/70 {className} select-none"
	style="transition: opacity 0.2s ease-in-out; user-select: text;"
	role="textbox"
	tabindex="0"
	aria-label="Interactive terminal"
	title="Right-click selected text to copy"
>
	{#if !browser}
		<!-- SSR fallback -->
		<div class="flex items-center justify-center h-full">
			<div class="text-slate-600 dark:text-slate-400 text-sm">
				Loading terminal...
			</div>
		</div>
	{:else if !isInitialized}
		<!-- Browser loading state -->
		<div class="flex items-center justify-center h-full">
			<div class="text-slate-600 dark:text-slate-400 text-sm">
				Initializing terminal...
			</div>
		</div>
	{/if}
</div>

<style>
	/* Custom xterm.js styling */
	:global(.xterm) {
		padding: 0.5rem !important;
		background: transparent !important;
		height: 100% !important;
	}

	:global(.xterm .xterm-viewport) {
		background: transparent !important;
		height: 100% !important;
	}

	:global(.xterm .xterm-screen) {
		background: transparent !important;
		height: 100% !important;
	}

	:global(.xterm .xterm-helper-textarea) {
		height: 100% !important;
	}

	/* Text selection styling */
	:global(.xterm .xterm-selection div) {
		background-color: #22c55e !important; /* green-500 */
		opacity: 0.3 !important;
	}

	/* Better text selection on dark theme */
	:global(.dark .xterm .xterm-selection div) {
		background-color: #4ade80 !important; /* green-400 */
		opacity: 0.4 !important;
	}

	/* Scrollbar styling to match application theme */
	:global(.xterm .xterm-viewport::-webkit-scrollbar) {
		width: 6px;
	}

	:global(.xterm .xterm-viewport::-webkit-scrollbar-track) {
		background: transparent;
	}

	:global(.xterm .xterm-viewport::-webkit-scrollbar-thumb) {
		background-color: rgb(148 163 184 / 0.3); /* slate-400 with opacity */
		border-radius: 3px;
		transition: background-color 0.2s ease;
	}

	:global(.dark .xterm .xterm-viewport::-webkit-scrollbar-thumb) {
		background-color: rgb(71 85 105 / 0.3); /* slate-600 with opacity */
	}

	:global(.xterm .xterm-viewport::-webkit-scrollbar-thumb:hover) {
		background-color: rgb(148 163 184 / 0.6); /* slate-400 with higher opacity */
	}

	:global(.dark .xterm .xterm-viewport::-webkit-scrollbar-thumb:hover) {
		background-color: rgb(71 85 105 / 0.6); /* slate-600 with higher opacity */
	}

	/* Ensure proper focus styling */
	:global(.xterm.focus .xterm-cursor) {
		background-color: #22c55e !important; /* green-500 */
	}

	:global(.xterm:not(.focus) .xterm-cursor) {
		background-color: #52525b !important; /* zinc-600 */
	}

	/* Responsive font size adjustments */
	@media (max-width: 640px) {
		:global(.xterm) {
			font-size: 12px !important;
		}
	}
</style>