/**
 * Terminal and command execution types
 */

export interface TerminalLine {
	id?: string;
	content: string;
	type: 'input' | 'output' | 'error' | 'warning' | 'success' | 'info' | 'exit' | 'prompt-trigger' | 'clear-screen' | 'system';
	timestamp: Date;
	directory?: string; // Directory context when this line was created (for input commands)
}

export interface TerminalCommand {
	id: string;
	command: string;
	description?: string;
	timestamp: Date;
	duration?: number;
	exitCode?: number;
	directory?: string;
	output?: string;
}

export interface TerminalBuffer {
	lines: string[];
	cursorY: number;
	cursorX: number;
	viewportY: number;
}

export interface TerminalSession {
	id: string;
	name: string;
	directory: string;
	lines: TerminalLine[];
	commandHistory: string[];
	isActive: boolean;
	createdAt: Date;
	lastUsedAt: Date;
	shellType?: string; // Terminal type: PowerShell, Bash, etc.
	terminalBuffer?: TerminalBuffer; // Store terminal buffer state
	projectId?: string; // Associated project ID for multi-project support
	projectPath?: string; // Associated project path
}