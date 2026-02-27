/**
 * Terminal Configuration
 * 
 * Centralized xterm.js configuration and utilities
 */

import type { ITerminalOptions } from 'xterm';

// Terminal theme configuration
export const terminalConfig: ITerminalOptions = {
	theme: {
		background: 'transparent', // Let CSS handle background
		foreground: '#e4e4e7', // zinc-200
		cursor: '#22c55e', // green-500
		cursorAccent: '#166534', // green-800
		selectionBackground: '#22c55e40', // green-500 with opacity
		black: '#18181b', // zinc-900
		red: '#ef4444', // red-500
		green: '#22c55e', // green-500
		yellow: '#eab308', // yellow-500
		blue: '#60a5fa', // blue-400 - brighter blue
		magenta: '#a855f7', // purple-500
		cyan: '#06b6d4', // cyan-500
		white: '#f4f4f5', // zinc-100
		brightBlack: '#52525b', // zinc-600
		brightRed: '#f87171', // red-400
		brightGreen: '#4ade80', // green-400
		brightYellow: '#facc15', // yellow-400
		brightBlue: '#60a5fa', // blue-400
		brightMagenta: '#c084fc', // purple-400
		brightCyan: '#22d3ee', // cyan-400
		brightWhite: '#ffffff'
	},
	fontSize: 12,
	fontFamily: 'JetBrains Mono, Monaco, "Cascadia Code", "Roboto Mono", Consolas, "Courier New", monospace',
	lineHeight: 1,
	letterSpacing: 0,
	cursorBlink: true,
	cursorStyle: 'block' as const,
	convertEol: true,
	scrollback: 1000,
	tabStopWidth: 4,
	allowProposedApi: false,
	altClickMovesCursor: true,
	disableStdin: false, // ✅ ENABLED for interactive PTY mode - stdin forwards to backend
	allowTransparency: false
};

/**
 * Format directory path for display
 */
export function formatDirectory(dir: string): string {
	if (!dir || typeof dir !== 'string') return '~';
	
	// Convert backslashes to forward slashes for consistent display
	const normalizedDir = dir.replace(/\\/g, '/');
	
	// For long paths, shorten them
	const maxLength = 50;
	if (normalizedDir.length > maxLength) {
		const parts = normalizedDir.split('/');
		if (parts.length > 3) {
			return parts[0] + '/.../' + parts.slice(-1).join('/');
		}
	}
	
	return normalizedDir;
}