/**
 * XTerm Service - Interactive PTY Mode
 *
 * Simple pass-through service: forwards all keystrokes to PTY, displays all output from PTY
 * No command parsing, no prompt handling - everything handled by shell
 */

import { browser } from '$frontend/lib/app-environment';
import type { Terminal } from 'xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { WebLinksAddon } from '@xterm/addon-web-links';
import type { TerminalLine } from '$shared/types/terminal';
import { terminalConfig } from './terminal-config';
import { debug } from '$shared/utils/logger';
import ws from '$frontend/lib/utils/ws';

export class XTermService {
	public terminal: Terminal | null = null;
	public fitAddon: FitAddon | null = null;
	public webLinksAddon: WebLinksAddon | null = null;
	public isInitialized = false;
	public isReady = false;

	private sessionId: string | null = null;
	private resizeTimeout: ReturnType<typeof setTimeout> | null = null;
	private inputDisposable: any = null;

	constructor() {
		// Service is stateless by design
	}

	/**
	 * Initialize terminal with async imports
	 */
	async initialize(container: HTMLDivElement): Promise<void> {
		if (!browser || !container) {
			return;
		}

		// Already initialized
		if (this.isInitialized) {
			return;
		}

		// Clean up partial initialization if terminal exists but isn't initialized
		// This can happen if a previous attempt failed after terminal.open() but before isInitialized was set
		if (this.terminal) {
			try { this.terminal.dispose(); } catch { /* ignore */ }
			this.terminal = null;
			this.fitAddon = null;
			this.webLinksAddon = null;
		}

		try {
			debug.log('terminal', '🚀 Initializing XTerm...');

			// Dynamic import xterm classes
			const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
				import('xterm'),
				import('@xterm/addon-fit'),
				import('@xterm/addon-web-links')
			]);

			// Create terminal instance
			this.terminal = new Terminal(terminalConfig);

			// Create and load addons
			this.fitAddon = new FitAddon();
			this.webLinksAddon = new WebLinksAddon();

			this.terminal.loadAddon(this.fitAddon);
			this.terminal.loadAddon(this.webLinksAddon);

			// Open terminal in container
			this.terminal.open(container);

			// Fit terminal to container - non-fatal if container has zero dimensions
			// Will be retried automatically on resize
			try {
				this.fitAddon.fit();
			} catch {
				debug.log('terminal', '⚠️ Initial fit failed (container may have zero dimensions), will retry on resize');
			}

			this.isInitialized = true;
			this.isReady = true;

			debug.log('terminal', '✅ XTerm initialized successfully');
		} catch (error) {
			// Clean up on failure to allow retry
			if (this.terminal) {
				try { this.terminal.dispose(); } catch { /* ignore */ }
				this.terminal = null;
			}
			this.fitAddon = null;
			this.webLinksAddon = null;
			debug.error('terminal', '❌ Failed to initialize XTerm:', error);
		}
	}

	/**
	 * Setup terminal input handling - forwards all keystrokes to PTY
	 */
	setupInput(
		sessionId: string,
		onExecuteCommand?: (command: string, terminalSize?: { cols: number; rows: number }) => Promise<void>,
		onClearSession?: () => void,
		hasActiveProject?: boolean,
		projectPath?: string,
		sessionDirectory?: string
	): void {
		if (!this.terminal) {
			debug.error('terminal', '❌ Cannot setup input: terminal not initialized');
			return;
		}

		this.sessionId = sessionId;

		// Remove existing input handler if any
		if (this.inputDisposable) {
			this.inputDisposable.dispose();
		}

		debug.log('terminal', `⌨️  Setting up input forwarding for session: ${sessionId}`);

		// Attach input handler that forwards ALL keystrokes to PTY via WebSocket
		this.inputDisposable = this.terminal.onData((data: string) => {
			if (!this.sessionId) {
				debug.error('terminal', '❌ No session ID set for input forwarding');
				return;
			}

			// Send keystroke directly to PTY via WebSocket (fire and forget for better performance)
			try {
				ws.emit('terminal:input', {
					sessionId: this.sessionId,
					data: data
				});
			} catch (error) {
				debug.error('terminal', '❌ Error sending input to PTY via WebSocket:', error);
			}
		});

		debug.log('terminal', '✅ Input forwarding setup complete');
	}

	/**
	 * Set session ID for input forwarding
	 */
	setSessionId(sessionId: string): void {
		this.sessionId = sessionId;
	}

	/**
	 * Update context (compatibility method - not needed in interactive mode)
	 */
	updateContext(hasActiveProject: boolean, projectPath: string, sessionDirectory?: string): void {
		// No-op in interactive mode - shell handles prompts
	}

	/**
	 * Update command history (compatibility method - not needed in interactive mode)
	 */
	updateCommandHistory(history: string[]): void {
		// No-op in interactive mode - shell handles history
	}

	/**
	 * Set user input callback (compatibility method)
	 */
	setUserInputCallback(callback: () => void): void {
		// No-op in interactive mode
	}

	/**
	 * Set executing state (compatibility method)
	 */
	setExecuting(isExecuting: boolean): void {
		// No-op in interactive mode
	}

	/**
	 * Show prompt (compatibility method - not needed in interactive mode)
	 */
	showPrompt(): void {
		// No-op in interactive mode - shell handles prompts
	}

	/**
	 * Render a terminal line from session data
	 */
	renderLine(line: TerminalLine, isRestoring = false): void {
		if (!this.terminal) return;

		switch (line.type) {
			case 'output':
			case 'error':
			case 'input':
				// Write raw content directly - preserves ANSI colors
				if (line.content) {
					this.terminal.write(line.content);
				}
				break;

			case 'prompt-trigger':
				// Ignore - shell handles prompts
				break;

			case 'clear-screen':
				this.clear();
				break;

			default:
				if (line.content) {
					this.terminal.write(line.content);
				}
		}
	}

	/**
	 * Write raw data to terminal
	 */
	writeData(data: string): void {
		if (!this.terminal) return;
		this.terminal.write(data);
	}

	/**
	 * Clear terminal display
	 */
	clear(): void {
		if (!this.terminal) return;
		this.terminal.clear();
	}

	/**
	 * Fit terminal to container size
	 */
	fit(sessionId?: string): void {
		if (!this.fitAddon || !this.terminal) return;

		// Clear existing timeout
		if (this.resizeTimeout) {
			clearTimeout(this.resizeTimeout);
		}

		// Debounce resize operations
		this.resizeTimeout = setTimeout(() => {
			if (!this.fitAddon || !this.terminal) return;

			try {
				this.fitAddon.fit();
				const dims = this.fitAddon.proposeDimensions();

				if (dims && sessionId) {
					// Notify backend of new terminal size via WebSocket HTTP
					debug.log('terminal', `🔧 Syncing terminal size: ${dims.cols}x${dims.rows}`);
					ws.http('terminal:resize', {
						sessionId,
						cols: dims.cols,
						rows: dims.rows
					}).catch((err) => {
						debug.error('terminal', 'Failed to resize terminal:', err);
					});
				}
			} catch (error) {
				debug.error('terminal', 'Error fitting terminal:', error);
			}
		}, 100);
	}

	/**
	 * Scroll to bottom of terminal
	 */
	async scrollToBottom(): Promise<void> {
		if (!this.terminal) return;
		await new Promise(resolve => setTimeout(resolve, 100));
		this.terminal.scrollToBottom();
	}

	/**
	 * Scroll to bottom only if user is near the end
	 */
	scrollToBottomIfNearEnd(): void {
		if (!this.terminal) return;

		const viewport = (this.terminal as any)._core?.viewport;
		if (!viewport) {
			this.scrollToBottom();
			return;
		}

		const scrollTop = viewport._viewportElement.scrollTop;
		const scrollHeight = viewport._viewportElement.scrollHeight;
		const clientHeight = viewport._viewportElement.clientHeight;

		// If within 3 lines of bottom, scroll to bottom
		const threshold = this.terminal.rows * 3;
		if (scrollHeight - scrollTop - clientHeight < threshold) {
			this.scrollToBottom();
		}
	}

	/**
	 * Get selected text
	 */
	getSelectedText(): string {
		if (!this.terminal) return '';
		return this.terminal.getSelection();
	}

	/**
	 * Clear selection
	 */
	clearSelection(): void {
		if (!this.terminal) return;
		this.terminal.clearSelection();
	}

	/**
	 * Update terminal theme based on dark/light mode
	 */
	updateTheme(): void {
		if (!this.terminal) return;

		const isDark = document.documentElement.classList.contains('dark');

		this.terminal.options.theme = {
			background: isDark ? 'rgba(15, 23, 42, 0.7)' : '#f8fafc', // slate-900/70 : slate-50
			foreground: isDark ? '#e2e8f0' : '#1e293b', // slate-200 : slate-800
			cursor: '#22c55e', // green-500
			cursorAccent: isDark ? 'rgba(15, 23, 42, 0.7)' : '#f8fafc',
			selectionBackground: isDark ? '#4ade8080' : '#22c55e80', // green-400 : green-500 with opacity
			selectionForeground: undefined,
			// Improved color visibility for both modes
			black: isDark ? '#334155' : '#1e293b', // slate-700 : slate-800
			red: isDark ? '#f87171' : '#dc2626', // red-400 : red-600
			green: isDark ? '#4ade80' : '#16a34a', // green-400 : green-600
			yellow: isDark ? '#fde047' : '#ca8a04', // yellow-300 : yellow-600
			blue: isDark ? '#60a5fa' : '#2563eb', // blue-400 : blue-600
			magenta: isDark ? '#c084fc' : '#9333ea', // purple-400 : purple-600
			cyan: isDark ? '#22d3ee' : '#0891b2', // cyan-400 : cyan-600
			white: isDark ? '#e2e8f0' : '#475569', // slate-200 : slate-600
			brightBlack: isDark ? '#64748b' : '#64748b', // slate-500 : slate-500
			brightRed: isDark ? '#fca5a5' : '#ef4444', // red-300 : red-500
			brightGreen: isDark ? '#86efac' : '#22c55e', // green-300 : green-500
			brightYellow: isDark ? '#fef08a' : '#eab308', // yellow-200 : yellow-500
			brightBlue: isDark ? '#93c5fd' : '#3b82f6', // blue-300 : blue-500
			brightMagenta: isDark ? '#d8b4fe' : '#a855f7', // purple-300 : purple-500
			brightCyan: isDark ? '#67e8f9' : '#06b6d4', // cyan-300 : cyan-500
			brightWhite: isDark ? '#f1f5f9' : '#1e293b' // slate-100 : slate-800
		};
	}

	/**
	 * Cleanup terminal resources
	 */
	dispose(): void {
		debug.log('terminal', '🧹 Disposing XTerm service');

		if (this.inputDisposable) {
			this.inputDisposable.dispose();
		}

		if (this.resizeTimeout) {
			clearTimeout(this.resizeTimeout);
		}

		if (this.terminal) {
			this.terminal.dispose();
			this.terminal = null;
		}

		this.fitAddon = null;
		this.webLinksAddon = null;
		this.isInitialized = false;
		this.isReady = false;
	}
}
